import { createRequire } from 'module';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import log from './logger.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');

let logicalDevicesConfig;
try {
    // Note: require() caches the object. Subsequent calls to require() will return the cached object.
    // This is what allows us to modify it in memory and then save it.
    logicalDevicesConfig = require('../config/logicalDevices.json');
} catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
        log.warn('[Config] logicalDevices.json not found, treating as empty.');
    } else {
        log.error('[Config] Failed to load or parse logicalDevices.json, treating as empty.', e);
    }
    logicalDevicesConfig = {};
}
const LOG_TAG = '[Config]';

export const saveConfig = async () => {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const configPath = path.join(__dirname, '../config/iotConfig.json');        
        const replacer = (key, value) => key.startsWith('_') ? undefined : value;
        await fs.writeFile(configPath, JSON.stringify(iotConfig, replacer, 4));
        log.info(`${LOG_TAG} Saved the configuration.`);
    } catch (e) {
        log.error(`${LOG_TAG} Failed to save config: ${e.message}`, e);
    }
};

export const saveLogicalDevicesConfig = async () => {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const configPath = path.join(__dirname, '../config/logicalDevices.json');
        const replacer = (key, value) => key.startsWith('_') ? undefined : value;
        await fs.writeFile(configPath, JSON.stringify(logicalDevicesConfig, replacer, 4));
        log.info(`${LOG_TAG} Saved the logical devices configuration.`);
    } catch (e) {
        log.error(`${LOG_TAG} Failed to save logical devices config: ${e.message}`, e);
    }
};

export { logicalDevicesConfig };