/**
 * Woodstove State Plugin
 * Analyzes temperature data to determine woodstove running mode.
 */
import { getValue } from '../../utils/dataUtils.js';
import log from '../../utils/logger.js';

const LOG_TAG = '[Plugin: WoodstoveState]';

export const run = async (deviceId, filteredData, inputs, outputKey, options, db, lastRecord, previousValue) => {
    // Helper function for linear regression slope calculation
    const calculateLinearRegressionSlope = (dataPoints, windowMs, endTime) => {
        const windowStart = endTime - windowMs;
        const relevantPoints = dataPoints.filter(p => p.time >= windowStart && p.time <= (endTime || Date.now()));
    
        if (relevantPoints.length < 2) {
            return 0;
        }
    
        const n = relevantPoints.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        const t0 = relevantPoints[0].time; // Use the first point in the relevant window as reference
    
        for (const p of relevantPoints) {
            const x = (p.time - t0) / 60000; // minutes
            const y = p.val;
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumXX += x * x;
        }
        
        const denominator = (n * sumXX - sumX * sumX);
        return denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;
    };

    const logLevel = options.log;
    log.debug(`${LOG_TAG} Plugin running for ${deviceId}`, logLevel);

    // inputs contains values for keys defined in config
    const inputKeys = Object.keys(inputs);
    if (inputKeys.length === 0) {
        log.debug(`${LOG_TAG} No input keys, returning "off"`, logLevel);
        return "off";
    }

    // Assume the first input key is the temperature
    const tempKey = inputKeys[0];
    const currentTemp = inputs[tempKey];

    if (typeof currentTemp !== 'number') {
        log.debug(`${LOG_TAG} currentTemp is not a number (${currentTemp}), returning "off"`, logLevel);
        return "off";
    }

    let previousState = previousValue || 'off';
    previousState = previousState.toLowerCase();
    log.debug(`${LOG_TAG} currentTemp=${currentTemp}, previousState=${previousState}`, logLevel);

    // Configuration
    const HISTORY_MINUTES = options.historyMinutes || 60;
    const SLOPE_WINDOW_MINUTES = options.slopeWindowMinutes || 10;
    let AMBIENT_TEMP = options.ambientTemp || 22;

    if (inputKeys.length > 1) {
        const ambientKey = inputKeys[1];
        const liveAmbient = inputs[ambientKey];
        if (typeof liveAmbient === 'number') {
            AMBIENT_TEMP = liveAmbient;
            log.debug(`${LOG_TAG} Using live ambient temp: ${AMBIENT_TEMP}`, logLevel);
        }
    }

    const REFUEL_LOCKOUT_MINUTES = options.refuelLockoutMinutes ?? 10;
    
    // Thresholds (Slope in deg/min, Drops in %)
    const RISE_SLOPE_THRESHOLD = options.riseThreshold || 0.15;
    const DROP_SLOPE_THRESHOLD = options.dropThreshold || -0.2;
    const RELATIVE_DROP_REFUEL = options.relativeDropRefuel || 0.10; // 10% drop from peak
    const REFUEL_RECOVERY_DERIVATIVE = options.refuelRecoveryDerivative || 0.07;
    const RUNNING_TEMP_THRESHOLD = options.runningTempThreshold || 35;
    const OFF_TEMP_THRESHOLD = AMBIENT_TEMP + 2; // Temp considered 'off'

    const historyCutoff = Date.now() - (HISTORY_MINUTES * 60 * 1000);
    let points = options._points;

    // If history is not in memory, it's the first run or a restart. Fetch from DB.
    if (!points) {
        log.debug(`${LOG_TAG} No history in memory, fetching from DB. Cutoff: ${new Date(historyCutoff).toISOString()}}`, logLevel);
        const collection = db.collection(`device_${deviceId}`);
        const historyStartTime = new Date(historyCutoff);
        
        // Fetch the most recent documents to build the initial history.
        // We sort descending to get the latest ones first, then reverse the array
        // to have them in correct chronological order for processing.
        const historyDocs = await collection.find(
            { 
                [`data.${tempKey}`]: { $exists: true },
                receivedAt: { $gte: historyStartTime }
            },
            {
                sort: { receivedAt: -1 },
                // Limit to a reasonable number, e.g., ~15 minutes of data if records are every 5s.
                limit: 500, 
                projection: { receivedAt: 1, [`data.${tempKey}`]: 1, [`data.${outputKey}`]: 1 }
            }
        ).toArray();
        historyDocs.reverse(); // Put back in ascending time order.

        points = historyDocs.map(doc => ({
            time: doc.receivedAt.getTime(),
            val: getValue(doc, `data.${tempKey}`),
            state: getValue(doc, `data.${outputKey}`)
        })).filter(p => typeof p.val === 'number');

        log.debug(`${LOG_TAG} Fetched ${points.length} points from DB.`, logLevel);
        
        // Initialize slopes history from fetched points
        if (points.length > 0) {
            let initialSlopes = [];
            // Iterate through the fetched points to calculate historical slopes
            for (let i = 0; i < points.length; i++) {
                const slopeForPoint = calculateLinearRegressionSlope(points, SLOPE_WINDOW_MINUTES, points[i].time);
                initialSlopes.push({ time: points[i].time, val: slopeForPoint });
            }
            options._slopes = initialSlopes;
        }
    }

    // Add current point
    points.push({ time: Date.now(), val: currentTemp });

    // Prune old points to keep the history window fixed
    const oldPointsLength = points.length;
    points = points.filter(p => p.time >= historyCutoff);
    if (oldPointsLength > points.length) {
        log.debug(`${LOG_TAG} Pruned ${oldPointsLength - points.length} old point(s) from history.`, logLevel);
    }

    // Persist for next run
    options._points = points;

    // Calculate Slope (Linear Regression over last SLOPE_WINDOW_MINUTES)
    const slopeWindowMs = SLOPE_WINDOW_MINUTES * 60 * 1000;
    const slope = calculateLinearRegressionSlope(points, slopeWindowMs, Date.now());

    // Calculate Slope Derivative (Rate of change of the slope)
    // This helps detect if the cooling is slowing down (acceleration)
    let slopes = options._slopes || [];
    slopes.push({ time: Date.now(), val: slope });
    
    // Keep slope history same window as slope calculation
    const slopeHistoryCutoff = Date.now() - slopeWindowMs;
    slopes = slopes.filter(p => p.time >= slopeHistoryCutoff);
    options._slopes = slopes;

    // Reuse helper for second derivative
    const slopeDerivative = calculateLinearRegressionSlope(slopes, slopeWindowMs, Date.now());

    // Calculate Max Temp in the history window (local peak)
    const maxTemp = Math.max(...points.map(p => p.val));
    log.debug(`${LOG_TAG} slope=${slope.toFixed(2)}, derivative=${slopeDerivative.toFixed(4)}, maxTemp=${maxTemp.toFixed(2)}, currentTemp=${currentTemp}`, logLevel);

    const tempIsRising = slope > RISE_SLOPE_THRESHOLD;
    const tempIsFalling = slope < DROP_SLOPE_THRESHOLD;
    const tempIsSteady = !(tempIsRising || tempIsFalling);

    const tempIsSignificantlyAboveAmbient = currentTemp > OFF_TEMP_THRESHOLD;

    // If the peak is relatively close to the running threshold, it likely means the temperature has been falling
    // very slowly for a long time (slow burn wet wood). In this case the required relative drop to switch back to
    // refuel should be lowered. Also the threshold for the slope derivative (acceleration) should be more lenient.
    // All this to make sure the state change doesn't come too late.
    let effectiveRelativeDrop = RELATIVE_DROP_REFUEL;
    let effectiveDerivativeThreshold = 0;
    if (maxTemp < RUNNING_TEMP_THRESHOLD + 10) {
        effectiveRelativeDrop = RELATIVE_DROP_REFUEL / 2;
        effectiveDerivativeThreshold = 0.1;
    }

    const tempHasDroppedSignificantlyFromPeak = currentTemp < maxTemp * (1 - effectiveRelativeDrop);
    const tempDropIsAccelerating = slopeDerivative < effectiveDerivativeThreshold;

    const tempIsAboveRunningThreshold = currentTemp > RUNNING_TEMP_THRESHOLD;
    const tempDropIsSlowing = slopeDerivative > REFUEL_RECOVERY_DERIVATIVE;


    let newState = previousState;

    switch (previousState) {
        case "off": 
            // Only transition to 'warmup' is allowed.
            // Condition: Temp is rising and above ambient.
            if (tempIsSignificantlyAboveAmbient && tempIsRising) {
                newState = "warmup";
                log.debug(`${LOG_TAG} Transition from off to warmup triggered. Reasons:`, logLevel);
                if (tempIsSignificantlyAboveAmbient) {
                    log.debug(`  - Temp is significantly above ambient: ${currentTemp.toFixed(2)} > ${AMBIENT_TEMP.toFixed(2)} + 2`, logLevel);
                }
                if (tempIsRising) {
                    log.debug(`  - Temp is rising: slope > ${RISE_SLOPE_THRESHOLD}`, logLevel);
                }
            }
            break;

        case "warmup":
            // To 'running': Temp has passed the running threshold.
            if (tempIsAboveRunningThreshold && tempIsRising) {
                newState = "running";
                log.debug(`${LOG_TAG} Transition from warmup to running triggered. Reasons:`, logLevel);
                if (tempIsAboveRunningThreshold) {
                    log.debug(`  - Temp is above running threshold: ${currentTemp.toFixed(2)} > ${RUNNING_TEMP_THRESHOLD}`, logLevel);
                }
                if (tempIsRising) {
                    log.debug(`  - Temp is rising: slope > ${RISE_SLOPE_THRESHOLD}`, logLevel);
                }
            }
            // To 'cooldown': Temp is dropping (fire went out).
            else if (!tempIsAboveRunningThreshold && !tempIsRising) {
                newState = "cooldown";
            }
            break;

        case "running":
            // Only transition to 'refuel' is allowed.
            // Check for lockout
            const lastRunningTime = options._lastRunningTransitionTime || 0;
            const minutesSinceRunning = (Date.now() - lastRunningTime) / 60000;
            const isLockedOut = minutesSinceRunning < REFUEL_LOCKOUT_MINUTES;

            // Condition: Significant relative drop from the peak temp AND temp is dropping  AND the drop is accelerating.
            if (!isLockedOut && ((tempHasDroppedSignificantlyFromPeak && tempIsFalling && tempDropIsAccelerating) || !tempIsAboveRunningThreshold)) {
                newState = "refuel";
                log.debug(`${LOG_TAG} Transition from running to refuel triggered. Reasons:`, logLevel);
                if (tempHasDroppedSignificantlyFromPeak) { 
                    log.debug(`  - Temp dropped from peak: ${currentTemp.toFixed(2)} < ${(maxTemp * (1 - effectiveRelativeDrop)).toFixed(2)}`, logLevel);
                }
                if (tempIsFalling) {
                    log.debug(`  - Temp falling at minimum rate: ${slope.toFixed(2)} <= ${DROP_SLOPE_THRESHOLD}`, logLevel);
                }
                if (tempDropIsAccelerating) {
                    log.debug(`  - Temp drop is accelerating: ${slopeDerivative.toFixed(4)} < ${effectiveDerivativeThreshold}`, logLevel);
                }
                if (!tempIsAboveRunningThreshold) {
                    log.debug(`  - Temp has fallen below running threshold: ${currentTemp.toFixed(2)} < ${RUNNING_TEMP_THRESHOLD}`, logLevel);
                }
            } else if (isLockedOut && ((tempHasDroppedSignificantlyFromPeak && tempIsFalling && tempDropIsAccelerating) || !tempIsAboveRunningThreshold)) {
                log.debug(`${LOG_TAG} Transition to refuel suppressed by lockout (${minutesSinceRunning.toFixed(1)}m < ${REFUEL_LOCKOUT_MINUTES}m)`, logLevel);
            }
            break;

        case "refuel": 
            // To 'running': Temp starts rising again OR has flattened while still hot OR cooldown is slowing down.
            if (tempIsAboveRunningThreshold && (tempIsRising || tempDropIsSlowing)) {
                newState = "running";
                log.debug(`${LOG_TAG} Transition from refuel to running triggered. Reasons:`, logLevel);
                if (tempIsAboveRunningThreshold) {
                    log.debug(`  - Temp is above running threshold: ${currentTemp.toFixed(2)} > ${RUNNING_TEMP_THRESHOLD}`, logLevel);
                }
                if (tempIsRising) {
                    log.debug(`  - Temp is rising: ${slope.toFixed(2)} >= ${RISE_SLOPE_THRESHOLD}`, logLevel);
                }
                if (tempDropIsSlowing) {
                    log.debug(`  - Temp drop is slowing: slope < 0 and derivative > ${REFUEL_RECOVERY_DERIVATIVE} (${slopeDerivative.toFixed(4)})`, logLevel);
                }
            }
            // To 'cooldown': Temp continues to drop or falls below running temp.
            else if (currentTemp < RUNNING_TEMP_THRESHOLD - 7) {
                newState = "cooldown";
                log.debug(`${LOG_TAG} Transition from refuel to cooldown triggered. Reasons:`, logLevel);
                if (!tempIsAboveRunningThreshold) {
                    log.debug(
                        `  - Temp is more than 2 degrees below running threshold: ${currentTemp.toFixed(2)} < ${RUNNING_TEMP_THRESHOLD - 2}`,
                        logLevel,
                    );
                }
            }
            break;

        case "cooldown":
            // To 'off': Temp is back near ambient.
            if (!tempIsSignificantlyAboveAmbient && !tempIsRising) {
                newState = "off";
                log.debug(`${LOG_TAG} Transition from cooldown to off triggered. Reasons:`, logLevel);
                if (!tempIsSignificantlyAboveAmbient) {
                    log.debug(`  - Temp is near ambient: ${currentTemp.toFixed(2)} < ${AMBIENT_TEMP.toFixed(2)} + 2`, logLevel);
                }
                if (!tempIsRising) {
                    log.debug(`  - Temp is not rising: slope < ${RISE_SLOPE_THRESHOLD}`, logLevel);
                }
            }
            // To 'warmup': It's heating up again.
            else if (tempIsSignificantlyAboveAmbient && tempIsRising) {
                newState = "warmup";
                log.debug(`${LOG_TAG} Transition from cooldown to warmup triggered. Reasons:`, logLevel);
                if (tempIsSignificantlyAboveAmbient) {
                    log.debug(`  - Temp is significantly above ambient: ${currentTemp.toFixed(2)} > ${AMBIENT_TEMP.toFixed(2)} + 2`, logLevel);
                }
                if (tempIsRising) {
                    log.debug(`  - Temp is rising: slope > ${RISE_SLOPE_THRESHOLD}`, logLevel);
                }
            }
            break;

        default:
            newState = "off";
    }

    if (newState === "running" && previousState !== "running") {
        options._lastRunningTransitionTime = Date.now();
    }

    if (newState !== previousState) {
        log.info(`${LOG_TAG} State change from ${previousState} to ${newState}`, logLevel);
    }

    return newState;
};