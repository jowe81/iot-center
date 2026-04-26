import log from '../../utils/logger.js';
import { addCommand } from '../../controllers/commandService.js';
import { getDb } from '../../config/db.js';

const LOG_TAG = '[Action: Thermostat]';

/**
 * Checks the database for the current 'isOn' state of the target device.
 */
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
                        return null;
                    }
                }
            }
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error checking furnace state`, e);
        throw e;
    }
    return null;
};

/**
 * Calculates the current setpoint based on scheduled slots in options.
 */
const getScheduledSetpoint = (options, logLevel) => {
    const schedules = [];
    const allProvidedTemps = [];
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

    for (let i = 1; i <= 4; i++) {
        const temp = options[`targetTemp${i}`];
        const time = options[`activationTime${i}`];

        if (typeof temp === 'number') {
            allProvidedTemps.push(temp);
            if (typeof time === 'string' && timeRegex.test(time)) {
                schedules.push({ temp, time });
            }
        }
    }

    // If no timed schedules exist
    if (schedules.length === 0) {
        // Fallback: If exactly one target temp is provided, use it for 24h
        if (allProvidedTemps.length === 1) return { temp: allProvidedTemps[0], time: 'always' };
        return null; // Inactive
    }

    if (schedules.length === 1) return schedules[0];

    // Sort schedules chronologically
    schedules.sort((a, b) => a.time.localeCompare(b.time));

    const now = new Date();
    const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Find the current active schedule (the latest one that has already passed)
    // Default to the last schedule of the day (handles wrap-around past midnight)
    let active = schedules[schedules.length - 1];
    for (const s of schedules) {
        if (nowStr >= s.time) active = s;
        else break;
    }
    return active;
};

/**
 * Compares current temperature to setpoint and controls furnace relay.
 * @param {*} currentValue The temperature read from the sourceKey.
 * @param {object} options The configuration options.
 */
export const run = async (currentValue, options) => {
    const logLevel = options.log;
    log.debug(`${LOG_TAG} running for device ${options.targetDevice} with temp: ${currentValue}`, logLevel);

    if (currentValue === undefined || currentValue === null || typeof currentValue !== 'number') {
        log.debug(`${LOG_TAG} Invalid temperature provided (${currentValue}), exiting.`, logLevel);
        return;
    }

    const activeSchedule = getScheduledSetpoint(options, logLevel);
    const scheduledTemp = activeSchedule ? activeSchedule.temp : null;
    const scheduledTime = activeSchedule ? activeSchedule.time : null;

    const hysteresis = options.hysteresis || 0.5; // Default 0.5 degree deadband
    const pushCommand = options.pushCommand || 'onStateChange';

    // Schedule Override Logic: 
    // If the active schedule slot has changed since the last run, 
    // we force the currentTargetTemp to match the new scheduled temperature.
    if (scheduledTime !== options._lastScheduledTime) {
        log.info(`${LOG_TAG} Schedule transition to ${scheduledTime} detected. Updating target temp to ${scheduledTemp}°C`, logLevel);
        options.currentTargetTemp = scheduledTemp;
        options._lastScheduledTime = scheduledTime;
    }

    const setPoint = options.currentTargetTemp;

    if (setPoint === null) {
        log.debug(`${LOG_TAG} No active target temperature scheduled. Thermostat is inactive.`, logLevel);
        return;
    }

    let actualIsOn;
    try {
        actualIsOn = await getActualIsOn(options);
    } catch (e) {
        log.error(`${LOG_TAG} Could not check furnace state, aborting run.`, logLevel);
        return;
    }

    if (actualIsOn === null) {
        log.debug(`${LOG_TAG} Could not determine actual furnace state. Exiting.`, logLevel);
        return;
    }

    log.debug(`${LOG_TAG} Current Temp: ${currentValue}°, Setpoint: ${setPoint}°, Hysteresis: ${hysteresis}°`, logLevel);
    log.debug(`${LOG_TAG} Calculated thresholds: ON < ${setPoint - hysteresis}°, OFF > ${setPoint + hysteresis}°`, logLevel);

    let desiredState;
    if (currentValue < (setPoint - hysteresis)) {
        // Too cold, turn furnace ON
        desiredState = true;
    } else if (currentValue > (setPoint + hysteresis)) {
        // Warm enough, turn furnace OFF
        desiredState = false;
    } else {
        // Within deadband: keep current state
        desiredState = actualIsOn;
        log.debug(`${LOG_TAG} Temperature is within deadband. Maintaining current state: ${desiredState}`, logLevel);
    }

    const shouldSend = (pushCommand === 'always') || (desiredState !== actualIsOn);

    if (shouldSend) {
        log.info(`${LOG_TAG} Issuing furnace command: ${desiredState ? 'ON' : 'OFF'} (Mode: ${pushCommand}, Temp: ${currentValue}°)`, logLevel);
        try {
            await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: desiredState } });
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue furnace command`, e);
        }
    } else {
        log.debug(`${LOG_TAG} Desired state (${desiredState}) matches actual state. No command sent.`, logLevel);
    }
};

/**
 * Shutdown procedure for the thermostat action.
 */
export const stop = async (options) => {
    const logLevel = options.log;
    log.info(`${LOG_TAG} Stop called for ${options.targetDevice}. Safety check to turn off furnace.`, logLevel);

    try {
        const actualIsOn = await getActualIsOn(options);

        if (actualIsOn === true) {
            log.info(`${LOG_TAG} Furnace is ON. Queuing OFF command for safety.`, logLevel);
            await addCommand(options.targetDevice, { [options.targetSubDevice]: { setState: false } });
        } else {
            log.debug(`${LOG_TAG} Furnace is already OFF or state is unknown.`, logLevel);
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error during stop procedure for ${options.targetDevice}.`, e);
    }
};