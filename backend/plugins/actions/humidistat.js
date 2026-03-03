import log from '../../utils/logger.js';
import { addCommand } from '../../controllers/commandService.js';
import { getDb } from '../../config/db.js';
import { getValue } from '../../utils/dataUtils.js';

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

    let shouldSend = false;
    let reason = '';

    // Check tank level override if configured
    if (options.tankDevice && options.tankKey && options.tankThreshold !== undefined) {
        try {
            const db = getDb();
            const collection = db.collection(`device_${options.tankDevice}`);
            const latestTankDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });
            const tankLevel = getValue(latestTankDoc, options.tankKey);
            
            if (typeof tankLevel === 'number') {
                // User specified: >70 is empty. Turn off if empty.
                if (tankLevel > options.tankThreshold) {
                    desiredState = false;
                    reason = `Tank empty (${tankLevel})`;
                }
            }
        } catch (e) {
            log.error(`${LOG_TAG} Error checking tank level`, e);
        }
    }

    if (options._lastState !== desiredState) {
        shouldSend = true;
        reason = 'State changed';
    } else if (desiredState === true) {
        // Enforce ON state if device reports OFF
        try {
            const db = getDb();
            const collection = db.collection(`device_${options.targetDevice}`);
            const latestDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });
            
            if (latestDoc && latestDoc.data) {
                // Find subdevice in data structure: data.Type.Subtype.Name
                outer:
                for (const type of Object.values(latestDoc.data)) {
                    for (const subtype of Object.values(type)) {
                        if (subtype[options.targetSubDevice]) {
                            if (subtype[options.targetSubDevice].isOn === false) {
                                shouldSend = true;
                                reason = 'Enforcing ON state';
                            }
                            break outer;
                        }
                    }
                }
            }
        } catch (e) {
            log.error(`${LOG_TAG} Error checking device state`, e);
        }
    }

    if (shouldSend) {
        if (doLog) {
            log.debug(`${LOG_TAG} Humidity ${currentValue}% (Set: ${setPoint}, Hyst: ${hysteresis}). Switching ${desiredState ? 'ON' : 'OFF'}. Reason: ${reason}`);
        }

        try {
            await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: desiredState } });
            options._lastState = desiredState;
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue command`, e);
        }
    }
};