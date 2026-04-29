import log from '../utils/logger.js';
import LogicalDevice from './logicalDevice.js';
import { getDb } from '../config/db.js';
import { getValue } from '../utils/dataUtils.js';
import { saveLogicalDevicesConfig, logicalDevicesConfig } from '../utils/configUtils.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * This type of logical device represents the output or state of a plugin.
 */
export class LogicalPluginDevice extends LogicalDevice {
    constructor(deviceKey, data, config) {
        super(deviceKey, data, config);
        this.pluginName = config.pluginName;
        this.actionName = config.actionName;
        this.logicalDeviceKey = config.logicalDeviceKey;
        this.targetDeviceId = config.targetDeviceId;
        this.outputKey = config.outputKey;

        this._cachedData = null;
        this._cachedReceivedAt = null;
        this._lastDbFetchAttempt = 0;
        log.info(`[LogicalPluginDevice] Created new logical plugin device: ${this.deviceKey} for action ${this.actionName}`, this.logLevel);
    }

    /**
     * Returns the current configuration (options) of the associated action plugin.
     */
    async getData() {
        if (this.actionName) {
            try {
                const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/iotConfig.json');
                const configContent = await fs.readFile(configPath, 'utf8');
                const config = JSON.parse(configContent);
                const action = config.actions?.find(a => a.name === this.actionName);
                
                if (action) {
                    return action.options;
                }
            } catch (error) {
                log.error(`[LogicalPluginDevice] Error reading config for ${this.deviceKey}:`, error, this.logLevel);
            }
        }

        // Fallback for devices that also track plugin output data in the database
        if (!this.targetDeviceId || !this.outputKey) return null;

        const THROTTLE_MS = 60000; // 1 minute
        const now = Date.now();
        // Use staleDataThreshold from logicalDeviceManager config, or default to 5 minutes
        const staleThreshold = this.config.staleDataThreshold || 300000;

        const isStale = (timestamp) => timestamp && (now - timestamp.getTime() > staleThreshold);

        // 1. Throttle check: Only query if at least a minute has passed since the last attempt
        if (now - this._lastDbFetchAttempt < THROTTLE_MS) {
            return isStale(this._cachedReceivedAt) ? null : this._cachedData;
        }

        this._lastDbFetchAttempt = now;

        try {
            const db = getDb();
            const collection = db.collection(`device_${this.targetDeviceId}`);

            // 2. Build query to only pull if there's a newer entry than the one in memory
            const query = this._cachedReceivedAt ? { receivedAt: { $gt: this._cachedReceivedAt } } : {};

            const latestDoc = await collection.findOne(
                query,
                { sort: { receivedAt: -1 }, projection: { [this.outputKey]: 1, receivedAt: 1 } }
            );

            if (latestDoc) {
                if (isStale(latestDoc.receivedAt)) {
                    return null;
                }

                const foundData = getValue(latestDoc, this.outputKey);
                if (foundData !== undefined) {
                    this._cachedData = foundData;
                    this._cachedReceivedAt = latestDoc.receivedAt;
                }
            }
        } catch (error) {
            log.error(`[LogicalPluginDevice] Error fetching data for logical plugin device ${this.deviceKey}:`, error, this.logLevel);
        }

        return isStale(this._cachedReceivedAt) ? null : this._cachedData;
    }

    async sendCommand(command, argument) {
        log.info(`[LogicalPluginDevice] Received command '${command}' for ${this.deviceKey}`, this.logLevel);

        let optionKey;
        let newValue = argument;

        // Map commands to configuration options
        if (command === 'setTargetTemp') optionKey = 'currentTargetTemp';
        else if (command === 'setSetpoint') optionKey = 'setPoint';
        else if (command === 'setOption' && typeof argument === 'object') {
            optionKey = argument.key;
            newValue = argument.value;
        }

        if (!optionKey) {
            throw new Error(`Command '${command}' is not supported or missing arguments.`);
        }

        try {
            const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/iotConfig.json');
            const configContent = await fs.readFile(configPath, 'utf8');
            const config = JSON.parse(configContent);

            const action = config.actions?.find(a => a.name === this.actionName);

            if (!action) {
                throw new Error(`Plugin action '${this.actionName}' not found in configuration.`);
            }

            action.options[optionKey] = newValue;

            await fs.writeFile(configPath, JSON.stringify(config, null, 4));
            log.info(`[LogicalPluginDevice] Updated '${this.actionName}' option '${optionKey}' to ${newValue}`);
            return { success: true, updated: optionKey, value: newValue };
        } catch (error) {
            log.error(`[LogicalPluginDevice] Failed to update action configuration:`, error);
            throw error;
        }
    }

    async updateConfig() {
        let configChanged = await super.updateConfig();
        const deviceKey = this.getKey();
        let logicalDeviceEntry = logicalDevicesConfig[deviceKey];

        if (!logicalDeviceEntry.name) {
            logicalDeviceEntry.name = this.actionName || this.pluginName;
            configChanged = true;
        }
        if (logicalDeviceEntry.category !== "plugin") { logicalDeviceEntry.category = "plugin"; configChanged = true; }
        if (logicalDeviceEntry.type !== this.pluginName) { logicalDeviceEntry.type = this.pluginName; configChanged = true; }
        if (logicalDeviceEntry.driver !== "plugin") { logicalDeviceEntry.driver = "plugin"; configChanged = true; }
        // Store plugin-specific config for later retrieval if needed
        const pluginConfig = { targetDeviceId: this.targetDeviceId, outputKey: this.outputKey, actionName: this.actionName, logicalDeviceKey: this.logicalDeviceKey };
        if (JSON.stringify(logicalDeviceEntry.pluginConfig) !== JSON.stringify(pluginConfig)) {
            logicalDeviceEntry.pluginConfig = pluginConfig;
            configChanged = true;
        }

        if (configChanged) {
            await saveLogicalDevicesConfig();
        }
        return configChanged;
    }
}