/**
 * Virtual device plugin for calculating aggregates.
 * 
 * @param {string} deviceId - The ID of the virtual device (e.g., "aggregates").
 * @param {import('mongodb').Db} db - Reference to the MongoDB connection.
 * @param {object} config - The device configuration object.
 * @returns {Promise<object|object[]>} Data to be injected into the processing chain.
 */
import log from "../../utils/logger.js";
import { getDeviceByKey } from '../../controllers/logicalDeviceManager.js';

const sourceMap = {
    "iot.recroom_01.shtSensor": "tempC",
    "iot.office_johannes_01.shtSensor": "tempC",
    "iot.kitchen_01.tempKitchen": "tempC",
    "iot.livingroom_01.shtSensor": "tempC",
    "iot.laundryRoom_legacy.laundryRoom": "tempC",
};

const logLevel = 'debug';

const createReading = () => ({
    sensorsOnline: [],
    sample: {},
    average: null,
    offset: 0,
});

const _cache = {
    lastCompleteReading: createReading(),
    lastReading: createReading(),
    currentReading: createReading(),
    history: [],
};

const cacheManager = {
    init() {
        for (const key in sourceMap) {
            _cache.lastReading.sample[key] = null;
        }
    },

    rotate() {
        _cache.lastReading = {
            sensorsOnline: [..._cache.currentReading.sensorsOnline],
            sample: { ..._cache.currentReading.sample },
            average: _cache.currentReading.average,
            offset: _cache.currentReading.offset,
        };
        _cache.currentReading = createReading();
    },

    record(key, value) {
        _cache.currentReading.sample[key] = value;
        if (value !== null && typeof value === "number") {
            _cache.currentReading.sensorsOnline.push(key);
        }
    },

    _getAverage(sample, keys) {
        const values = keys.map(k => sample[k]).filter(v => typeof v === 'number');
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
    },

    _detectStatusChanges() {
        let haveChanges = false;
        for (const key in sourceMap) {
            const lastType = typeof _cache.lastReading.sample[key];
            const currentType = typeof _cache.currentReading.sample[key];
            if (lastType !== currentType) {
                if (currentType === 'number') {
                    log.info(`Sensor ${key} came online. (${lastType} -> ${currentType})`, logLevel);
                } else {
                    log.warn(`Sensor ${key} went offine. (${lastType} -> ${currentType})`, logLevel);
                }
                haveChanges = true;
            }
        }
        return haveChanges;
    },

    finalize() {
        const current = _cache.currentReading;
        const last = _cache.lastReading;

        const expectedKeys = Object.keys(sourceMap);
        const onlineCount = current.sensorsOnline.length;
        const totalCount = expectedKeys.length;

        if (onlineCount === totalCount) {
            // Perfect reading: Update average normally and save as reference
            current.average = this._getAverage(current.sample, current.sensorsOnline);
            current.offset = 0;

            _cache.lastCompleteReading = {
                sensorsOnline: [...current.sensorsOnline],
                sample: { ...current.sample },
                average: current.average,
                offset: current.offset,
            };
            log.debug(`Updated lastCompleteReading with all ${totalCount} sensors.`, logLevel);
        } else if (onlineCount > 0 && _cache.lastCompleteReading.sensorsOnline.length === totalCount) {
            // Contingency: Some sensors offline, but we have a baseline
            const offlineKeys = expectedKeys.filter((k) => !current.sensorsOnline.includes(k));

            // 1. How much have the currently online sensors changed since the last complete reading?
            const lastSubAvg = this._getAverage(_cache.lastCompleteReading.sample, current.sensorsOnline);
            const currentSubAvg = this._getAverage(current.sample, current.sensorsOnline);
            const shift = currentSubAvg - lastSubAvg;

            // 2. Synthesize a complete set of temperatures
            const synthesizedTemps = [...current.sensorsOnline.map((k) => current.sample[k])];

            for (const key of offlineKeys) {
                const historicalVal = _cache.lastCompleteReading.sample[key];
                const extrapolatedVal = historicalVal + shift;
                synthesizedTemps.push(extrapolatedVal);
            }

            current.average = synthesizedTemps.reduce((a, b) => a + b, 0) / synthesizedTemps.length;
            current.offset = shift;

            log.debug(
                `Extrapolated average using ${onlineCount} online and ${offlineKeys.length} offline sensors (Shift: ${shift.toFixed(2)}°C)`, logLevel
            );
        } else {
            // Fallback: No baseline or all offline
            current.average = this._getAverage(current.sample, current.sensorsOnline);
        }

        // If all expected sensors are online, preserve this as the last complete reading
        const expectedSensorCount = Object.keys(sourceMap).length;
        if (current.sensorsOnline.length === expectedSensorCount) {
            _cache.lastCompleteReading = {
                sensorsOnline: [...current.sensorsOnline],
                sample: { ...current.sample },
                average: current.average,
                offset: current.offset,
            };
        }
    }
};

cacheManager.init();

export const run = async (deviceId, db, config) => {
    cacheManager.rotate();

    const minTemp = config.minAllowedTemp ?? -50;
    const maxTemp = config.maxAllowedTemp ?? 100;

    for (const logicalDeviceKey in sourceMap) {
        const key = sourceMap[logicalDeviceKey];
        const logicalDevice = getDeviceByKey(logicalDeviceKey);
        if (logicalDevice) {
            const latestData = await logicalDevice.getData();
            let liveTemp = latestData && typeof latestData[key] === "number" ? latestData[key] : null;

            // Apply guardrails to filter out impossible sensor readings
            if (liveTemp !== null && (liveTemp < minTemp || liveTemp > maxTemp)) {
                log.warn(`Sensor ${logicalDeviceKey} reported an outlier: ${liveTemp}°C. Range allowed is [${minTemp}, ${maxTemp}]. Ignoring.`, logLevel);
                liveTemp = null;
            }

            cacheManager.record(logicalDeviceKey, liveTemp);
        }
    }

    cacheManager.finalize();

    // Calculate Rolling Average
    const now = Date.now();
    const windowMs = config.rollingWindowMS ?? 300000; // Default 5 minutes

    if (_cache.currentReading.average !== null) {
        _cache.history.push({ ts: now, val: _cache.currentReading.average });
    }
    // Remove samples older than the window
    _cache.history = _cache.history.filter(h => now - h.ts <= windowMs);

    const rollingAvg = _cache.history.length > 0
        ? _cache.history.reduce((sum, h) => sum + h.val, 0) / _cache.history.length
        : null;

    const data = [
        {
            type: "System",
            subtype: "SystemMonitor",
            name: "systemMonitor",
            deviceId: "aggregates",
        },
        {
            type: "Sensor",
            subtype: "aggregateTemp",
            name: "spatialAverageInside",
            tempC: _cache.currentReading.average,
            sensors: _cache.currentReading.sensorsOnline.length,
        },
        {
            type: "Sensor",
            subtype: "aggregateTemp",
            name: "spatialAverageInsideRolling",
            tempC: rollingAvg,
            windowMs: windowMs,
            samples: _cache.history.length,
        },
    ];

    return data;
};
