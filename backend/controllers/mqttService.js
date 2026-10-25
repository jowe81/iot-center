import mqtt from 'mqtt';
import { createRequire } from 'module';
import { processDeviceMessage } from '../controllers/iotController.js';
import { getValue } from '../utils/dataUtils.js';
import { recordSample } from '../utils/readingHistory.js';
import { applyFormatters, formatClock } from '../plugins/formatters.js';
import { getDailyHighLow, isDaytimeWindow } from '../services/forecastService.js';
import log from '../utils/logger.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');

let client;
let forwardClient;
let clockTimer;
let forecastTimer;
const lastForwarded = new Map();
let lastNotConnectedLog = 0;

const connectionFromConfig = (mqttConfig) => {
    const options = {};
    let brokerUrl = mqttConfig?.brokerUrl || 'mqtt://localhost:1883';
    if (mqttConfig?.brokerPort) options.port = mqttConfig.brokerPort;
    if (mqttConfig?.username) options.username = mqttConfig.username;
    if (mqttConfig?.password) options.password = mqttConfig.password;
    return { brokerUrl, options };
};

const forwardRules = () => {
    const rules = iotConfig.system?.mqtt?.forward;
    return Array.isArray(rules) ? rules : [];
};

export const initMqttService = () => {
    let brokerUrl = process.env.MQTT_BROKER_URL;
    let options = {};

    if (!brokerUrl) {
        if (iotConfig.system && iotConfig.system.mqtt && iotConfig.system.mqtt.brokerUrl) {
            ({ brokerUrl, options } = connectionFromConfig(iotConfig.system.mqtt));
        } else {
            brokerUrl = 'mqtt://localhost:1883';
        }
    }
    
    log.info(`[MQTT] Initializing, connecting to ${brokerUrl}`);
    
    client = mqtt.connect(brokerUrl, options);

    const forwardBroker = iotConfig.system?.mqtt?.forwardBroker;
    if (forwardBroker?.brokerUrl) {
        const forwardConnection = connectionFromConfig(forwardBroker);
        log.info(`[MQTT] Forward client connecting to ${forwardConnection.brokerUrl}`);
        forwardClient = mqtt.connect(forwardConnection.brokerUrl, forwardConnection.options);
        forwardClient.on('connect', () => {
            log.info('[MQTT] Forward client connected');
            publishClock();
            publishForecast();
        });
        forwardClient.on('error', (err) => log.error('[MQTT] Forward client error:', err));
    }

    const rules = forwardRules().filter(rule => rule && rule.enabled !== false && rule.device && rule.key);
    if (rules.length > 0) {
        log.info(`[MQTT] Forwarding ${rules.length} configured field(s) when data updates`);
        for (const rule of rules) {
            const topic = rule.topic || `iotcenter/${rule.device}/${String(rule.key).replace(/\./g, '/')}`;
            log.info(`[MQTT] Forward ${rule.device} ${rule.key} -> ${topic}`);
        }
    }

    client.on('connect', () => {
        log.info('[MQTT] Connected to broker');
        subscribeToDevices(client);
        publishClock();
        publishForecast();
    });

    client.on('message', async (topic, message) => {
        try {
            const payload = JSON.parse(message.toString());            
            const result = await processDeviceMessage(payload, 'MQTT');
            
            // If there are commands to send back, publish them to the command topic
            if (result.statusCode === 201 && result.commands && Object.keys(result.commands).length > 0) {
                const deviceId = result.deviceId;
                const commandTopic = `device/${deviceId}/command`;
                log.info(`[MQTT] Publishing commands to ${commandTopic}`);
                client.publish(commandTopic, JSON.stringify(result.commands));
            }

        } catch (error) {
            log.error(`Error processing MQTT message on ${topic}:`, error);
        }
    });

    client.on('error', (err) => {
        log.error('MQTT Error:', err);
    });

    startClock();
    startForecast();

    return client;
};

const getPublishClient = () => forwardClient || client;

const clockConfig = () => {
    const clock = iotConfig.system?.mqtt?.clock;
    if (!clock || clock.enabled === false || !clock.topic) return null;
    return clock;
};

const publishClock = () => {
    const clock = clockConfig();
    if (!clock) return;

    const mqttClient = getPublishClient();
    if (!mqttClient?.connected) return;

    if (isReservedTopic(clock.topic)) {
        log.error(`[MQTT] Refusing to publish clock onto reserved topic ${clock.topic}`);
        return;
    }

    const body = formatClock(new Date(), clock.format || 'HH:MM');
    mqttClient.publish(clock.topic, body, { qos: 0, retain: clock.retain === true }, (err) => {
        if (err) log.error(`[MQTT] Failed to publish clock to ${clock.topic}`, err);
        else log.debug(`[MQTT] Published clock ${body} to ${clock.topic}`);
    });
};

const startClock = () => {
    const clock = clockConfig();
    if (!clock) return;

    const seconds = Number(clock.intervalSeconds);
    const intervalMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15000;
    if (clockTimer) clearInterval(clockTimer);
    log.info(`[MQTT] Publishing clock to ${clock.topic} every ${intervalMs / 1000}s as ${clock.format || 'HH:MM'}`);
    publishClock();
    clockTimer = setInterval(publishClock, intervalMs);
};

const isReservedTopic = (topic) => /^device\/[^/]+\/(data|command)$/.test(topic);

const forecastConfig = () => {
    const forecast = iotConfig.system?.mqtt?.forecast;
    if (!forecast || forecast.enabled === false || !forecast.topic) return null;
    return forecast;
};

const publishForecast = async () => {
    const forecast = forecastConfig();
    if (!forecast) return;

    const mqttClient = getPublishClient();
    if (!mqttClient?.connected) return;

    if (isReservedTopic(forecast.topic)) {
        log.error(`[MQTT] Refusing to publish forecast onto reserved topic ${forecast.topic}`);
        return;
    }

    const location = iotConfig.system?.location || {};
    const lat = forecast.lat ?? location.latitude;
    const lon = forecast.lon ?? location.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') {
        log.error('[MQTT] Forecast publish needs a latitude and longitude');
        return;
    }

    try {
        const { todayHigh, tonightLow } = await getDailyHighLow(lat, lon);
        const daytime = isDaytimeWindow(new Date(), forecast.dayStart, forecast.nightStart);
        const value = daytime ? todayHigh : tonightLow;
        if (value === null || value === undefined) return;

        let body = await applyFormatters(value, forecast.formatters, { originalValue: value });
        body = body !== null && typeof body === 'object' ? JSON.stringify(body) : String(body);
        mqttClient.publish(forecast.topic, body, { qos: 0, retain: forecast.retain === true }, (err) => {
            if (err) log.error(`[MQTT] Failed to publish forecast to ${forecast.topic}`, err);
            else log.debug(`[MQTT] Published forecast ${body} to ${forecast.topic}`);
        });
    } catch (error) {
        log.error('[MQTT] Failed to publish forecast', error);
    }
};

const startForecast = () => {
    const forecast = forecastConfig();
    if (!forecast) return;

    const seconds = Number(forecast.intervalSeconds);
    const intervalMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15000;
    if (forecastTimer) clearInterval(forecastTimer);
    log.info(`[MQTT] Publishing forecast to ${forecast.topic} every ${intervalMs / 1000}s`);
    publishForecast();
    forecastTimer = setInterval(publishForecast, intervalMs);
};

const encodePayload = (rule, deviceId, key, value, dataDoc) => {
    if (rule.valueOnly) {
        if (value !== null && typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }
    const receivedAt = dataDoc.receivedAt instanceof Date
        ? dataDoc.receivedAt.toISOString()
        : dataDoc.receivedAt;
    return JSON.stringify({ device: deviceId, key, value, receivedAt });
};

/**
 * Publishes configured fields after a device update is recorded.
 * Rules live at system.mqtt.forward:
 *   { device, key, topic?, highTopic?, lowTopic?, valueOnly?, formatters?, retain?, qos?, onChange?, enabled? }
 * key uses the same path as action sources, e.g. "data.Sensor.BME280.controlBox.temperature".
 * formatters run in order before publish. See plugins/formatters.js.
 * topic defaults to iotcenter/{device}/{key with dots as slashes}.
 * Set system.mqtt.forwardBroker to publish to a different broker than device ingest.
 */
export const forwardDeviceData = async (deviceId, dataDoc) => {
    const rules = forwardRules();
    if (rules.length === 0) return;

    const publishClient = forwardClient || client;
    if (!publishClient || !publishClient.connected) {
        const now = Date.now();
        if (now - lastNotConnectedLog > 30000) {
            lastNotConnectedLog = now;
            log.warn('[MQTT] Not connected; skipping data forward');
        }
        return;
    }

    for (const rule of rules) {
        if (!rule || rule.enabled === false || rule.device !== deviceId || !rule.key) continue;

        let key = rule.key;
        let value = getValue(dataDoc, key);
        if (value === undefined && !key.startsWith('data.')) {
            key = `data.${key}`;
            value = getValue(dataDoc, key);
        }
        if (value === undefined) continue;

        const topic = rule.topic || `iotcenter/${deviceId}/${key.replace(/\./g, '/')}`;
        if (isReservedTopic(topic)) {
            log.error(`[MQTT] Refusing to forward ${rule.key} onto reserved topic ${topic}`);
            continue;
        }

        const receivedAt = dataDoc.receivedAt instanceof Date
            ? dataDoc.receivedAt
            : new Date(dataDoc.receivedAt || Date.now());
        const numeric = typeof value === 'number' ? value : Number(value);
        const extremes = Number.isFinite(numeric) && !Number.isNaN(receivedAt.getTime())
            ? recordSample(deviceId, key, receivedAt.getTime(), numeric)
            : null;

        const formatted = await applyFormatters(value, rule.formatters, {
            deviceId,
            key,
            receivedAt,
            originalValue: value,
        });
        const serialized = JSON.stringify(formatted);
        const cacheKey = `${deviceId}|${rule.key}|${topic}`;
        const qos = rule.qos === 1 || rule.qos === 2 ? rule.qos : 0;
        const retain = rule.retain === true;

        if (!(rule.onChange && lastForwarded.get(cacheKey) === serialized)) {
            const body = encodePayload(rule, deviceId, key, formatted, dataDoc);
            lastForwarded.set(cacheKey, serialized);
            publishClient.publish(topic, body, { qos, retain }, (err) => {
                if (err) {
                    log.error(`[MQTT] Failed to forward ${topic}`, err);
                    if (lastForwarded.get(cacheKey) === serialized) lastForwarded.delete(cacheKey);
                } else {
                    log.debug(`[MQTT] Forwarded ${rule.key} to ${topic}`);
                }
            });
        }

        if (extremes) {
            const extremeFormatters = (rule.formatters || []).filter((step) => {
                const name = typeof step === 'string' ? step : step?.name;
                return name && name !== 'trend';
            });
            await publishExtreme(publishClient, rule.highTopic, extremes.high, extremeFormatters, qos, retain);
            await publishExtreme(publishClient, rule.lowTopic, extremes.low, extremeFormatters, qos, retain);
        }
    }
};

const publishExtreme = async (publishClient, topic, value, formatters, qos, retain) => {
    if (!topic || value === null || value === undefined) return;
    if (isReservedTopic(topic)) {
        log.error(`[MQTT] Refusing to publish extreme onto reserved topic ${topic}`);
        return;
    }
    let body = await applyFormatters(value, formatters, { originalValue: value });
    body = body !== null && typeof body === 'object' ? JSON.stringify(body) : String(body);
    publishClient.publish(topic, body, { qos, retain }, (err) => {
        if (err) log.error(`[MQTT] Failed to publish ${topic}`, err);
        else log.debug(`[MQTT] Published ${body} to ${topic}`);
    });
};

export const sendMqttCommand = (deviceId, command, commandId = null) => {
    if (client && client.connected) {
        const commandTopic = `device/${deviceId}/command`;
        const payload = { ...command };
        if (commandId) {
            payload._ack = commandId.toString();
        }
        log.info(`[MQTT] Publishing immediate command to ${commandTopic}`);
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
                log.info(`[MQTT] Subscribing to topic: ${topic}`);
                client.subscribe(topic);
            }
        }
    }
};