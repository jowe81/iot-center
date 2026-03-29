import log from '../utils/logger.js';
import { saveLogicalDevicesConfig, logicalDevicesConfig } from '../utils/configUtils.js';
import LogicalDevice from './logicalDevice.js';

const LOG_TAG = '[LogicalDevice]';

/**
 * This type of logical device is a Kasa smart plug and its commands are issued in a special way.
 */
export class LogicalKasaDevice extends LogicalDevice {
    constructor(deviceKey, data, logLevel) {
        super(deviceKey, data, logLevel);
        this.device = data.device;
    }

    /**
     * Issues a command to a Kasa device
     * @param {*} command
     * @param {*} argument
     */
    async sendCommand(command, argument) {
        log.info(`${LOG_TAG} Sending command ${JSON.stringify(command)} to kasa device ${this.deviceKey}`);
        // Implementation specific to KasaDevice
    
        let success = null;

        switch (this.cfg?.type) {
            case 'plug': {
                if (command.on_off !== undefined) {
                    success = await this.device.setPowerState(command.on_off ? true : false);
                    log.debug(
                        `${LOG_TAG} Kasa command to ${this.deviceId} ${success ? "succeeded" : "failed"}: setPowerState(${!!command.setState})`,
                        this.logLevel
                    );
                }
                break;
            }

            case 'light': {
                const kasaCommand = {};

                Object.keys(command).forEach((key) => {
                    switch (key) {
                        case "on_off":
                            kasaCommand.on_off = command.on_off ? 1 : 0;
                            break;

                        case "brightness":
                        case "red":
                        case "green":
                        case "blue":
                            kasaCommand.brightness = command[key];
                            break;
                    }
                });

                const success = await this.device.lighting.setLightState(kasaCommand);
                log.debug(
                    `${LOG_TAG} Kasa command to ${this.deviceId} ${success ? "succeeded" : "failed"}: ${JSON.stringify(kasaCommand)}`,
                    this.logLevel
                );

                break;
            }

            default: {
                log.error(`${LOG_TAG} Unknown device type ${this.type}`, null, this.logLevel);
            }
        }
    }

     async updateConfig() {
         try {
             this.sysInfo = await this.device.getSysInfo();
         } catch (e) {
             log.error(`${LOG_TAG} Failed to read sysInfo from Kasa device ${this.device.alias} (${this.device.id}): ${e.message}`, e, this.logLevel);
             return;
         }
 
         log.debug(`${LOG_TAG} Read sysInfo for ${this.device.alias}: type ${this.sysInfo.mic_type}`, this.logLevel);

         let configChanged = await super.updateConfig();
 
         const deviceKey = this.getKey();
         let logDevCfg = logicalDevicesConfig[deviceKey];
         const device = this.device;
         const sysInfo = this.sysInfo;
 
         if (!logDevCfg.name) {
             logDevCfg.name = device.alias;
             configChanged = true;
         } else if (logDevCfg.name !== device.alias) {
             if (!Array.isArray(logDevCfg.aliases)) {
                 logDevCfg.aliases = [];
             }
             if (!logDevCfg.aliases.includes(device.alias)) {
                 logDevCfg.aliases.push(device.alias);
                 configChanged = true;
             }
         }
 
         if (logDevCfg.category !== 'power') {
             logDevCfg.category = 'power';
             configChanged = true;
         }
 
         if (logDevCfg.driver !== 'kasa') {
             logDevCfg.driver = 'kasa';
             configChanged = true;
         }
 
         if (sysInfo.mic_type === 'IOT.SMARTPLUGSWITCH' && logDevCfg.type !== 'plug') {
             logDevCfg.type = 'plug';
             configChanged = true;
         }
 
         if (sysInfo.mic_type === 'IOT.SMARTBULB' && logDevCfg.type !== 'light') {
             logDevCfg.type = 'light';
             configChanged = true;
         }
 
         if (!logDevCfg.kasa) {
             logDevCfg.kasa = { mic_type: sysInfo.mic_type };
             configChanged = true;
         } else if (logDevCfg.kasa.mic_type !== sysInfo.mic_type) {
             logDevCfg.kasa.mic_type = sysInfo.mic_type;
             configChanged = true;
         }
 
         if (configChanged) {
             await saveLogicalDevicesConfig();
         }

         this.cfg = { ...logDevCfg };
     }
}