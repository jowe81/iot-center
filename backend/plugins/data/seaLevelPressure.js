/**
 * Sea Level Pressure Plugin
 * Calculates the standard sea level barometric pressure based on local pressure, temperature, and altitude.
 */
import log from "../../utils/logger.js";

const LOG_TAG = "[Plugin: SeaLevelPressure]";

export const run = async (deviceId, filteredData, inputs, outputKey, options, db, lastRecord, previousValue) => {
    const doLog = options.log === true;
    if (doLog) log.debug(`${LOG_TAG} Plugin running for ${deviceId}`);

    const inputKeys = Object.keys(inputs);
    let temp = null;
    let pressure = null;

    // Try to identify temperature and pressure from inputs
    for (const key of inputKeys) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes("temp")) {
            temp = inputs[key];
        } else if (lowerKey.includes("press")) {
            pressure = inputs[key];
        }
    }

    if (typeof temp !== "number" || typeof pressure !== "number") {
        if (doLog) log.debug(`${LOG_TAG} Missing or invalid inputs: temp=${temp}, pressure=${pressure}`);
        return undefined;
    }

    const altitude = options.altitude || 0;

    // Hypsometric formula: P0 = P * (1 - (0.0065 * h) / (T + 0.0065 * h + 273.15)) ^ -5.257
    const p0 = pressure * Math.pow(1 - (0.0065 * altitude) / (temp + 0.0065 * altitude + 273.15), -5.257);

    if (doLog) log.debug(`${LOG_TAG} Calculated ${p0.toFixed(2)} hPa from P=${pressure}, T=${temp}, Alt=${altitude}`);

    return parseFloat(p0.toFixed(2));
};
