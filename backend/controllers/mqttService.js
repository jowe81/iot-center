import mqtt from 'mqtt';
import { createRequire } from 'module';
import { acknowledgeCommands } from './commandService.js';
import { processDeviceMessage } from '../controllers/iotController.js';
import log from '../utils/logger.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');

let client;

export const initMqttService = () => {
    let brokerUrl = process.env.MQTT_BROKER_URL;
    let options = {};

    if (!brokerUrl) {
        if (iotConfig.system && iotConfig.system.mqtt && iotConfig.system.mqtt.brokerUrl) {
            brokerUrl = iotConfig.system.mqtt.brokerUrl;
            if (iotConfig.system.mqtt.brokerPort) {
                options.port = iotConfig.system.mqtt.brokerPort;
            }
            if (iotConfig.system.mqtt.username) {
                options.username = iotConfig.system.mqtt.username;
            }
            if (iotConfig.system.mqtt.password) {
                options.password = iotConfig.system.mqtt.password;
            }
        } else {
            brokerUrl = 'mqtt://localhost:1883';
        }
    }
    
    log.info(`Initializing MQTT Service, connecting to ${brokerUrl}`);
    
    client = mqtt.connect(brokerUrl, options);

    client.on('connect', () => {
        log.info('MQTT Connected');
        subscribeToDevices(client);
        const ackTopic = 'device/+/commandAck';
        log.info(`Subscribing to MQTT topic: ${ackTopic}`);
        client.subscribe(ackTopic);
    });

    client.on('message', async (topic, message) => {
        try {
            if (topic.endsWith('/commandAck')) {
                const msgStr = message.toString();
                log.info(`MQTT ACK received on ${topic}: ${msgStr}`);
                
                const ids = await acknowledgeCommands(msgStr);
                if (ids.length > 0) {
                    log.info(`[MQTT] Acknowledged commands: ${ids.join(', ')}`);
                }
                return;
            }

            const payload = JSON.parse(message.toString());            
            const result = await processDeviceMessage(payload, 'MQTT');
            
            // If there are commands to send back, publish them to the command topic
            if (result.statusCode === 201 && result.commands && Object.keys(result.commands).length > 0) {
                const deviceId = result.deviceId;
                const commandTopic = `device/${deviceId}/command`;
                log.info(`Publishing commands to ${commandTopic}`);
                client.publish(commandTopic, JSON.stringify(result.commands));
            }

        } catch (error) {
            log.error(`Error processing MQTT message on ${topic}:`, error);
        }
    });

    client.on('error', (err) => {
        log.error('MQTT Error:', err);
    });

    return client;
};

export const sendMqttCommand = (deviceId, command, commandId = null) => {
    if (client && client.connected) {
        const commandTopic = `device/${deviceId}/command`;
        const payload = { ...command };
        if (commandId) {
            payload._ack = commandId.toString();
        }
        log.info(`Publishing immediate command to ${commandTopic}`);
        client.publish(commandTopic, JSON.stringify(payload));
        return true;
    }
    return false;
};

const subscribeToDevices = (client) => {
    const devices = iotConfig.devices || {};
    
    for (const [deviceId, config] of Object.entries(devices)) {
        // Check if the device is configured to use MQTT
        if (config.network && config.network.protocol) {
            const protocols = Array.isArray(config.network.protocol)
                ? config.network.protocol
                : [config.network.protocol];

            if (protocols.includes('mqtt')) {
                // Assuming topic convention: device/{deviceId}/data
                const topic = `device/${deviceId}/data`;
                log.info(`Subscribing to MQTT topic: ${topic}`);
                client.subscribe(topic);
            }
        }
    }
};