/**
 * Woodstove State Plugin
 * Analyzes temperature data to determine woodstove running mode.
 */
import { getValue } from '../utils/dataUtils.js';
import log from '../utils/logger.js';

export const run = async (deviceId, filteredData, inputs, outputKey, options, db, lastRecord, previousValue) => {
    const doLog = options.log === true;
    if (doLog) log.debug(`woodstoveState plugin running for ${deviceId}`);

    // inputs contains values for keys defined in config
    const inputKeys = Object.keys(inputs);
    if (inputKeys.length === 0) {
        if (doLog) log.debug('woodstoveState: No input keys, returning "off"');
        return "off";
    }

    // Assume the first input key is the temperature
    const tempKey = inputKeys[0];
    const currentTemp = inputs[tempKey];

    if (typeof currentTemp !== 'number') {
        if (doLog) log.debug(`woodstoveState: currentTemp is not a number (${currentTemp}), returning "off"`);
        return "off";
    }

    let previousState = previousValue || 'off';
    previousState = previousState.toLowerCase();
    if (doLog) log.debug(`woodstoveState: currentTemp=${currentTemp}, previousState=${previousState}`);

    // Configuration
    const HISTORY_MINUTES = options.historyMinutes || 60;
    const SLOPE_WINDOW_MINUTES = options.slopeWindowMinutes || 15;
    const AMBIENT_TEMP = options.ambientTemp || 25;
    
    // Thresholds (Slope in deg/min, Drops in %)
    const RISE_THRESHOLD = options.riseThreshold || 0.5; 
    const STABLE_THRESHOLD = options.stableThreshold || 0.2; 
    const DROP_THRESHOLD = options.dropThreshold || -0.5; 
    const RELATIVE_DROP_REFUEL = options.relativeDropRefuel || 0.15; // 15% drop from peak
    const RELATIVE_DROP_COOLDOWN = options.relativeDropCooldown || 0.40; // 40% drop from peak

    // Fetch History
    const collection = db.collection(`device_${deviceId}`);
    const historyStartTime = new Date(Date.now() - HISTORY_MINUTES * 60 * 1000);
    
    const historyDocs = await collection.find(
        { 
            receivedAt: { $gte: historyStartTime },
            [`data.${tempKey}`]: { $exists: true }
        },
        {
            sort: { receivedAt: 1 },
            projection: { receivedAt: 1, [`data.${tempKey}`]: 1 }
        }
    ).toArray();

    const points = historyDocs.map(doc => ({
        time: doc.receivedAt.getTime(),
        val: getValue(doc, `data.${tempKey}`)
    })).filter(p => typeof p.val === 'number');

    // Add current point
    points.push({ time: Date.now(), val: currentTemp });

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
    if (doLog) log.debug(`woodstoveState: slope=${slope.toFixed(2)}, maxTemp=${maxTemp.toFixed(2)}`);

    let newState = previousState;

    switch (previousState) {
        case 'off':
            if (slope > RISE_THRESHOLD && currentTemp > AMBIENT_TEMP) {
                newState = 'warmup';
            } else if (currentTemp > AMBIENT_TEMP + 10) {
                newState = 'running';
            }
            break;
        case 'warmup':
            if (slope < STABLE_THRESHOLD && currentTemp > AMBIENT_TEMP + 10) {
                newState = 'running';
            } else if (slope < DROP_THRESHOLD) {
                newState = 'cooldown';
            }
            break;
        case 'running':
            if (currentTemp < maxTemp * (1 - RELATIVE_DROP_REFUEL)) {
                newState = 'refuel';
            } else if (currentTemp < AMBIENT_TEMP + 10) {
                newState = 'cooldown';
            }
            break;
        case 'refuel':
            if (slope > RISE_THRESHOLD) {
                newState = 'running';
            } else if (currentTemp < maxTemp * (1 - RELATIVE_DROP_COOLDOWN)) {
                newState = 'cooldown';
            }
            break;
        case 'cooldown':
            if (currentTemp < AMBIENT_TEMP + 2) {
                newState = 'off';
            } else if (slope > RISE_THRESHOLD) {
                newState = 'warmup';
            }
            break;
        default:
            newState = 'off';
    }

    if (doLog && newState !== previousState) {
        log.debug(`woodstoveState: State change from ${previousState} to ${newState}`);
    }

    return newState;
};