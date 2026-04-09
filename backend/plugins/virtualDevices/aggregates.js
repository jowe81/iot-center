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
                    log.info(`Sensor ${key} came online. (${lastType} -> ${currentType})`);
                } else {
                    log.warn(`Sensor ${key} went offine. (${lastType} -> ${currentType})`);
                }
                haveChanges = true;
            }
        }
        return haveChanges;
    },

    finalize() {
        const current = _cache.currentReading;
        const last = _cache.lastReading;

        current.average = this._getAverage(current.sample, current.sensorsOnline);

        if (this._detectStatusChanges()) {
            const allDelta = (typeof current.average === 'number' && typeof last.average === 'number')
                ? current.average - last.average : null;

            const intersection = current.sensorsOnline.filter(key => last.sensorsOnline.includes(key));
            const lastUnchangedAvg = this._getAverage(last.sample, intersection);
            const currentUnchangedAvg = this._getAverage(current.sample, intersection);
            
            const unchangedDelta = (typeof currentUnchangedAvg === 'number' && typeof lastUnchangedAvg === 'number')
                ? currentUnchangedAvg - lastUnchangedAvg : null;

            if (allDelta !== null && unchangedDelta !== null) {
                current.offset = allDelta - unchangedDelta;
            }

            log.debug(`allAvailableSensorsLastAverage: ${last.average}, allAvailableSensorsCurrentAverage: ${current.average}`, logLevel);
            log.debug(`unchangedSensorsLastAverage: ${lastUnchangedAvg}, unchangedSensorsCurrentAverage: ${currentUnchangedAvg}`, logLevel);
            log.debug(`currentOffset: ${current.offset}`);
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

    for (const logicalDeviceKey in sourceMap) {
        const key = sourceMap[logicalDeviceKey];
        const logicalDevice = getDeviceByKey(logicalDeviceKey);
        if (logicalDevice) {
            const latestData = await logicalDevice.getData();
            let liveTemp = latestData && typeof latestData[key] === "number" ? latestData[key] : null;
            cacheManager.record(logicalDeviceKey, liveTemp);
        }
    }

    cacheManager.finalize();
    console.log('-------- RUN');

    console.log("cache");
    console.log(_cache);

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
    ];

    return data;
};
