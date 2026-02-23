/**
 * Battery Charge Plugin
 * Analyzes amperemeter data to determine net charge or discharge of the battery.
 */
import { getValue } from '../utils/dataUtils.js';
import log from '../utils/logger.js';

const LOG_TAG = '[Plugin: BatteryCharge]';

export const run = async (deviceId, filteredData, inputs, outputKey, options, db, lastRecord, previousValue) => {
    const doLog = options.log === true;
    if (doLog) log.debug(`${LOG_TAG} plugin running for ${deviceId}`);

    // inputs contains values for keys defined in config, e.g. { "Sensor.INA219.chargeMeter.power_mW": 1234 }
    const inputKeys = Object.keys(inputs);
    if (inputKeys.length === 0) {
        if (doLog) log.debug(`${LOG_TAG} No input keys, returning 0`);
        return 0;
    }
    
    // Assume the first input key is the power reading in mW
    const powerKey = inputKeys[0];
    const currentPower_mW = inputs[powerKey];

    if (typeof currentPower_mW !== 'number') {
        if (doLog) log.debug(`${LOG_TAG} currentPower_mW is not a number (${currentPower_mW}), returning 0`);
        return 0;
    }

    if (!lastRecord) {
        if (doLog) log.debug(`${LOG_TAG} No lastRecord, initializing at 0`);
        return 0; // Initialize at 0 if no history
    }

    const previousNetCharge = previousValue || 0;
    const previousPower_mW = getValue(lastRecord, `data.${powerKey}`) || 0;
    const lastTime = lastRecord.receivedAt.getTime();
    const currentTime = filteredData.receivedAt.getTime();
    
    // Calculate time difference in hours
    const timeDiffHours = (currentTime - lastTime) / (1000 * 60 * 60);
    
    // Calculate energy change using Trapezoidal rule: (P_prev + P_curr) / 2 * time
    const avgPower_mW = (previousPower_mW + currentPower_mW) / 2;
    const energyDelta_mWh = avgPower_mW * timeDiffHours;

    const result = previousNetCharge + energyDelta_mWh;

    if (doLog) {
        log.debug(`${LOG_TAG} currentPower_mW=${currentPower_mW}, previousPower_mW=${previousPower_mW}`);
        log.debug(`${LOG_TAG} timeDiffHours=${timeDiffHours.toFixed(4)}, avgPower_mW=${avgPower_mW}`);
        log.debug(`${LOG_TAG} energyDelta_mWh=${energyDelta_mWh.toFixed(4)}`);
        log.debug(`${LOG_TAG} previousNetCharge=${previousNetCharge.toFixed(4)}, newNetCharge=${result.toFixed(4)}`);
    }

    return result;
};
