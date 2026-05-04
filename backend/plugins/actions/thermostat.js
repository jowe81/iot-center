import log from '../../utils/logger.js';
import { addCommand } from '../../controllers/commandService.js';
import { getDb } from '../../config/db.js';
import SunCalc from "suncalc";

const LOG_TAG = '[Action: Thermostat]';


// Mackenzie, BC Coordinates
const LAT = 55.335;
const LON = -123.096;

// Module-level state for rate limiting (persists as long as the process is running)
let lastSolarFetchTime = 0;
let lastSolarResult = false;
const API_MIN_INTERVAL = 30 * 60 * 1000; // 30 minutes (max 2 calls per hour)

async function getForecast(lat, lon, forecastWindowHours, logLevel) {
    const isSunny = (conditionText) => {
        if (!conditionText) return false;
        const terms = ['sunny', 'partly cloudy', 'clear'];
        return terms.some(term => conditionText.toLowerCase().includes(term));
    }

    // Return a cached result if the api was called within the last half hour.
    const now = Date.now();
    if (now - lastSolarFetchTime < API_MIN_INTERVAL) {
        return lastSolarResult;
    }

    log.info(`${LOG_TAG} Checking Weather API for sky conditions and temperature forecast`, logLevel);

    const url = `https://weather.gc.ca/api/app/v3/en/Location/${lat},${lon}?type=city`;
    try {
        const response = await fetch(url);
        lastSolarFetchTime = now;

        if (!response.ok) {
            throw new Error(`Weather API error: ${response.status} - Check if Mackenzie site ID is correct.`);
        }

        const rawData = await response.json();

        if (!Array.isArray(rawData) || !rawData.length) {
            return lastSolarResult = null;
        }

        const data = rawData[0];

        const currentCondition = data.observation?.condition;
        const currentlySunny = isSunny(currentCondition);

        const hourlyForecastRaw = data.hourlyFcst?.hourly;

        let forecastSunny = false;
        let tempAvgWindow = null; 
        let tempMaxToday = null;     
        if (!Array.isArray(hourlyForecastRaw) && hourlyForecastRaw.length >= forecastWindowHours) {
            log.error(`${LOG_TAG} Weather API returned unexpected data.`, null, logLevel);
            return lastSolarResult = null;
        }
        // Only keep the hourly forecast for today.
        let date = hourlyForecastRaw[0].date;
        const hourlyForecast = [];
        hourlyForecastRaw.forEach((info, index) => {
            if (info.date === date || index < forecastWindowHours) {
                hourlyForecast.push(info);
            }
        });

        const conditionHourly = hourlyForecast.slice(0, forecastWindowHours).map((info) => info.condition);
        const sunnyHoursCount = conditionHourly.filter(isSunny).length + (currentlySunny ? 1 : 0);
        forecastSunny = (sunnyHoursCount / (conditionHourly.length + 1));

        const tempHourly = hourlyForecast.map((info) => parseInt(info.temperature?.metric));
        const tempHourlyWindow = tempHourly.slice(0, forecastWindowHours);
        tempAvgWindow = tempHourlyWindow.reduce((sum, temp) => sum + temp, 0) / tempHourlyWindow.length;
        tempMaxToday = tempHourly.reduce((max, temp) => Math.max(max, temp), -Infinity);

        log.info(`${LOG_TAG} Weather API response:`, logLevel);
        log.info(`${LOG_TAG} - Currently sunny? ${currentlySunny ? 'Yes' : 'No'}`, logLevel);
        log.info(`${LOG_TAG} - Forecast sunny? ${forecastSunny.toFixed(2)}`, logLevel);
        log.info(`${LOG_TAG} - Avg temp during ${forecastWindowHours}h window: ${tempAvgWindow}°C`, logLevel);
        log.info(`${LOG_TAG} - Max temp forecast for today: ${tempMaxToday}°C`, logLevel);

        return lastSolarResult = {
            currentlySunny,
            forecastSunny,
            forecastCloudy: 1 - forecastSunny,
            tempAvgWindow,
            tempMaxToday
        }
    } catch (error) {
        log.error(`${LOG_TAG} getForecast error: ${error.message}`);
        return lastSolarResult = null;
    }
}

/**
 * Checks the database for the current 'isOn' state of the target device.
 */
const getActualIsOn = async (options) => {
    const {targetDevice, targetSubDevice} = getTarget(options);

    try {
        const db = getDb();
        const collection = db.collection(`device_${targetDevice}`);
        const latestDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });

        if (latestDoc && latestDoc.data) {
            for (const type of Object.values(latestDoc.data)) {
                for (const subtype of Object.values(type)) {
                    const subDeviceData = subtype[targetSubDevice];
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
        const temp = options[`setpoint${i}Temp`];
        const time = options[`setpoint${i}Time`];

        log.debug(`${LOG_TAG} getScheduledSetpoint: Checking slot ${i} - temp: ${temp} (${typeof temp}), time: ${time} (${typeof time})`, logLevel);

        if (typeof temp === 'number') {
            allProvidedTemps.push({ temp, index: i - 1 });
            if (typeof time === 'string' && timeRegex.test(time)) {
                schedules.push({ temp, time, index: i - 1 });
                log.debug(`${LOG_TAG} getScheduledSetpoint: Slot ${i} is valid: ${time} @ ${temp}°C`, logLevel);
            } else if (time) {
                log.debug(`${LOG_TAG} getScheduledSetpoint: Slot ${i} rejected. Time "${time}" must be string in HH:mm format.`, logLevel);
            }
        }
    }

    log.debug(`${LOG_TAG} Found ${schedules.length} valid timed schedules and ${allProvidedTemps.length} target temps total.`, logLevel);

    // If no timed schedules exist
    if (schedules.length === 0) {
        // Fallback: If exactly one target temp is provided, use it for 24h
        if (allProvidedTemps.length === 1) {
            log.debug(`${LOG_TAG} No timed schedules found, using single temp fallback: ${allProvidedTemps[0].temp}°C`, logLevel);
            return { ...allProvidedTemps[0], time: 'always' };
        }
        return null; // Inactive
    }

    if (schedules.length === 1) return schedules[0];

    // Sort schedules chronologically
    schedules.sort((a, b) => a.time.localeCompare(b.time));

    const now = new Date();
    const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    log.debug(`${LOG_TAG} Comparing current time ${nowStr} against sorted schedules: ${schedules.map(s => s.time).join(', ')}`, logLevel);

    // Find the current active schedule (the latest one that has already passed)
    // Default to the last schedule of the day (handles wrap-around past midnight)
    let active = schedules[schedules.length - 1];
    log.debug(`${LOG_TAG} Initial active set to last schedule (wrap-around): ${active.time}`, logLevel);

    for (const s of schedules) {
        if (nowStr >= s.time) {
            log.debug(`${LOG_TAG} getScheduledSetpoint: Current time ${nowStr} is past/at ${s.time}. Activating Slot ${s.index + 1}`, logLevel);
            active = s;
        } else {
            log.debug(`${LOG_TAG} getScheduledSetpoint: Current time ${nowStr} is before ${s.time}. Search finished.`, logLevel);
            break;
        }
    }
    log.debug(`${LOG_TAG} Final selected setpoint: ${active.temp}°C (from schedule starting at ${active.time})`, logLevel);
    return active;
};


/**
 * Weather based optimizations when transitioning to the morning setpoint: 
 * - Let t be a constant describing the approximate expected temperature increase when a fire in the woodstove is maintained for a few hours
 * 
 * - Let k equal the expected indoor temperature change based on current inside temp and weather forecast for today (assuming no furnace or fire).
 * - If the woodstove has been started, adjust k = k + t.
 * - Note k is the total indoor temperature change expected without use of the furnace.
 * - If current indoor temperature + k >= setpoint target, skip the transition (do not adjust the target temperature, furnace is not needed).
 * - Otherwise, adjust the target temperature as follows: k > 0 ? setpointTarget - k : setpointTarget (furnace is partly or fully needed)
 * 
 * - If a fire wasn't going at the transition time but one is detected after starting the furnace, adjust targetTemp = targetTemp - t
 */

/**
 * Compares current temperature to setpoint and controls furnace relay.
 * @param {Array} currentValues Array of values from the defined sources.
 * @param {object} options The configuration options.
 */
export const run = async (currentValues, options) => {
    const { targetDevice, targetSubDevice } = getTarget(options);

    // Architecture change: read the first element from the new currentValue array
    const currentValue = Array.isArray(currentValues) ? currentValues[0] : currentValues;

    const logLevel = options.log;
    const lat = options.lat || LAT;
    const lon = options.lon || LON;
    log.debug(`${LOG_TAG} Thermostat running for device ${targetDevice} with temp: ${currentValue}`, logLevel);

    if (currentValue === undefined || currentValue === null || typeof currentValue !== 'number') {
        log.debug(`${LOG_TAG} Invalid temperature provided (${currentValue}), exiting.`, logLevel);
        return;
    }

    const activeSchedule = getScheduledSetpoint(options, logLevel);
    const scheduledTemp = activeSchedule ? activeSchedule.temp : null;
    const scheduledTime = activeSchedule ? activeSchedule.time : null;

    const hysteresis = options.hysteresis || 0.5; // Default 0.5 degree deadband
    const pushCommand = options.pushCommand || 'onStateChange';
    const forecastWindowHours = options.forecastWindowHours || 7;
    
    // Schedule Override Logic: 
    // If the active schedule slot has changed since the last run, 
    // we force the currentTargetTemp to match the new scheduled temperature.
    if (scheduledTime !== options._lastScheduledTime) {
        options.currentTargetTemp = scheduledTemp;

        if (activeSchedule.index === 0 && options.useWeatherAdjustments) {
            // Transitioning to the first setpoint of the day: consider optimizations if configured.
            let offset = 0;

            const forecastInfo = await getForecast(lat, lon, forecastWindowHours,logLevel);
            if (forecastInfo) {
                const {forecastSunny, tempAvgWindow, tempMaxToday} = forecastInfo;
                
                const forecastScheduleTempDelta = tempMaxToday - scheduledTemp;

                if (forecastScheduleTempDelta > 0) {
                    // Forecast max temp is greater than the scheduled temp.
                }

                let offsetMaxTemp = 0;
                if (tempMaxToday > 22) {
                    offsetMaxTemp = -0.3;
                } else if (tempMaxToday > 24) {
                    offsetMaxTemp = -0.6;
                } else if (tempMaxToday > 26) {
                    offsetMaxTemp = -1;
                }

                let offsetTempAvg = 0;
                if (forecastSunny >= .8){
                    if (tempAvgWindow > 10) {
                        offsetTempAvg = -1;
                    } else if (tempAvgWindow > 8) {
                        offsetTempAvg = -0.8;
                    } else if (tempAvgWindow > 5) {
                        offsetTempAvg = -0.5;
                    } else if (tempAvgWindow > 2) {
                        offsetTempAvg = -0.2;
                    }
                }

                offset = offsetMaxTemp + offsetTempAvg;                
            } else {
                log.error(`${LOG_TAG} Failed to obtain the weather forecast.`, logLevel);
            }

            const scheduledTempAdjusted = scheduledTemp + offset;
            log.info(
                `${LOG_TAG} Schedule transition to ${scheduledTime} (morning setpoint) detected. Updating target temp to ${scheduledTempAdjusted.toFixed(1)}°C -- ${scheduledTemp}°C with ${offset}°C solar adjustment`,
                logLevel,
            );
            options.currentTargetTemp = scheduledTempAdjusted;
        } else {
            log.info(`${LOG_TAG} Schedule transition to ${scheduledTime} detected. Updating target temp to ${scheduledTemp}°C`, logLevel);            
        }
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

    log.debug(`${LOG_TAG} Current Temp: ${currentValue}°, Setpoint: ${setPoint.toFixed(1)}°, Hysteresis: ${hysteresis}°`, logLevel);
    log.debug(`${LOG_TAG} Calculated thresholds: ON < ${(setPoint - hysteresis).toFixed(1)}°, OFF > ${(setPoint + hysteresis).toFixed(1)}°`, logLevel);

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
            await addCommand(targetDevice, { [targetSubDevice]: { setState: desiredState } });
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue furnace command`, e, logLevel);
        }
    } else {
        log.debug(`${LOG_TAG} Desired state (${desiredState}) matches actual state. No command sent.`, logLevel);
    }
};

/**
 * Shutdown procedure for the thermostat action.
 */
export const stop = async (options) => {
    const { targetDevice, targetSubDevice } = getTarget(options);

    const logLevel = options.log;
    log.info(`${LOG_TAG} Stop called for ${targetDevice}. Safety check to turn off furnace.`, logLevel);

    try {
        const actualIsOn = await getActualIsOn(options);

        if (actualIsOn === true) {
            log.info(`${LOG_TAG} Furnace is ON. Queuing OFF command for safety.`, logLevel);
            await addCommand(targetDevice, { [targetSubDevice]: { setState: false } });
        } else {
            log.debug(`${LOG_TAG} Furnace is already OFF or state is unknown.`, logLevel);
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error during stop procedure for ${targetDevice}.`, e);
    }
};

function getTarget(options) {
    if (!Array.isArray(options.targets) || options.targets.length === 0) {
        return {
            targetDevice: null,
            targetSubDevice: null,
        };
    }

    return {
        targetDevice: options.targets[0].device,
        targetSubDevice: options.targets[0].subDevice,
    }
}