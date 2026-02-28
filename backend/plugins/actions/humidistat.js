import log from '../../utils/logger.js';
import { addCommand } from '../../controllers/commandService.js';

const LOG_TAG = '[Action: Humidistat]';

/**
 * Reads a humidity value and issues a command to a humidifier based on setpoint.
 * @param {*} currentValue The value read from the sourceKey.
 * @param {object} options The options block from the action configuration.
 */
export const run = async (currentValue, options) => {
    const doLog = options.log === true;
    if (doLog) log.debug(`${LOG_TAG} running with value: ${currentValue}`);

    if (currentValue === undefined || currentValue === null || typeof currentValue !== 'number') {
        if (doLog) log.debug(`${LOG_TAG} Invalid current value provided, exiting.`);
        return;
    }

    const setPoint = options.setPoint || 45;
    const hysteresis = options.hysteresis || 2;

    let desiredState = options._lastState;

    if (currentValue < (setPoint - hysteresis)) {
        desiredState = true;
    } else if (currentValue > (setPoint + hysteresis)) {
        desiredState = false;
    }

    if (desiredState === undefined) {
        desiredState = false;
    }

    if (options._lastState !== desiredState) {
        if (doLog) {
            log.debug(`${LOG_TAG} Humidity ${currentValue}% (Set: ${setPoint}, Hyst: ${hysteresis}). Switching ${desiredState ? 'ON' : 'OFF'}.`);
        }

        try {
            await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: desiredState } });
            options._lastState = desiredState;
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue command`, e);
        }
    }
};