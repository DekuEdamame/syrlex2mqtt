#!/usr/bin/env node
// SPDX-License-Identifier: MIT
"use strict";

const mqtt = require("async-mqtt");
const fs = require('fs');
const express = require('express');
const xml = require('xml2js');
const https = require('https')
const http = require('http')

// mqtt configuration
const brokerUrl = process.env.MQTT_SERVER;
const username = process.env.MQTT_USER;
const password = process.env.MQTT_PASSWORD;
const verboseLogging = (process.env.VERBOSE_LOGGING == "1");

// syr connect configuration
const syrHttpPort = 80;
const syrHttpsPort = 443;

// https certificates
var key = fs.readFileSync(__dirname + '/server.key');
var cert = fs.readFileSync(__dirname + '/server.cert');

var credentials = {
  key: key,
  cert: cert,
};

const xmlStart = '<?xml version="1.0" encoding="utf-8"?><sc version="1.0"><d>';
const xmlEnd = '</d></sc>';
const basicC = ["getSRN", "getVER", "getFIR", "getTYP", "getCNA", "getIPA"];
const allC = [ "getSRN", "getVER", "getFIR", "getTYP", "getCNA", "getIPA",
               "getSV1", "getRPD", "getFLO", "getLAR", "getTOR", "getRG1", "getCS1", "getRES", "getSS1", "getSV1", "getSTA", "getCOF"];

var httpServer;
var httpsServer;

var devicesMap = new Map();

function logInfo(msg) {
	console.log("[" + new Date().toISOString() + "] " + msg);
}

function logVerbose(msg) {
  if(verboseLogging) {
	  console.log("[" + new Date().toISOString() + "] " + msg);
  }
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp*1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const offsetHours = String(Math.floor(offset / 60)).padStart(2, "0");
  const offsetMinutes = String(offset % 60).padStart(2, "0");
  const offsetStr = `${offset >= 0 ? "+" : "-"}${offsetHours}:${offsetMinutes}`;
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetStr}`;
}

function generateAvailability(identifier) {
  var availability_topic = 'syr/' + identifier + '/availability';
  var availability = [
    {topic: 'syr/bridge/state'},
    {topic: availability_topic}
  ];
  return availability;
}

function generateMQTTDevice(model, snr, sw_version, url) {
  var mqttDevice = {
    identifiers: [ snr ],
    mf: "Syr",
    name: model,
    model: model,
    sw: sw_version,
    cu: url,

    identifier() {
      return (this.model + this.identifiers[0]).toLowerCase();
    }
  };

  return mqttDevice;
}

async function sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, sensorname, humanreadable_name, device_class, unit_of_measurement, icon = 'mdi:water') {
  var topic = 'homeassistant/sensor/syr_watersoftening/' + mqttDevice.identifier() + '_' + sensorname + '/config';
  var payload = {
        name: humanreadable_name,
        device_class: device_class,
        unit_of_measurement: unit_of_measurement,
        icon: icon,
        state_topic: 'syr/' + mqttDevice.identifier() + '/state',
        availability: generateAvailability(mqttDevice.identifier()),
        value_template: '{{ value_json.'+ sensorname +'}}',
        unique_id: mqttDevice.identifier() + "_" + sensorname,
        device: mqttDevice
      }
  await mqttclient.publish(topic, JSON.stringify(payload))
}

async function sendMQTTBinarySensorDiscoveryMessage(mqttclient, mqttDevice, sensorname, humanreadable_name, device_class) {
  var topic = 'homeassistant/binary_sensor/syr_watersoftening/' + mqttDevice.identifier() + '_' + sensorname + '/config';
  var payload = {
        name: humanreadable_name,
        device_class: device_class,
        state_topic: 'syr/' + mqttDevice.identifier() + '/state',
        availability: generateAvailability(mqttDevice.identifier()),
        value_template: '{{ value_json.'+ sensorname +'}}',
        unique_id: mqttDevice.identifier() + "_" + sensorname,
        device: mqttDevice
      }
  await mqttclient.publish(topic, JSON.stringify(payload))
}


async function sendMQTTNumberDiscoveryMessage(mqttclient, mqttDevice, numbername, humanreadable_name, device_class, unit_of_measurement, minimum, maximum, icon = 'mdi:water') {
  var topic = 'homeassistant/number/syr_watersoftening/' + mqttDevice.identifier() + '_' + numbername + '/config';
  var payload = {
        name: humanreadable_name,
        device_class: device_class,
        unit_of_measurement: unit_of_measurement,
        icon: icon,
        state_topic: 'syr/' + mqttDevice.identifier() + '/state',
        command_topic: 'syr/' + mqttDevice.identifier() + '/set_' + numbername,
        availability: generateAvailability(mqttDevice.identifier()),
        value_template: '{{ value_json.'+ numbername +'}}',
        unique_id: mqttDevice.identifier() + "_" + numbername,
        min: minimum,
        max: maximum,
        mode: 'box',
        device: mqttDevice
      }
  await mqttclient.publish(topic, JSON.stringify(payload))
}


async function sendMQTTButtonDiscoveryMessage(mqttclient, mqttDevice, buttonname, humanreadable_name) {
  var topic = 'homeassistant/button/syr_watersoftening/' + mqttDevice.identifier() + '_' + buttonname + '/config';
  var payload = {
        name: humanreadable_name,
        command_topic: 'syr/' + mqttDevice.identifier() + '/set_' + buttonname,
        availability: generateAvailability(mqttDevice.identifier()),
        unique_id: mqttDevice.identifier() + "_" + buttonname,
        device: mqttDevice
      }
  await mqttclient.publish(topic, JSON.stringify(payload))
}


async function sendMQTTAvailabilityMessage(mqttclient, mqttDevice) {
  var availability_topic = 'syr/' + mqttDevice.identifier() + '/availability';

  await mqttclient.publish(availability_topic, 'online', {retain: true})
}

async function sendMQTTStateMessage(mqttclient, model, snr, payload) {
  var identifier = (model + snr).toLowerCase();
  var topic = 'syr/' + identifier + '/state'

  await mqttclient.publish(topic, JSON.stringify(payload))
}

async function getDevice(model, snr, sw_version, url) {
  var identifier = (model + snr).toLowerCase();
  if(!devicesMap.has(identifier)) {
    logInfo("New MQTTDevice '" + identifier + "' at " + url);
    var mqttDevice = generateMQTTDevice(model, snr, sw_version, url);
    var device = {
      mqttDevice: mqttDevice,
      setters: { }
    };
    devicesMap.set(identifier, device);

    await sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, 'current_water_flow', 'Current Water Flow', null, 'l/min', 'mdi:water');
    await sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, 'salt_remaining', 'Salt Remaining', null, 'weeks', 'mdi:cup');
    await sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, 'remaining_resin_capacity', 'Remaining Resin Capacity', null, '%', 'mdi:water-percent');
    await sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, 'remaining_water_capacity', 'Remaining Water Capacity', 'water', 'L', 'mdi:water');
    await sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, 'total_water_consumption', 'Total Water Consumption', 'water', 'L', 'mdi:water');
    await sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, 'number_of_regenerations', 'Number of Regenerations', null, null, 'mdi:counter');
    await sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, 'last_regeneration', 'Last Regeneration', 'timestamp', null, 'mdi:clock-time-four-outline');
    await sendMQTTSensorDiscoveryMessage(mqttclient, mqttDevice, 'status_message', 'Status Message', null, null, 'mdi:message-text');
    await sendMQTTBinarySensorDiscoveryMessage(mqttclient, mqttDevice, 'regeneration_running', 'Regeneration Running', 'running');
  
    await sendMQTTButtonDiscoveryMessage(mqttclient, mqttDevice, 'start_regeneration', 'Start Regeneration');
    
    await sendMQTTNumberDiscoveryMessage(mqttclient, mqttDevice, 'salt_in_stock', 'Salt in Stock', 'weight', 'kg', 0, 25, 'mdi:cup');
    await sendMQTTNumberDiscoveryMessage(mqttclient, mqttDevice, 'regeneration_interval', 'Regeneration Interval', null, 'days', 1, 10, 'mdi:calendar-clock');
  
    await sendMQTTAvailabilityMessage(mqttclient, mqttDevice);
  }

  return devicesMap.get(identifier);
}

function getXmlBasicC() {
	let ret = "";
	basicC.forEach(c => ret += '<c n="' + c + '" v=""/>');
	return ret;
}

function getXmlAllC(device) {
	let ret = "";
	allC.forEach(getter => {
    var setter = getter.replace("get","set");
    if(device.setters[setter]) {
      var value = device.setters[setter];
      ret += '<c n="' + setter + '" v="' + value + '"/>';
      delete device.setters[setter];
    } else {
      ret += '<c n="' + getter + '" v=""/>'
    }
  });

  var remainingSetters = Object.keys(device.setters);
  for(const remainingSetter of remainingSetters) {
    var value = device.setters[remainingSetter];
    ret += '<c n="' + remainingSetter + '" v="' + value + '"/>';
    delete device.setters[remainingSetter];
  }

	return ret;
}

function parseToValueMap(json) {
  var valueMap = new Map();
		
  for(let i = 0; i < json.length; i++) {
    let id = json[i].$.n;
    let value = json[i].$.v;
    valueMap.set(id, value);
  }

  return valueMap;
}

function basicCommands(req, res) {
	res.set('Content-Type', 'text/xml');
	let responseXml = xmlStart + getXmlBasicC() + xmlEnd;
	res.send(responseXml);
	logVerbose("Response to basicCommands: " +  responseXml);
}

function allCommands(req, res) {
	xml.parseStringPromise(req.body.xml).then(async function(result) {
		let json = result.sc.d[0].c;

    var valueMap = parseToValueMap(json);
		
    var model = valueMap.get('getCNA');
    var snr = valueMap.get('getSRN');
    var sw_version = valueMap.get('getVER');
    var url = "http://" + valueMap.get('getIPA');

    var device = await getDevice(model, snr, sw_version, url);

    var allFound = true;
    for(let i = 0; i < allC.length; i++) {
      if(!valueMap.has(allC[i])) {
        allFound = false;
        break;
      }
    }

    if(allFound) {
      var payload = {
        current_water_flow: valueMap.get('getFLO'),
        salt_remaining: valueMap.get('getSS1'),
        remaining_resin_capacity: valueMap.get('getCS1'),
        remaining_water_capacity: valueMap.get('getRES'),
        total_water_consumption: valueMap.get('getCOF'),
        number_of_regenerations: valueMap.get('getTOR'),
        last_regeneration: formatTimestamp(valueMap.get('getLAR')),
        status_message: valueMap.get('getSTA'),
        salt_in_stock: valueMap.get('getSV1'),
        regeneration_interval: valueMap.get('getRPD'),
        regeneration_running: valueMap.get('getRG1') == "1" ? 'ON' : 'OFF'
      }
      logVerbose('Publishing state message:\n' + JSON.stringify(payload));
      sendMQTTStateMessage(mqttclient, model, snr, payload);
    }
	
		//send response
		res.set('Content-Type', 'text/xml');
		let responseXml = xmlStart + getXmlAllC(device) + xmlEnd;
		res.send(responseXml);
		
		logVerbose("Response to allCommands: " +  responseXml);
	})
	.catch(function(err) {
		logInfo(err);
	});
}

async function initWebServer() {
	const app = express();

	httpServer = http.createServer(app).listen(syrHttpPort);
	httpsServer = https.createServer(credentials, app).listen(syrHttpsPort);

	// for parsing application/x-www-form-urlencoded
	app.use(express.urlencoded({extended: true}));

	app.use((req, res, next) => {
		logVerbose("Request for " + req.hostname + req.url + "\n" + req.body.xml);
		next();
	});
	
	app.post('/WebServices/SyrConnectLimexWebService.asmx/GetBasicCommands', (req, res) => {
		basicCommands(req, res);
	});
	app.post('/GetBasicCommands', (req, res) => {
	 	basicCommands(req, res);
	});
	
	app.post('/WebServices/SyrConnectLimexWebService.asmx/GetAllCommands', (req, res) => {
		allCommands(req, res);
	});
	app.post('/GetAllCommands', (req, res) => {
		allCommands(req, res);
	});
	
	return app;
}

logInfo("Connecting to MQTT server '" + brokerUrl + "' with username '" + username + "'");

const mqttclient = mqtt.connect(brokerUrl,
                                {
                                  username: username,
                                  password: password,
                                  will: {
                                    topic: 'syr/bridge/state',
                                    payload: 'offline',
                                    retain: true
                                  }
                                });

const handleConnect = async () => {
  logInfo('Connected to MQTT server');

  mqttclient.subscribe('syr/#');
  mqttclient.subscribe('homeassistant/status');

  initWebServer().then(() => {
    logInfo("Webserver started listening");
  }).catch(err => {
          logInfo("Failed to initWebServer: " + err);
          process.exit(-1);
  });
}

const messageReceived = async (topic, message) => {
  const regex = /^syr\/([\w-]*)\/set_([\w-]*)$/;
  const match = topic.match(regex);

  if(match == null || match.length != 3)
  {
    return;
  }

  var device_identifier = match[1];
  var entity_name = match[2];

  if(entity_name == "state") {
    return;
  }

  logVerbose('Received message for topic ' + topic + ':\n' + message);

  if(!devicesMap.has(device_identifier)) {
    return;
  }
  var device = devicesMap.get(device_identifier);

  if(entity_name == 'salt_in_stock') {
    var salt = message.toString();
    device.setters["setSV1"] = salt;
  } else if(entity_name == 'regeneration_interval') {
    var regeneration_interval = message.toString();
    device.setters["setRPD"] = regeneration_interval;
  } else if(entity_name == 'start_regeneration') {
    if(message == "PRESS") {
       device.setters["setSIR"] = "0";
    }
  }
  
}

mqttclient.on('connect', handleConnect);

mqttclient.on('message', messageReceived);




