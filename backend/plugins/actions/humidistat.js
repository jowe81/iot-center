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
    const logLevel = options.log || 'info'; // Default to 'info'
    if (logLevel === 'debug') log.debug(`${LOG_TAG} running for device ${options.targetDevice} with value: ${currentValue}`);

    if (currentValue === undefined || currentValue === null || typeof currentValue !== 'number') {
        if (logLevel === 'debug') log.debug(`${LOG_TAG} Invalid current value provided (${currentValue}), exiting.`);
        return;
    }

    const setPoint = options.setPoint || 45;
    const hysteresis = options.hysteresis || 2;

    // Check actual device state
    let actualIsOn = null;
    try {
        const db = getDb();
        const collection = db.collection(`device_${options.targetDevice}`);
        const latestDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });

        if (latestDoc && latestDoc.data) {
            outer:
            for (const type of Object.values(latestDoc.data)) {
                for (const subtype of Object.values(type)) {
                    if (subtype[options.targetSubDevice]) {
                        if (typeof subtype[options.targetSubDevice].isOn === 'boolean') {
                            actualIsOn = subtype[options.targetSubDevice].isOn;
                        }
                        break outer;
                    }
                }
            }
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error checking device state`, e);
        return; // Can't proceed without knowing the actual state
    }

    if (actualIsOn === null) {
        if (logLevel === 'debug') log.debug(`${LOG_TAG} Could not determine actual device state. Exiting.`);
        return;
    }

    if (logLevel === 'debug') {
        log.debug(`${LOG_TAG} Current Humidity: ${currentValue}%, Setpoint: ${setPoint}%, Hysteresis: ${hysteresis}%`);
        log.debug(`${LOG_TAG} Actual device state 'isOn': ${actualIsOn}`);
        log.debug(`${LOG_TAG} Calculated thresholds: ON < ${setPoint - hysteresis}%, OFF > ${setPoint + hysteresis}%`);
    }

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
                if (logLevel === 'debug') {
                    log.debug(`${LOG_TAG} Tank check: level=${tankLevel}, empty_threshold=${tankEmptyThreshold}, refilled_threshold=${tankRefilledThreshold}, lockout=${options._tankEmptyLockout}`);
                }

                // If tank level is above the empty threshold, engage lockout and turn off.
                if (tankLevel > tankEmptyThreshold) {
                    if (options._tankEmptyLockout !== true) {
                        if (logLevel === 'info' || logLevel === 'debug') log.info(`${LOG_TAG} Tank empty detected (level=${tankLevel} > ${tankEmptyThreshold}). Engaging lockout.`);
                        options._tankEmptyLockout = true;
                    }

                    if (actualIsOn === true) {
                        if (logLevel === 'info' || logLevel === 'debug') log.info(`${LOG_TAG} OVERRIDE: Humidifier forced OFF. Reason: Tank empty.`);
                        await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: false } });
                    }
                    return; // Stop all other logic
                }

                // If in lockout, check if tank has been refilled enough to disengage.
                if (options._tankEmptyLockout === true) {
                    if (tankLevel < tankRefilledThreshold) {
                        if (logLevel === 'info' || logLevel === 'debug') log.info(`${LOG_TAG} Tank refilled (level=${tankLevel} < ${tankRefilledThreshold}). Disengaging lockout.`);
                        options._tankEmptyLockout = false;
                        // Now we can proceed to humidity logic
                    } else {
                        // Still in lockout. Ensure device is off and stop.
                        if (logLevel === 'debug') log.debug(`${LOG_TAG} Tank is still in empty lockout. Waiting for level to drop below ${tankRefilledThreshold}.`);
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
        if (logLevel === 'debug') log.debug(`${LOG_TAG} Humidity is within deadband. No state change.`);
        return;
    }

    if (desiredState !== actualIsOn) {
        if (logLevel === 'info' || logLevel === 'debug') {
            log.info(`${LOG_TAG} Humidity ${currentValue}% triggered state change. Switching ${desiredState ? 'ON' : 'OFF'}.`);
        }
        try {
            await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: desiredState } });
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue command`, e);
        }
    } else {
        if (logLevel === 'debug') log.debug(`${LOG_TAG} Desired state (${desiredState}) matches actual state (${actualIsOn}). No command sent.`);
    }
};