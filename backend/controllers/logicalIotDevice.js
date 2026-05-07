import log from '../utils/logger.js';
import LogicalDevice from './logicalDevice.js';
import { saveLogicalDevicesConfig, logicalDevicesConfig } from '../utils/configUtils.js';
import { getDb } from '../config/db.js';
import { addCommand } from './commandService.js';

const LOG_TAG = '[LogicalIotDevice]';

/**
 * This type of logical device is an ESP8266/ESP32 and sends its info via MQTT/HTTP
 */
export class LogicalIotDevice extends LogicalDevice {
    constructor(deviceKey, data, config) {
        super(deviceKey, data, config);
        this._cachedData = null;
        this._cachedReceivedAt = null;
        this._lastDbFetchAttempt = 0;
        this._heartbeatInterval = null;
    }

    /**
     * Powers the IoT device on or off.
     * @param {boolean} isOn
     * @param {number} [heartbeatMs] Optional interval to re-send power state
     */
    async setPowerState(isOn, heartbeatMs) {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }

        await this.sendCommand('setState', isOn);

        if (heartbeatMs) {
            this._heartbeatInterval = setInterval(() => {
                this.sendCommand('setState', isOn).catch(err => {
                    log.error(`Heartbeat failed for ${this.deviceKey}: ${err.message}`, err, this.logLevel);
                });
            }, heartbeatMs);
        }
    }

    /**
     * Returns the actual power state of the IoT device.
     * This method directly queries the database for the 'isOn' state reported by the device.
     * @returns {Promise<boolean | null>} True if on, false if off, null if unknown.
     */
    async getPowerState() {
        try {
            const data = await this.getData();
            if (data && typeof data.isOn === 'boolean') {
                return data.isOn;
            }
            return null;
        } catch (e) {
            log.error(`${LOG_TAG} Error checking power state for ${this.deviceKey}: ${e.message}`, e, this.logLevel);
            return null;
        }
    }

    /**
     * Issues a command to a ESP device
     * @param {string|object} command The command to execute, or an object of commands.
     * @param {*} [argument] The argument for the command, if `command` is a string.
     */
    async sendCommand(command, argument) {
        if (!this.subDeviceName) {
            log.error(`Cannot send command to iot device without a subDeviceName: ${this.deviceKey}`, this.logLevel);
            return;
        }

        let commandPayload;
        if (typeof command === 'object' && command !== null) {
            log.info(`Sending command object to iot device ${this.deviceId}/${this.subDeviceName}: ${JSON.stringify(command)}`, this.logLevel);
            commandPayload = { ...command };
        } else {
            log.info(`Sending command "${command}" with arg ${argument} to iot device ${this.deviceId}/${this.subDeviceName}`, this.logLevel);
            commandPayload = { [command]: argument };
        }

        const commandObj = {
            [this.subDeviceName]: commandPayload
        };

        await addCommand(this.deviceId, commandObj);
    }

    /**
     * Returns the latest processed data for this specific IoT sub-device from the database.
     * This includes any data enriched or calculated by plugins.
     */
    async getData() {
        const THROTTLE_MS = 60000; // 1 minute
        const now = Date.now();
        const staleThreshold = this.config.staleDataThreshold || 300000; // Default to 5 minutes

        const isStale = (timestamp) => timestamp && (now - timestamp.getTime() > staleThreshold);

        // 1. Throttle check: Only query if at least a minute has passed since the last attempt
        if (now - this._lastDbFetchAttempt < THROTTLE_MS) {
            return isStale(this._cachedReceivedAt) ? null : this._cachedData;
        }

        this._lastDbFetchAttempt = now;

        try {
            const db = getDb();
            const collection = db.collection(`device_${this.deviceId}`);

            // 2. Build query to only pull if there's a newer entry than the one in memory
            const query = this._cachedReceivedAt ? { receivedAt: { $gt: this._cachedReceivedAt } } : {};

            const latestDoc = await collection.findOne(
                query,
                { sort: { receivedAt: -1 }, projection: { data: 1, receivedAt: 1 } }
            );

            if (latestDoc) {
                if (isStale(latestDoc.receivedAt)) {
                    return null;
                }

                if (latestDoc.data) {
                    let foundData = null;
                    // Iterate through types and subtypes to find the data for this subDeviceName
                    outer: for (const typeKey in latestDoc.data) {
                        for (const subtypeKey in latestDoc.data[typeKey]) {
                            if (latestDoc.data[typeKey][subtypeKey][this.subDeviceName]) {
                                foundData = latestDoc.data[typeKey][subtypeKey][this.subDeviceName];
                                break outer;
                            }
                        }
                    }
                    
                    if (foundData) {
                        this._cachedData = foundData;
                        this._cachedReceivedAt = latestDoc.receivedAt;
                    }
                }
            }
        } catch (error) {
            log.error(`Error fetching data for logical device ${this.deviceKey}:`, error, this.logLevel);
        }

        return isStale(this._cachedReceivedAt) ? null : this._cachedData;
    }

    async updateConfig() {
        let configChanged = await super.updateConfig();
        const deviceKey = this.getKey();
        const logicalDeviceEntry = logicalDevicesConfig[deviceKey];

        const { typeConfig, latestRawData } = this.data;

        const metrics = Object.keys(typeConfig);

        if (!logicalDeviceEntry.name) {
            logicalDeviceEntry.name = this.subDeviceName;
            configChanged = true;
        }

        if (!logicalDeviceEntry.hardwareName) {
            logicalDeviceEntry.hardwareName = this.subDeviceName;
            configChanged = true;
        }

        switch (latestRawData.type) {
            case "DeviceControl":
                if (logicalDeviceEntry.category !== "power") {
                    logicalDeviceEntry.category = "power";
                    configChanged = true;
                }
                break;

            case "Sensor":
                if (logicalDeviceEntry.category !== "sensor") {
                    logicalDeviceEntry.category = "sensor";
                    configChanged = true;
                }
                break;

            default:
                if (logicalDeviceEntry.category !== "unknown") {
                    logicalDeviceEntry.category = "unknown";
                    configChanged = true;
                }
                break;
        }

        if (!logicalDeviceEntry.type || logicalDeviceEntry.type !== latestRawData.subtype) {
            logicalDeviceEntry.type = latestRawData.subtype;
            configChanged = true;
        }

        if (!logicalDeviceEntry.metrics) {
            logicalDeviceEntry.metrics = [];
        }

        metrics.forEach((metric) => {
            if (!logicalDeviceEntry.metrics.includes(metric)) {
                logicalDeviceEntry.metrics.push(metric);
                configChanged = true;
            }
        });

        if (configChanged) {
            await saveLogicalDevicesConfig();
        }
    }
}