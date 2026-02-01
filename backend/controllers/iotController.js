const { getDb } = require("../config/db");
const log = require("../utils/logger");
const iotConfig = require("../config/iotConfig.json");

exports.processData = async (req, res) => {
    try {
        // Extract deviceId from the nested system object or root
        const deviceId = req.body.system?.deviceId || req.body.deviceId;

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
            transmissionReason: null,
            data: {},
        };

        // Always keep transmissionReason if present
        if (req.body.transmissionReason) {
            filteredData.transmissionReason = req.body.transmissionReason;
        }

        // Iterate over top-level keys to find typed objects
        for (const [key, value] of Object.entries(req.body)) {
            if (value && typeof value === "object" && value.type && deviceConfig[value.type]) {
                const extracted = {};
                deviceConfig[value.type].forEach((field) => {
                    if (value[field] !== undefined) {
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
                Object.assign(commands, cmd.command);
                // Mark as sent
                await commandCollection.updateOne({ _id: cmd._id }, { $set: { status: 'sent', sentAt: new Date() } });
            }
            Object.assign(responsePayload, commands);
            log.info(`Sending commands to ${deviceId}: ${JSON.stringify(commands)}`);
        }

        res.status(201).send(responsePayload);
        log.info(`Data recorded for device: ${deviceId}`);
    } catch (error) {
        log.error("Error processing data", error);
        res.status(500).send(error.message);
    }
};
