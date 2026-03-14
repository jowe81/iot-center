import TPLink from 'tplink-smarthome-api';
import log from '../utils/logger.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');
const { Client } = TPLink;
const LOG_TAG = '[KasaService]';

const kasaOptions = iotConfig.system?.kasa || {};
const configuredLevel = kasaOptions.logLevel || 'warn';
const myLevels = { debug: 0, info: 1, warn: 2, error: 3 };

const createLibraryLogger = (level) => {
    if (level === false) {
        return () => {};
    }
    
    return (message, ...args) => {
        if (myLevels[level] >= myLevels[configuredLevel]) {
            const fullMessage = [message, ...args].join(' ');
            log[level](`[tplink-smarthome-api] ${fullMessage}`);
        }
    };
};

const logger =
    kasaOptions.log === false
        ? {
              debug: createLibraryLogger(false),
              info: createLibraryLogger(false),
              warn: createLibraryLogger(false),
              error: createLibraryLogger(false),
          }
        : {
              debug: createLibraryLogger("debug"),
              info: createLibraryLogger("info"),
              warn: createLibraryLogger("warn"),
              error: createLibraryLogger("error"),
          };


const client = new Client({logger});

const discoveredDevices = new Map();
const deviceStates = new Map();

const pollDeviceStates = async () => {
    log.debug(`${LOG_TAG} Polling Kasa device states...`);
    for (const device of discoveredDevices.values()) {
        try {
            const sysInfo = await device.getSysInfo();
            const oldState = deviceStates.get(device.id);
            let newState;

            if (device.deviceType === 'plug') {
                newState = sysInfo.relay_state;
                if (oldState !== undefined && oldState !== newState) {
                    log.info(`${LOG_TAG} State change for ${device.alias}: power is now ${newState === 1 ? 'ON' : 'OFF'}.`);
                }
            } else if (device.deviceType === 'bulb') {
                newState = sysInfo.light_state;
                // Deep comparison for object
                if (oldState !== undefined && JSON.stringify(oldState) !== JSON.stringify(newState)) {
                    log.info(`${LOG_TAG} State change for ${device.alias}: light_state is now ${JSON.stringify(newState)}.`);
                }
            }

            // Always update to the latest state to prevent repeated logging of the same change.
            if (newState !== undefined) {
                deviceStates.set(device.id, newState);
            }
        } catch (e) {
            log.error(`${LOG_TAG} Error polling state for ${device.alias}: ${e.message}`);
        }
    }
};

/**
 * Starts the discovery process for TP-Link Kasa devices on the network.
 */
export const initKasaService = () => {
    if (kasaOptions.enabled === false) {
        log.info(`${LOG_TAG} Kasa device discovery disabled.`);
        return;
    }

    log.info(`${LOG_TAG} Starting Kasa device discovery...`);

    client.startDiscovery(kasaOptions?.discoveryOptions || {}).on('device-new', async (device) => {
        log.info(`${LOG_TAG} Discovered Kasa device: ${device.alias} (${device.id}) at ${device.host}`);
        // Index device by its unique device ID. This is static unlike alias or host.
        discoveredDevices.set(device.id, device);

        try {
            const sysInfo = await device.getSysInfo();
            deviceStates.set(device.id, device.deviceType === 'bulb' ? sysInfo.light_state : sysInfo.relay_state);
        } catch (e) {
            log.error(`${LOG_TAG} Could not get initial state for ${device.alias}`, e);
        }
    });

    const pollingInterval = (kasaOptions.pollingIntervalSeconds || 0) * 1000;
    if (pollingInterval > 0) {
        setInterval(pollDeviceStates, pollingInterval);
        log.info(`${LOG_TAG} Started polling for Kasa device state changes every ${pollingInterval / 1000} seconds.`);
    }
};

/**
 * Retrieves a previously discovered device by its ID, alias, or host IP.
 * @param {string} identifier The device ID, alias, or host IP of the device.
 * @returns {Promise<import('tplink-smarthome-api').Device|null>} The device object or null if not found.
 */
export const getKasaDevice = async (identifier) => {
    // First, try to get by unique device ID (which is the map key)
    if (discoveredDevices.has(identifier)) {
        return discoveredDevices.get(identifier);
    }

    // If not found, iterate to find by alias or host for convenience
    for (const device of discoveredDevices.values()) {
        if (device.alias === identifier || device.host === identifier) {
            return device;
        }
    }

    log.warn(`${LOG_TAG} Kasa device "${identifier}" not found in discovered devices cache.`);
    return null;
};

/**
 * Sends a command to a specific Kasa device.
 * @param {string} deviceIdentifier The device ID, alias, or host IP of the target device.
 * @param {string} command The command to execute (e.g., 'plug.setPowerState', 'getSysInfo').
 * @param  {...any} args Arguments for the command.
 * @returns {Promise<any>} The result of the command execution.
 */
export const sendKasaCommand = async (deviceIdentifier, command, ...args) => {
    const device = await getKasaDevice(deviceIdentifier);
    if (!device) {
        log.error(`${LOG_TAG} Cannot send command, Kasa device "${deviceIdentifier}" not found.`);
        return;
    }

    const [mainCmd, subCmd] = command.split('.');

    try {
        // e.g., command is 'plug.setPowerState'
        // mainCmd = 'plug', subCmd = 'setPowerState'
        // device[mainCmd] would be device.plug
        // and we call device.plug.setPowerState(...args)
        const target = subCmd ? device[mainCmd] : device;
        const method = subCmd || mainCmd;

        if (target && typeof target[method] === 'function') {
            log.info(`${LOG_TAG} Sending command "${command}" to Kasa device "${device.alias}".`);
            return await targetmethod;
        } else {
            log.error(`${LOG_TAG} Command "${command}" not found or not a function on Kasa device "${device.alias}".`);
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error sending command "${command}" to Kasa device "${device.alias}"`, e);
    }
};


/**


8|iotcenter  | [INFO]  2026-03-10T03:34:25.046Z - [KasaService] Initial state for Stove Fan:
8|iotcenter  | {
8|iotcenter  |   sw_ver: '1.0.6 Build 220726 Rel.153854',
8|iotcenter  |   hw_ver: '5.0',
8|iotcenter  |   model: 'HS103(US)',
8|iotcenter  |   deviceId: '80061465B741F3D278857FD2F8E09CD020C3200A',
8|iotcenter  |   oemId: '211C91F3C6FA93568D818524FE170CEC',
8|iotcenter  |   hwId: 'B25CBC5351DD892EA69AB42199F59E41',
8|iotcenter  |   rssi: -68,
8|iotcenter  |   latitude_i: 492765,
8|iotcenter  |   longitude_i: -1230400,
8|iotcenter  |   alias: 'Stove Fan',
8|iotcenter  |   status: 'new',
8|iotcenter  |   mic_type: 'IOT.SMARTPLUGSWITCH',
8|iotcenter  |   feature: 'TIM',
8|iotcenter  |   mac: '1C:61:B4:6E:67:16',
8|iotcenter  |   updating: 0,
8|iotcenter  |   led_off: 0,
8|iotcenter  |   relay_state: 1,
8|iotcenter  |   on_time: 495665,
8|iotcenter  |   icon_hash: '',
8|iotcenter  |   dev_name: 'Smart Wi-Fi Plug Mini',
8|iotcenter  |   active_mode: 'none',
8|iotcenter  |   next_action: { type: -1 },
8|iotcenter  |   err_code: 0
8|iotcenter  | }



8|iotcenter  | {
8|iotcenter  |   sw_ver: '1.0.10 Build 210726 Rel.141846',
8|iotcenter  |   hw_ver: '3.0',
8|iotcenter  |   model: 'KL125(US)',
8|iotcenter  |   deviceId: '80124378042EF9B324B75F639D993F9F20F23759',
8|iotcenter  |   oemId: '44560C6D92259EB1042C47EC18943A80',
8|iotcenter  |   hwId: 'CCCEA814DB7786E5A00F65412AAD11CE',
8|iotcenter  |   rssi: -44,
8|iotcenter  |   latitude_i: 492765,
8|iotcenter  |   longitude_i: -1230400,
8|iotcenter  |   alias: 'Hallway',
8|iotcenter  |   status: 'new',
8|iotcenter  |   obd_src: 'tplink',
8|iotcenter  |   description: 'Smart Wi-Fi LED Bulb with Color Changing',
8|iotcenter  |   mic_type: 'IOT.SMARTBULB',
8|iotcenter  |   mic_mac: '9C532287E985',
8|iotcenter  |   dev_state: 'normal',
8|iotcenter  |   is_factory: false,
8|iotcenter  |   disco_ver: '1.0',
8|iotcenter  |   ctrl_protocols: { name: 'Linkie', version: '1.0' },
8|iotcenter  |   active_mode: 'none',
8|iotcenter  |   is_dimmable: 1,
8|iotcenter  |   is_color: 1,
8|iotcenter  |   is_variable_color_temp: 1,
8|iotcenter  |   light_state: {
8|iotcenter  |     on_off: 1,
8|iotcenter  |     mode: 'normal',
8|iotcenter  |     hue: 0,
8|iotcenter  |     saturation: 100,
8|iotcenter  |     color_temp: 2700,
8|iotcenter  |     brightness: 5
8|iotcenter  |   },
8|iotcenter  |   preferred_state: [
8|iotcenter  |     {
8|iotcenter  |       index: 0,
8|iotcenter  |       hue: 0,
8|iotcenter  |       saturation: 0,
8|iotcenter  |       color_temp: 2700,
8|iotcenter  |       brightness: 50
8|iotcenter  |     },
8|iotcenter  |     {
8|iotcenter  |       index: 1,
8|iotcenter  |       hue: 0,
8|iotcenter  |       saturation: 100,
8|iotcenter  |       color_temp: 0,
8|iotcenter  |       brightness: 100
8|iotcenter  |     },
8|iotcenter  |     {
8|iotcenter  |       index: 2,
8|iotcenter  |       hue: 120,
8|iotcenter  |       saturation: 100,
8|iotcenter  |       color_temp: 0,
8|iotcenter  |       brightness: 100
8|iotcenter  |     },
8|iotcenter  |     {
8|iotcenter  |       index: 3,
8|iotcenter  |       hue: 240,
8|iotcenter  |       saturation: 100,
8|iotcenter  |       color_temp: 0,
8|iotcenter  |       brightness: 100
8|iotcenter  |     }
8|iotcenter  |   ],
8|iotcenter  |   err_code: 0
8|iotcenter  | }
 */