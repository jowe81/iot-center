import { createRequire } from 'module';
import LogicalDevice from './logicalDevice.js';
import { LogicalIotDevice } from './logicalIotDevice.js';
import { LogicalKasaDevice } from './logicalKasaDevice.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');
const logicalDevices = new Map();

const managerConfig = iotConfig.system?.logicalDeviceManager || {};
export const getDeviceByKey = (deviceKey) => {
    if (!deviceKey) {
        return null;
    }
    return logicalDevices.get(deviceKey);
};

/**
 * Finds an existing logical device and calls its update method, or creates a new one if not found.
 * @param {string} deviceKey The unique key for the device (e.g., 'kasa.DEVICEID' or 'iot.DEVICEID.SUBDEVICE').
 * @param {object} data The data payload for the sub-device.
 */
export const updateOrCreateDevice = async (deviceKey, data) => {
    if (!deviceKey) return;

    const existingDevice = logicalDevices.get(deviceKey);
    if (existingDevice) {
        existingDevice.heartbeat();
    } else {
        const parts = deviceKey.split('.');
        if (parts.length < 2) return;

        const driver = parts[0];

        let newDevice;
        switch (driver) {
            case 'iot':
                newDevice = new LogicalIotDevice(deviceKey, data, managerConfig);
                break;
            case 'kasa':
                newDevice = new LogicalKasaDevice(deviceKey, data, managerConfig);
                break;
            default:
                newDevice = new LogicalDevice(deviceKey, data, managerConfig);
                break;
        }
        
        logicalDevices.set(deviceKey, newDevice);
        await newDevice.updateConfig();
    }
};