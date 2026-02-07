import { createRequire } from 'module';
import { getDb } from "../config/db.js";
import log from "../utils/logger.js";

const require = createRequire(import.meta.url);
const iotConfig = require("../config/iotConfig.json");

export const processData = async (req, res) => {
    try {
        // Extract deviceId from the first device of type SystemMonitor
        let deviceId;
        for (const value of Object.values(req.body)) {
            if (value && typeof value === 'object' && value.type === 'SystemMonitor' && value.deviceId) {
                deviceId = value.deviceId;
                break;
            }
        }

        // Fallback: if no id was found, see if there's on at the toplevel.
        if (!deviceId) {
            deviceId = req.body.deviceId;
        }

        if (!deviceId) {
            log.info(`Received data from unknown device without an id. Ignoring.`);
            return res.status(400).send("Missing deviceId");
        }

        // Select configuration for this device
        const deviceSettings = iotConfig.devices?.[deviceId];
        if (!deviceSettings) {
            log.info(`Received data from unknown device with id: ${deviceId}. Ignoring.`);
            return res.status(200).send({ status: "Ignored", message: "Unknown device" });
        }

        const deviceConfig = deviceSettings.data || {};

        const filteredData = {
            data: {},
        };

        // Iterate over top-level keys to find typed objects
        for (const [key, value] of Object.entries(req.body)) {
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

        // Store in collection for this device.
        const db = getDb();
        const collection = db.collection(`device_${deviceId}`);
        await collection.insertOne(filteredData);

        // Check for pending commands
        const commandCollection = db.collection('command_queue');
        const pendingCommands = await commandCollection.find({ deviceId, status: 'pending' }).toArray();

        const responsePayload = { status: "Recorded", collection: `device_${deviceId}` };

        if (pendingCommands.length > 0) {
            const commands = {};
            for (const cmd of pendingCommands) {
                for (const [subDevice, subCmds] of Object.entries(cmd.command)) {
                    if (!commands[subDevice]) {
                        commands[subDevice] = {};
                    }
                    Object.assign(commands[subDevice], subCmds);
                }
                // Mark as sent
                await commandCollection.updateOne({ _id: cmd._id }, { $set: { status: 'sent', sentAt: new Date() } });
            }
            Object.assign(responsePayload, commands);
            log.info(`assembled commands:`, responsePayload);
            log.info(`Sending commands to ${deviceId}: ${JSON.stringify(commands)}`);
        }

        res.status(201).send(responsePayload);
        log.info(`Data recorded for device: ${deviceId}`);
    } catch (error) {
        log.error("Error processing data", error);
        res.status(500).send(error.message);
    }
};
