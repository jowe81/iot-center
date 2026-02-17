import { createRequire } from 'module';
import { getDb } from "../config/db.js";
import log from "../utils/logger.js";
import { getPendingCommands, acknowledgeCommands } from './commandService.js';
import { broadcast } from './websocketService.js';
import { fetchDeviceStats } from './frontendController.js';
import { findDataKeys, getValue, isRedundant } from '../utils/dataUtils.js';
import { saveRawData } from '../utils/rawDataStore.js';

const require = createRequire(import.meta.url);
const iotConfig = require("../config/iotConfig.json");

export const processDeviceMessage = async (data, protocol = 'UNKNOWN') => {
    try {
        // Check for acknowledgement in the payload
        if (data._ack) {
            const acknowledged = await acknowledgeCommands(data._ack);
            if (acknowledged.length > 0) {
                log.info(`[${protocol}] Acknowledged commands: ${acknowledged.join(', ')}`);
            }
        }

        // Extract deviceId from the first device of type SystemMonitor
        let deviceId;
        const isArray = Array.isArray(data);

        if (isArray) {
            for (const item of data) {
                if (item.deviceId) {
                    deviceId = item.deviceId;
                    break;
                }
            }
        } else {
            for (const value of Object.values(data)) {
                if (value && typeof value === 'object' && value.type === 'SystemMonitor' && value.deviceId) {
                    deviceId = value.deviceId;
                    break;
                }
            }

            // Fallback: if no id was found, see if there's on at the toplevel.
            if (!deviceId) {
                deviceId = data.deviceId;
            }
        }

        if (!deviceId) {
            log.info(`[${protocol}] Received data from unknown device without an id. Ignoring.`);
            return { statusCode: 400, payload: "Missing deviceId" };
        }

        // Save raw data in memory
        saveRawData(deviceId, data);

        // Select configuration for this device
        const deviceSettings = iotConfig.devices?.[deviceId];
        if (!deviceSettings) {
            log.info(`[${protocol}] Received data from unknown device with id: ${deviceId}. Ignoring.`);
            return { statusCode: 200, payload: { status: "Ignored", message: "Unknown device" } };
        }

        // Check if the protocol is allowed for this device
        if (deviceSettings.network && deviceSettings.network.protocol) {
            const configuredProtocols = Array.isArray(deviceSettings.network.protocol)
                ? deviceSettings.network.protocol
                : [deviceSettings.network.protocol];

            if (protocol !== 'UNKNOWN' && !configuredProtocols.includes(protocol.toLowerCase())) {
                log.info(`[${protocol}] Protocol not allowed for device ${deviceId}.`);
                return { statusCode: 403, payload: "Protocol not allowed" };
            }
        }

        const deviceConfig = deviceSettings.data || {};

        const filteredData = {
            data: {},
        };

        // Iterate over top-level keys to find typed objects
        if (isArray) {
            for (const item of data) {
                const { type, subtype, name } = item;
                if (!type || !subtype || !name) continue;

                const configKey = `${type}.${subtype}`;
                const typeConfig = deviceConfig[configKey];

                if (typeConfig) {
                    const extracted = {};
                    const fields = Array.isArray(typeConfig) ? typeConfig : Object.keys(typeConfig);

                    fields.forEach((field) => {
                        const config = Array.isArray(typeConfig) ? true : typeConfig[field];
                        const shouldSave = config === true || (config && typeof config === 'object' && config.save === true);
                        if (shouldSave && item[field] !== undefined) {
                            extracted[field] = item[field];
                        }
                    });

                    if (Object.keys(extracted).length > 0) {
                        if (!filteredData.data[type]) filteredData.data[type] = {};
                        if (!filteredData.data[type][subtype]) filteredData.data[type][subtype] = {};
                        filteredData.data[type][subtype][name] = extracted;
                    }
                }
            }
        } else {
            for (const [key, value] of Object.entries(data)) {
                if (value && typeof value === "object") {
                    let configKey;
                    if (deviceConfig[key]) {
                        configKey = key;
                    } else if (value.subType && deviceConfig[value.subType]) {
                        configKey = value.subType;
                    } else if (value.type && deviceConfig[value.type]) {
                        configKey = value.type;
                    }

                    if (configKey) {
                        const extracted = {};
                        const typeConfig = deviceConfig[configKey];
                        const fields = Array.isArray(typeConfig) ? typeConfig : Object.keys(typeConfig);

                        fields.forEach((field) => {
                            const config = Array.isArray(typeConfig) ? true : typeConfig[field];
                            const shouldSave = config === true || (config && typeof config === 'object' && config.save === true);
                            if (shouldSave && value[field] !== undefined) {
                                extracted[field] = value[field];
                            }
                        });

                        if (Object.keys(extracted).length > 0) {
                            const storageKey = value.type || configKey;
                            if (!filteredData.data[storageKey]) {
                                filteredData.data[storageKey] = {};
                            }
                            filteredData.data[storageKey][key] = extracted;
                        }
                    }
                }
            }
        }

        // Add a timestamp automatically
        filteredData.receivedAt = new Date();
        filteredData.protocol = protocol.toLowerCase();

        // Store in collection for this device.
        const db = getDb();
        const collection = db.collection(`device_${deviceId}`);
        await collection.insertOne(filteredData);

        // Post-processing: Remove redundant data from the previous record
        const keysToCheck = findDataKeys(filteredData);
        
        for (const key of keysToCheck) {
            const lastThree = await collection.find(
                { [key]: { $exists: true } },
                { projection: { [key]: 1 }, sort: { receivedAt: -1 }, limit: 3 }
            ).toArray();

            if (lastThree.length === 3) {
                const [c, b, a] = lastThree;
                const valC = getValue(c, key);
                const valB = getValue(b, key);
                const valA = getValue(a, key);

                if (isRedundant(valA, valB, valC)) {
                    await collection.updateOne({ _id: b._id }, { $unset: { [key]: "" } });
                }
            }
        }

        const responsePayload = { status: "Recorded", collection: `device_${deviceId}`, deviceId };
        
        const commands = await getPendingCommands(deviceId) || {};

        if (Object.keys(commands).length > 0) {
            Object.assign(responsePayload, commands);
            log.info(`Sending commands to ${deviceId}: ${JSON.stringify(commands)}`);
        }

        log.info(`[${protocol}] Data recorded for device: ${deviceId}`);
        
        // Broadcast updates via WebSocket
        broadcast('LATEST', { deviceId, payload: filteredData });
        broadcast('LATEST_RAW', { deviceId, payload: data });
        const stats = await fetchDeviceStats(deviceId);
        broadcast('STATS', { deviceId, payload: stats });

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
