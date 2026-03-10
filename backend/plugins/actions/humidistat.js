import log from '../../utils/logger.js';
import { addCommand } from '../../controllers/commandService.js';
import { getDb } from '../../config/db.js';
import { getValue } from '../../utils/dataUtils.js';

const LOG_TAG = '[Action: Humidistat]';

const getActualIsOn = async (options) => {
    try {
        const db = getDb();
        const collection = db.collection(`device_${options.targetDevice}`);
        const latestDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });

        if (latestDoc && latestDoc.data) {
            for (const type of Object.values(latestDoc.data)) {
                for (const subtype of Object.values(type)) {
                    const subDeviceData = subtype[options.targetSubDevice];
                    if (subDeviceData) {
                        if (typeof subDeviceData.isOn === 'boolean') {
                            return subDeviceData.isOn;
                        }
                        // Found the subdevice, but no 'isOn' boolean. Stop searching.
                        return null;
                    }
                }
            }
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error checking device state`, e);
        throw e;
    }
    return null;
};

/**
 * Reads a humidity value and issues a command to a humidifier based on setpoint.
 * @param {*} currentValue The value read from the sourceKey.
 * @param {object} options The options block from the action configuration.
 */
export const run = async (currentValue, options) => {
    const logLevel = options.log;
    log.debug(`${LOG_TAG} running for device ${options.targetDevice} with value: ${currentValue}`, logLevel);

    if (currentValue === undefined || currentValue === null || typeof currentValue !== 'number') {
        log.debug(`${LOG_TAG} Invalid current value provided (${currentValue}), exiting.`, logLevel);
        return;
    }

    const setPoint = options.setPoint || 45;
    const hysteresis = options.hysteresis || 2;

    // Check actual device state
    let actualIsOn;
    try {
        actualIsOn = await getActualIsOn(options);
    } catch (e) {
        log.error(`${LOG_TAG} Could not check device state, aborting run.`, logLevel);
        return; // Can't proceed without knowing the actual state
    }

    if (actualIsOn === null) {
        log.debug(`${LOG_TAG} Could not determine actual device state. Exiting.`, logLevel);
        return;
    }

    log.debug(`${LOG_TAG} Current Humidity: ${currentValue}%, Setpoint: ${setPoint}%, Hysteresis: ${hysteresis}%`, logLevel);
    log.debug(`${LOG_TAG} Actual device state 'isOn': ${actualIsOn}`, logLevel);
    log.debug(`${LOG_TAG} Calculated thresholds: ON < ${setPoint - hysteresis}%, OFF > ${setPoint + hysteresis}%`, logLevel);

    // Check tank level override first
    if (options.tankDevice && options.tankKey && options.tankEmptyThreshold !== undefined) {
        const tankEmptyThreshold = options.tankEmptyThreshold;
        const tankRefilledThreshold = options.tankRefilledThreshold ?? (tankEmptyThreshold - 10);

        try {
            const db = getDb();
            const collection = db.collection(`device_${options.tankDevice}`);
            const latestTankDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });
            const tankLevel = getValue(latestTankDoc, options.tankKey);

            if (typeof tankLevel === 'number') {
                log.debug(`${LOG_TAG} Tank check: level=${tankLevel}, empty_threshold=${tankEmptyThreshold}, refilled_threshold=${tankRefilledThreshold}, lockout=${options._tankEmptyLockout}`, logLevel);

                // If tank level is above the empty threshold, engage lockout and turn off.
                if (tankLevel > tankEmptyThreshold) {
                    if (options._tankEmptyLockout !== true) {
                        log.info(`${LOG_TAG} Tank empty detected (level=${tankLevel} > ${tankEmptyThreshold}). Engaging lockout.`, logLevel);
                        options._tankEmptyLockout = true;
                    }

                    if (actualIsOn === true) {
                        log.info(`${LOG_TAG} OVERRIDE: Humidifier forced OFF. Reason: Tank empty.`, logLevel);
                        await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: false } });
                    }
                    return; // Stop all other logic
                }

                // If in lockout, check if tank has been refilled enough to disengage.
                if (options._tankEmptyLockout === true) {
                    if (tankLevel < tankRefilledThreshold) {
                        log.info(`${LOG_TAG} Tank refilled (level=${tankLevel} < ${tankRefilledThreshold}). Disengaging lockout.`, logLevel);
                        options._tankEmptyLockout = false;
                        // Now we can proceed to humidity logic
                    } else {
                        // Still in lockout. Ensure device is off and stop.
                        log.debug(`${LOG_TAG} Tank is still in empty lockout. Waiting for level to drop below ${tankRefilledThreshold}.`, logLevel);
                        if (actualIsOn === true) {
                            // This might be redundant if the previous check already turned it off, but it's a good safeguard.
                            await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: false } });
                        }
                        return; // Stop all other logic
                    }
                }
            }
        } catch (e) {
            log.error(`${LOG_TAG} Error checking tank level`, e);
        }
    }

    let desiredState;
    if (currentValue < (setPoint - hysteresis)) {
        desiredState = true;
    } else if (currentValue > (setPoint + hysteresis)) {
        desiredState = false;
    } else {
        log.debug(`${LOG_TAG} Humidity is within deadband. No state change.`, logLevel);
        return;
    }

    if (desiredState !== actualIsOn) {
        log.info(`${LOG_TAG} Humidity ${currentValue}% triggered state change. Switching ${desiredState ? 'ON' : 'OFF'}.`, logLevel);
        try {
            await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: desiredState } });
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue command`, e);
        }
    } else {
        log.debug(`${LOG_TAG} Desired state (${desiredState}) matches actual state (${actualIsOn}). No command sent.`, logLevel);
    }
};

/**
 * Runs when the action is disabled to perform cleanup.
 * @param {object} options The options block from the action configuration.
 */
export const stop = async (options) => {
    const logLevel = options.log;
    log.info(`${LOG_TAG} Stop called for ${options.targetDevice}. Checking if it needs to be turned off.`, logLevel);

    try {
        const actualIsOn = await getActualIsOn(options);

        if (actualIsOn === true) {
            log.info(`${LOG_TAG} Device is currently ON. Queuing OFF command for cleanup.`, logLevel);
            await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: false } });
        } else {
            log.debug(`${LOG_TAG} Device is not ON or state is unknown. No cleanup command needed.`, logLevel);
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error during stop procedure for ${options.targetDevice}.`, e);
    }
};