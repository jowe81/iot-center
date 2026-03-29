import { createRequire } from 'module';
import { getDb } from "../config/db.js";
import log from "../utils/logger.js";
import { getPendingCommands, acknowledgeCommands } from './commandService.js';
import { broadcast, sendToClient } from './websocketService.js';
import { runDataDrivenActions } from './actionService.js';
import { updateOrCreateDevice } from './logicalDeviceManager.js';
import { fetchDeviceStats, getSingleDeviceStatusData } from './frontendController.js';
import { findDataKeys, getValue, setValue, isRedundant } from '../utils/dataUtils.js';
import { saveRawData } from '../utils/rawDataStore.js';
import * as woodstoveState from '../plugins/data/woodstoveState.js';
import * as batteryCharge from '../plugins/data/batteryCharge.js';
import * as seaLevelPressure from '../plugins/data/seaLevelPressure.js';


const require = createRequire(import.meta.url);
const iotConfig = require("../config/iotConfig.json");

const availablePlugins = {
    woodstoveState,
    batteryCharge,
    seaLevelPressure,
};

// --- Helper Functions ---

const extractDeviceId = (data) => {
    if (Array.isArray(data)) {
        for (const item of data) {
            if (item.deviceId) return item.deviceId;
        }
    } else {
        // Check for SystemMonitor in object values
        for (const value of Object.values(data)) {
            if (value && typeof value === 'object' && value.type === 'SystemMonitor' && value.deviceId) {
                return value.deviceId;
            }
        }
        // Fallback to top-level
        if (data.deviceId) return data.deviceId;
    }
    return null;
};

const validateDevice = (deviceId, protocol) => {
    const deviceSettings = iotConfig.devices?.[deviceId];
    if (!deviceSettings) {
        return { valid: false, error: "Unknown device", statusCode: 200 }; // 200 to ignore silently-ish
    }

    if (deviceSettings.network && deviceSettings.network.protocol) {
        const configuredProtocols = Array.isArray(deviceSettings.network.protocol)
            ? deviceSettings.network.protocol
            : [deviceSettings.network.protocol];

        if (protocol !== 'UNKNOWN' && !configuredProtocols.includes(protocol.toLowerCase())) {
            return { valid: false, error: "Protocol not allowed", statusCode: 403 };
        }
    }
    return { valid: true, settings: deviceSettings };
};

const processIncomingData = async (data, deviceConfig, deviceId) => {
    const filteredData = { data: {} };
    const pluginsToRun = [];

    const processItem = async (item, type, subtype, name) => {
        if (!type || !subtype || !name) return;

        // Handle Wildcards: Check "Type.Subtype" then "Type.Subtype.*"
        // Order of precedence: Type.Subtype.Name, then Type.Subtype.*, then Type.Subtype
        const specificConfigKey = `${type}.${subtype}.${name}`;
        const typeConfig = deviceConfig[specificConfigKey] || deviceConfig[`${type}.${subtype}.*`] || deviceConfig[`${type}.${subtype}`];

        if (!typeConfig) return;

        // Ensure structure exists
        if (!filteredData.data[type]) filteredData.data[type] = {};
        if (!filteredData.data[type][subtype]) filteredData.data[type][subtype] = {};
        if (!filteredData.data[type][subtype][name]) filteredData.data[type][subtype][name] = {};

        const componentData = filteredData.data[type][subtype][name];

        for (const [field, config] of Object.entries(typeConfig)) {
            // 1. Check for Plugin Configuration
            if (config && typeof config === 'object' && config.plugin) {
                pluginsToRun.push({
                    pluginName: config.plugin,
                    outputKey: `data.${type}.${subtype}.${name}.${field}`,
                    config: config
                });
            }
            // 2. Check for Standard Data Field
            else {
                const shouldSave = config === true || (config && typeof config === 'object' && config.save === true);
                if (shouldSave && item[field] !== undefined) {
                    componentData[field] = item[field];
                }
            }
        }

        // Maintain a logical device instance for each sub-device reported.
        const deviceKey = `iot.${deviceId}.${name}`;
        await updateOrCreateDevice(deviceKey, {typeConfig, latestRawData: item});

    };

    if (Array.isArray(data)) {
        for (const item of data) {
            await processItem(item, item.type, item.subtype, item.name);
        }
    } else {
        for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === 'object') {
                const type = value.type;
                const subtype = value.subType || value.subtype;
                await processItem(value, type, subtype, key);
            }
        }
    }

    return { filteredData, pluginsToRun };
};

const executePlugins = async (pluginsToRun, filteredData, deviceId) => {
    const db = getDb();
    const collection = db.collection(`device_${deviceId}`);
    const lastRecord = await collection.findOne({}, { sort: { receivedAt: -1 } });

    for (const task of pluginsToRun) {
        const plugin = availablePlugins[task.pluginName];
        if (plugin && plugin.run) {
            try {
                const inputs = {};
                if (task.config.inputKeys) {
                    for (const inputKey of task.config.inputKeys) {
                        // Map "Sensor.Type..." to "data.Sensor.Type..." for getValue lookup
                        inputs[inputKey] = getValue(filteredData, `data.${inputKey}`);
                    }
                }

                const pluginOutputKey = task.outputKey.replace(/^data\./, '');
                
                let previousValue = undefined;
                if (lastRecord) {
                    const storedValue = getValue(lastRecord, task.outputKey);
                    if (storedValue !== undefined && storedValue !== null) {
                        if (task.config.outputScale && typeof storedValue === 'number') {
                            previousValue = storedValue / task.config.outputScale;
                        } else {
                            previousValue = storedValue;
                        }
                    }
                }

                let result = await plugin.run(deviceId, filteredData, inputs, pluginOutputKey, task.config.options || {}, getDb(), lastRecord, previousValue);

                if (result !== undefined) {
                    if (task.config.outputScale && typeof result === 'number') {
                        result *= task.config.outputScale;
                    }
                    setValue(filteredData, task.outputKey, result);
                }
            } catch (e) {
                log.error(`Error running plugin ${task.pluginName} for ${deviceId}:`, e);
            }
        }
    }
};

const saveAndBroadcast = async (deviceId, filteredData, rawData, protocol) => {
    const db = getDb();
    const collection = db.collection(`device_${deviceId}`);
    
    // Save to DB
    await collection.insertOne(filteredData);

    // Post-processing: Redundancy Check
    const keysToCheck = findDataKeys(filteredData);
    for (const key of keysToCheck) {
        const lastThree = await collection.find(
            { [key]: { $exists: true } },
            { projection: { [key]: 1 }, sort: { receivedAt: -1 }, limit: 3 }
        ).toArray();

        if (lastThree.length === 3) {
            const [c, b, a] = lastThree;
            if (isRedundant(getValue(a, key), getValue(b, key), getValue(c, key))) {
                await collection.updateOne({ _id: b._id }, { $unset: { [key]: "" } });
            }
        }
    }

    log.info(`[${protocol}] Data recorded for device: ${deviceId}`);

    // Broadcast
    broadcast('LATEST', { deviceId, payload: filteredData });
    broadcast('LATEST_RAW', { deviceId, payload: rawData });
    const stats = await fetchDeviceStats(deviceId);
    const singleDeviceStatus = await getSingleDeviceStatusData(deviceId);
    broadcast('STATUS_UPDATE', { payload: singleDeviceStatus });
    broadcast('STATS', { deviceId, payload: stats });
};

export const processDeviceMessage = async (data, protocol = 'UNKNOWN') => {
    try {
        const deviceId = extractDeviceId(data);

        // Check for acknowledgement in the payload
        let ackIds = data._ack;
        if (!ackIds) {
            const items = Array.isArray(data) ? data : Object.values(data);
            for (const item of items) {
                if (item && typeof item === 'object' && (item.type === 'DataExchanger' || item.subtype === 'DataExchanger' || item.subType === 'DataExchanger') && item._ack) {
                    ackIds = item._ack;
                    break;
                }
            }
        }

        if (ackIds) {
            const acknowledged = await acknowledgeCommands(ackIds);
            if (acknowledged.length > 0) {
                log.info(`[${protocol}] Device ${deviceId || 'unknown'} acknowledged commands: ${acknowledged.join(', ')}`);
            }
        }

        if (!deviceId) {
            log.info(`[${protocol}] Received data from unknown device without an id. Ignoring.`);
            return { statusCode: 400, payload: "Missing deviceId" };
        }

        // Save raw data in memory
        saveRawData(deviceId, data);

        // Validate Device and Protocol
        const validation = validateDevice(deviceId, protocol);
        if (!validation.valid) {
            log.info(`[${protocol}] ${validation.error} for id: ${deviceId}. Ignoring.`);
            return { statusCode: validation.statusCode, payload: validation.error };
        }
        const deviceSettings = validation.settings;

        // Process Data
        const { filteredData, pluginsToRun } = await processIncomingData(data, deviceSettings.data || {}, deviceId);
        
        // Add a timestamp automatically
        filteredData.receivedAt = new Date();
        filteredData.protocol = protocol.toLowerCase();

        // Run Plugins
        await executePlugins(pluginsToRun, filteredData, deviceId);

        // Trigger any data-driven actions
        await runDataDrivenActions(deviceId, filteredData);

        // Save and Broadcast
        await saveAndBroadcast(deviceId, filteredData, data, protocol);

        const responsePayload = { status: "Recorded", collection: `device_${deviceId}`, deviceId };
        
        const commands = await getPendingCommands(deviceId) || {};

        if (Object.keys(commands).length > 0) {
            Object.assign(responsePayload, commands);
            log.info(`[CommandQueue] Sending commands to ${deviceId}: ${JSON.stringify(commands)}`);
        }

        return { statusCode: 201, payload: responsePayload, commands, deviceId };
    } catch (error) {
        log.error("Error processing data", error);
        throw error;
    }
};

export const processData = async (req, res) => {
    try {
        const result = await processDeviceMessage(req.body, 'HTTP');
        res.status(result.statusCode).send(result.payload);
    } catch (error) {
        // If the error was thrown by processDeviceMessage, it's already logged
        res.status(500).send(error.message);
    }
};
