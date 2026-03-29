import log from '../utils/logger.js';
import LogicalDevice from './logicalDevice.js';
import { saveLogicalDevicesConfig, logicalDevicesConfig } from '../utils/configUtils.js';
import { addCommand } from './commandService.js';

/**
 * This type of logical device is an ESP8266/ESP32 and sends its info via MQTT/HTTP
 */
export class LogicalIotDevice extends LogicalDevice {
    constructor(deviceKey, data, logLevel) {
        super(deviceKey, data, logLevel);
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