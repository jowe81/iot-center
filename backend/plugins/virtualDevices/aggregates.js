/**
 * Virtual device plugin for calculating aggregates.
 * 
 * @param {string} deviceId - The ID of the virtual device (e.g., "aggregates").
 * @param {import('mongodb').Db} db - Reference to the MongoDB connection.
 * @param {object} config - The device configuration object.
 * @returns {Promise<object|object[]>} Data to be injected into the processing chain.
 */
import { getDeviceByKey } from '../../controllers/logicalDeviceManager.js';

export const run = async (deviceId, db, config) => {
    let averageInsideTempC = undefined;

    const sourceMap = {
        'iot.recroom_01.shtSensor': 'tempC',
        'iot.office_johannes_01.shtSensor': 'tempC',
        'iot.kitchen_01.tempKitchen': 'tempC',
        'iot.livingroom_01.shtSensor': 'tempC',
    }

    const temps = [];

    for (const logicalDeviceKey in sourceMap) {
        const key = sourceMap[logicalDeviceKey];
        const logicalDevice = getDeviceByKey(logicalDeviceKey);
        if (logicalDevice) {
            const latestData = await logicalDevice.getData();
            if (latestData && typeof latestData[key] === "number") {
                temps.push(latestData[key]);
            }
        }
    }
    
    if (temps.length > 0) {
        averageInsideTempC = temps.reduce((a, b) => a + b, 0) / temps.length;
    }    

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
            tempC: averageInsideTempC,
            sensors: temps.length,
        },
    ];

    return data;
};