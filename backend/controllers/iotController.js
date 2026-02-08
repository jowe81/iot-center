import { createRequire } from 'module';
import { getDb } from "../config/db.js";
import log from "../utils/logger.js";
import { getPendingCommands, acknowledgeCommands } from './commandService.js';

const require = createRequire(import.meta.url);
const iotConfig = require("../config/iotConfig.json");

export const processDeviceMessage = async (data, protocol = 'UNKNOWN') => {
    try {
        // Extract deviceId from the first device of type SystemMonitor
        let deviceId;
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

        if (!deviceId) {
            log.info(`[${protocol}] Received data from unknown device without an id. Ignoring.`);
            return { statusCode: 400, payload: "Missing deviceId" };
        }

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
        for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && value.type && deviceConfig[value.type]) {
                const extracted = {};
                const typeConfig = deviceConfig[value.type];
                const fields = Array.isArray(typeConfig) ? typeConfig : Object.keys(typeConfig);

                fields.forEach((field) => {
                    const config = Array.isArray(typeConfig) ? true : typeConfig[field];
                    const shouldSave = config === true || (config && typeof config === 'object' && config.save === true);
                    if (shouldSave && value[field] !== undefined) {
                        extracted[field] = value[field];
                    }
                });

                if (Object.keys(extracted).length > 0) {
                    if (!filteredData.data[value.type]) {
                        filteredData.data[value.type] = {};
                    }
                    filteredData.data[value.type][key] = extracted;
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

        const responsePayload = { status: "Recorded", collection: `device_${deviceId}`, deviceId };
        
        const commands = await getPendingCommands(deviceId) || {};

        if (Object.keys(commands).length > 0) {
            Object.assign(responsePayload, commands);
            log.info(`Sending commands to ${deviceId}: ${JSON.stringify(commands)}`);
        }

        log.info(`[${protocol}] Data recorded for device: ${deviceId}`);
        return { statusCode: 201, payload: responsePayload, commands, deviceId };
    } catch (error) {
        log.error("Error processing data", error);
        throw error;
    }
};

export const processData = async (req, res) => {
    try {
        if (req.body.requestType === 'commandAck') {
            const acknowledged = await acknowledgeCommands(req.body._ack);
            log.info(`[HTTP] Acknowledged commands: ${acknowledged.join(', ')}`);
            return res.status(200).send({ status: "Acknowledged", acknowledged });
        }

        const result = await processDeviceMessage(req.body, 'HTTP');
        res.status(result.statusCode).send(result.payload);
    } catch (error) {
        // If the error was thrown by processDeviceMessage, it's already logged
        res.status(500).send(error.message);
    }
};
