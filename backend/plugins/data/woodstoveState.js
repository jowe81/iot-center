/**
 * Woodstove State Plugin
 * Analyzes temperature data to determine woodstove running mode.
 */
import { getValue } from '../../utils/dataUtils.js';
import log from '../../utils/logger.js';

const LOG_TAG = '[Plugin: WoodstoveState]';

export const run = async (deviceId, filteredData, inputs, outputKey, options, db, lastRecord, previousValue) => {
    const doLog = options.log === true;
    if (doLog) log.debug(`${LOG_TAG} Plugin running for ${deviceId}`);

    // inputs contains values for keys defined in config
    const inputKeys = Object.keys(inputs);
    if (inputKeys.length === 0) {
        if (doLog) log.debug(`${LOG_TAG} No input keys, returning "off"`);
        return "off";
    }

    // Assume the first input key is the temperature
    const tempKey = inputKeys[0];
    const currentTemp = inputs[tempKey];

    if (typeof currentTemp !== 'number') {
        if (doLog) log.debug(`${LOG_TAG} currentTemp is not a number (${currentTemp}), returning "off"`);
        return "off";
    }

    let previousState = previousValue || 'off';
    previousState = previousState.toLowerCase();
    if (doLog) log.debug(`${LOG_TAG} currentTemp=${currentTemp}, previousState=${previousState}`);

    // Configuration
    const HISTORY_MINUTES = options.historyMinutes || 60;
    const SLOPE_WINDOW_MINUTES = options.slopeWindowMinutes || 10;
    
    let AMBIENT_TEMP = options.ambientTemp || 25;
    if (inputKeys.length > 1) {
        const ambientKey = inputKeys[1];
        const liveAmbient = inputs[ambientKey];
        if (typeof liveAmbient === 'number') {
            AMBIENT_TEMP = liveAmbient;
            if (doLog) log.debug(`${LOG_TAG} Using live ambient temp: ${AMBIENT_TEMP}`);
        }
    }
    
    // Thresholds (Slope in deg/min, Drops in %)
    const RISE_THRESHOLD = options.riseThreshold || 0.02;
    const DROP_THRESHOLD = options.dropThreshold || -0.3;
    const RELATIVE_DROP_REFUEL = options.relativeDropRefuel || 0.05; // 5% drop from peak
    const RELATIVE_DROP_COOLDOWN = options.relativeDropCooldown || 0.30; // 30% drop from peak
    const REFUEL_RECOVERY_SLOPE = options.refuelRecoverySlope || -0.4
    const RUNNING_TEMP_THRESHOLD = options.runningTempThreshold || 40;
    const OFF_TEMP_THRESHOLD = AMBIENT_TEMP + 5; // Temp considered 'off'

    let points = options._points;

    // If history is not in memory, it's the first run or a restart. Fetch from DB.
    if (!points) {
        if (doLog) log.debug(`${LOG_TAG} No history in memory, fetching from DB.`);
        const collection = db.collection(`device_${deviceId}`);
        const historyStartTime = new Date(Date.now() - HISTORY_MINUTES * 60 * 1000);
        
        const historyDocs = await collection.find(
            { 
                receivedAt: { $gte: historyStartTime },
                [`data.${tempKey}`]: { $exists: true }
            },
            {
                sort: { receivedAt: 1 },
                projection: { receivedAt: 1, [`data.${tempKey}`]: 1, [`data.${outputKey}`]: 1 }
            }
        ).toArray();

        points = historyDocs.map(doc => ({
            time: doc.receivedAt.getTime(),
            val: getValue(doc, `data.${tempKey}`),
            state: getValue(doc, `data.${outputKey}`)
        })).filter(p => typeof p.val === 'number');
    }

    // Add current point
    points.push({ time: Date.now(), val: currentTemp });

    // Prune old points to keep the history window fixed
    const historyCutoff = Date.now() - (HISTORY_MINUTES * 60 * 1000);
    const oldPointsLength = points.length;
    points = points.filter(p => p.time >= historyCutoff);
    if (doLog && oldPointsLength > points.length) {
        log.debug(`${LOG_TAG} Pruned ${oldPointsLength - points.length} old point(s) from history.`);
    }

    // Persist for next run
    options._points = points;

    // Calculate Slope (Linear Regression over last SLOPE_WINDOW_MINUTES)
    const slopeWindowStart = Date.now() - SLOPE_WINDOW_MINUTES * 60 * 1000;
    const slopePoints = points.filter(p => p.time >= slopeWindowStart);
    
    let slope = 0;
    if (slopePoints.length >= 2) {
        const n = slopePoints.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        const t0 = slopePoints[0].time;
        
        for (const p of slopePoints) {
            const x = (p.time - t0) / 60000; // minutes
            const y = p.val;
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumXX += x * x;
        }
        
        const denominator = (n * sumXX - sumX * sumX);
        if (denominator !== 0) {
            slope = (n * sumXY - sumX * sumY) / denominator;
        }
    }

    // Calculate Max Temp in the history window (local peak)
    const maxTemp = Math.max(...points.map(p => p.val));
    if (doLog) {
        log.debug(`${LOG_TAG} slope=${slope.toFixed(2)}, maxTemp=${maxTemp.toFixed(2)}, currentTemp=${currentTemp}`);
        log.debug(`${LOG_TAG} Thresholds: RUNNING=${RUNNING_TEMP_THRESHOLD}, OFF=${OFF_TEMP_THRESHOLD}, RISE=${RISE_THRESHOLD}, DROP=${DROP_THRESHOLD}`);
    }

    let newState = previousState;

    switch (previousState) {
        case 'off':
            // Only transition to 'warmup' is allowed.
            // Condition: Temp is rising and above ambient.
            if (slope > RISE_THRESHOLD && currentTemp > AMBIENT_TEMP + 2) {
                newState = 'warmup';
            }
            break;

        case 'warmup':
            // To 'running': Temp has passed the running threshold.
            if (currentTemp > RUNNING_TEMP_THRESHOLD) {
                newState = 'running';
            }
            // To 'cooldown': Temp is dropping (fire went out).
            else if (slope < DROP_THRESHOLD) {
                newState = 'cooldown';
            }
            break;

        case 'running':
            // Only transition to 'refuel' is allowed.
            // Condition: Significant relative drop from the peak temp AND temp is not rising.
            if (currentTemp < maxTemp * (1 - RELATIVE_DROP_REFUEL) && slope <= DROP_THRESHOLD) {
                newState = 'refuel';
            }
            break;

        case 'refuel':
            // To 'running': Temp starts rising again OR has flattened while still hot.
            if ((slope > RISE_THRESHOLD) || (currentTemp > RUNNING_TEMP_THRESHOLD && slope > REFUEL_RECOVERY_SLOPE)) {
                newState = 'running';
            }
            // To 'cooldown': Temp continues to drop or falls below running temp.
            else if (currentTemp < maxTemp * (1 - RELATIVE_DROP_COOLDOWN) || currentTemp < RUNNING_TEMP_THRESHOLD) {
                newState = 'cooldown';
            }
            break;

        case 'cooldown':
            // To 'off': Temp is back near ambient.
            if (currentTemp < OFF_TEMP_THRESHOLD) {
                newState = 'off';
            }
            // To 'warmup': It's heating up again.
            else if (slope > RISE_THRESHOLD) {
                newState = 'warmup';
            }
            break;

        default:
            newState = 'off';
    }

    if (doLog && newState !== previousState) {
        log.debug(`${LOG_TAG} State change from ${previousState} to ${newState}`);
    }

    return newState;
};