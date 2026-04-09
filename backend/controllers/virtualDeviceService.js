import { createRequire } from 'module';
import log from '../utils/logger.js';
import { processDeviceMessage } from './iotController.js';
import { getDb } from '../config/db.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');
const LOG_TAG = '[VirtualDeviceService]';

const loadedPlugins = {};

const getPlugin = async (name) => {
    if (loadedPlugins[name]) {
        return loadedPlugins[name];
    }
    // Basic sanitization
    if (!name.match(/^[a-zA-Z0-9_-]+$/)) {
        log.error(`${LOG_TAG} Invalid plugin name requested: ${name}`);
        return null;
    }
    try {
        const plugin = await import(`../plugins/virtualDevices/${name}.js`);
        loadedPlugins[name] = plugin;
        return plugin;
    } catch (e) {
        log.error(`${LOG_TAG} Could not load virtual device plugin "${name}"`, e);
        return null;
    }
};

const runVirtualDevice = async (deviceId, pluginName, config) => {
    log.debug(`${LOG_TAG} Executing virtual device "${deviceId}" using plugin "${pluginName}"`);
    try {
        const plugin = await getPlugin(pluginName);
        if (!plugin || !plugin.run) {
            log.error(`${LOG_TAG} Plugin "${pluginName}" for device "${deviceId}" has no run method.`);
            return;
        }

        const result = await plugin.run(deviceId, getDb(), config);
        if (result) {
            // Ensure deviceId is present in the payload so the processing chain recognizes it
            if (!Array.isArray(result) && !result.deviceId) {
                result.deviceId = deviceId;
            }
            await processDeviceMessage(result, 'VIRTUAL');
        } else {
            log.error(`${LOG_TAG} Virtual device ${deviceId} did not return any data.`);
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error running virtual device "${deviceId}":`, e);
    }
};

export const initVirtualDeviceService = () => {
    const devices = iotConfig.devices || {};
    let virtualDeviceCount = 0;

    for (const [deviceId, config] of Object.entries(devices)) {
        if (config.network?.virtual === true) {
            const pluginName = config.plugin;
            const interval = config.interval || 60000;

            if (!pluginName) {
                log.warn(`${LOG_TAG} Virtual device "${deviceId}" has no plugin defined.`);
                continue;
            }

            log.info(`${LOG_TAG} Initializing virtual device "${deviceId}", running every ${interval}ms`);
            
            // Run once immediately on startup, then schedule
            runVirtualDevice(deviceId, pluginName, config);
            setInterval(() => runVirtualDevice(deviceId, pluginName, config), interval);
            virtualDeviceCount++;
        }
    }

    if (virtualDeviceCount > 0) {
        log.info(`${LOG_TAG} Successfully initialized ${virtualDeviceCount} virtual devices.`);
    }
};