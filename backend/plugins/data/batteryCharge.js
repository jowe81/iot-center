/**
 * Battery Charge Plugin
 * Analyzes amperemeter data to determine net charge or discharge of the battery.
 */
import { getValue } from '../../utils/dataUtils.js';
import log from '../../utils/logger.js';

const LOG_TAG = '[Plugin: BatteryCharge]';

export const run = async (deviceId, filteredData, inputs, outputKey, options, db, lastRecord, previousValue) => {
    const logLevel = options.log;
    log.debug(`${LOG_TAG} plugin running for ${deviceId}`, logLevel);

    // inputs contains values for keys defined in config, e.g. { "Sensor.INA219.chargeMeter.power_mW": 1234 }
    const inputKeys = Object.keys(inputs);
    if (inputKeys.length === 0) {
        log.debug(`${LOG_TAG} No input keys, returning 0`, logLevel);
        return 0;
    }
    
    let currentPower_mW = null;
    let currentVoltage_V = null;
    let powerKey = null;
    let voltageKey = null;

    for (const key of inputKeys) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('power')) {
            currentPower_mW = inputs[key];
            powerKey = key;
        } else if (lowerKey.includes('volt')) {
            currentVoltage_V = inputs[key];
            voltageKey = key;
        }
    }

    // Fallback: if only one key and power not found, assume it is power (backward compatibility)
    if (currentPower_mW === null && inputKeys.length === 1) {
        powerKey = inputKeys[0];
        currentPower_mW = inputs[powerKey];
    }

    if (typeof currentPower_mW !== 'number') {
        log.debug(`${LOG_TAG} currentPower_mW is not a number (${currentPower_mW}), returning 0`, logLevel);
        return 0;
    }

    if (!lastRecord) {
        log.debug(`${LOG_TAG} No lastRecord, initializing at 0`, logLevel);
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
    let energyDelta_mWh = avgPower_mW * timeDiffHours;

    if (energyDelta_mWh > 0 && options.efficiencyFactor) {
        energyDelta_mWh *= options.efficiencyFactor;
    }

    let result = previousNetCharge + energyDelta_mWh;

    // Track minimum charge since last reset to prevent rapid cycling of reset logic
    if (options._minNetChargeSinceReset === undefined) {
        options._minNetChargeSinceReset = previousNetCharge;
    }
    // Update min with the current calculated result
    options._minNetChargeSinceReset = Math.min(options._minNetChargeSinceReset, result);

    // Check for full battery reset
    if (options.fullVoltageThreshold && options.tailCurrentPowerThreshold && currentVoltage_V !== null) {
        // Full condition: Charging (power > 0) AND Tapering (power < threshold) AND High Voltage
        if (currentPower_mW > 0 && currentPower_mW < options.tailCurrentPowerThreshold && currentVoltage_V > options.fullVoltageThreshold) {
            let isFull = true;
            
            if (options.fullDurationMinutes > 0) {
                const collection = db.collection(`device_${deviceId}`);
                const historyStartTime = new Date(Date.now() - options.fullDurationMinutes * 60 * 1000);
                
                const historyDocs = await collection.find(
                    { 
                        receivedAt: { $gte: historyStartTime },
                        [`data.${voltageKey}`]: { $exists: true }
                    },
                    {
                        projection: { [`data.${voltageKey}`]: 1 }
                    }
                ).toArray();
                
                if (historyDocs.length > 0) {
                    const sumVoltage = historyDocs.reduce((sum, doc) => sum + (getValue(doc, `data.${voltageKey}`) || 0), 0);
                    const avgVoltage = sumVoltage / historyDocs.length;
                    
                    if (avgVoltage < options.fullVoltageThreshold) {
                        isFull = false;
                    }
                } else {
                    isFull = false; // Not enough history
                }
            }
            
            if (isFull) {
                const dischargeThreshold = options.dischargeThresholdWh || 0;
                // Only reset if we have discharged below the threshold since the last reset
                if (options._minNetChargeSinceReset <= -dischargeThreshold) {
                    log.debug(`${LOG_TAG} Battery full detected and discharge threshold met (${options._minNetChargeSinceReset.toFixed(2)} <= -${dischargeThreshold}). Resetting netCharge to 0.`, logLevel);
                    result = 0;
                    options._minNetChargeSinceReset = 0;
                } else {
                    log.debug(`${LOG_TAG} Battery full detected but discharge threshold NOT met (${options._minNetChargeSinceReset.toFixed(2)} > -${dischargeThreshold}). Not resetting.`, logLevel);
                }
            }
        }
    }

    log.debug(`${LOG_TAG} currentPower_mW=${currentPower_mW}, previousPower_mW=${previousPower_mW}`, logLevel);
    log.debug(`${LOG_TAG} timeDiffHours=${timeDiffHours.toFixed(4)}, avgPower_mW=${avgPower_mW}`, logLevel);
    log.debug(`${LOG_TAG} energyDelta_mWh=${energyDelta_mWh.toFixed(4)}`, logLevel);
    log.debug(`${LOG_TAG} previousNetCharge=${previousNetCharge.toFixed(4)}, newNetCharge=${result.toFixed(4)}`, logLevel);

    return result;
};
