import log from '../utils/logger.js';
import { logicalDevicesConfig } from '../utils/configUtils.js';

const LOG_TAG = '[LogicalDevice]';

/**
 * Represents a logical sub-device of a physical IoT device (e.g., a specific sensor or actuator).
 * This class abstracts the state and identity of a sub-device.
 */
class LogicalDevice {
    /**
     * Every logical device is created from a deviceKey.
     * @param {string} deviceKey The unique key for the device.
     * @param {object} data The initial data object for the device.
     * @param {string} logLevel The logging level.
     */
    constructor(deviceKey, data, logLevel) {
        const parts = deviceKey.split('.');
        this.driver = parts[0];
        this.deviceId = parts[1];
        this.subDeviceName = parts.length > 2 ? parts.slice(2).join('.') : null;
        this.deviceKey = deviceKey;
        this.lastSeen = new Date();
        this.data = data;
        this.logLevel = logLevel;

        log.info(`${LOG_TAG} Created new logical device: ${this.deviceKey}`, logLevel);
    }

    getKey() {
        return this.deviceKey;
    }

    /**
     * Updates the "last seen" timestamp, and logs a keep-alive message
     */
    heartbeat() {
        this.lastSeen = new Date();
        log.debug(`${LOG_TAG} Keep-alive for ${this.getKey()}`, this.logLevel);
    }

    /**
     * Generic command issuing function - this should be overriden
     */
    sendCommand(command, argument) {
        throw new Error("sendCommand must be implemented in derived class.");
    }

    /**
     * Generic data retrieval function - this should be overridden
     */
    async getData() {
        return null;
    }

    /**
     * Generic configuration update function - this should be overridden
     */
    async updateConfig() {
        const deviceKey = this.getKey();
        let logicalDevice = logicalDevicesConfig[deviceKey];
        let configChanged = false;

        if (!logicalDevice) {
            logicalDevicesConfig[deviceKey] = {
                name: null,
                aliases: [],
                driver: this.driver,
                category: null,
                type: null,
            };
            configChanged = true;
        }
        return configChanged;
    }
}

export default LogicalDevice;