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
let lastForecast = null;
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
        return lastForecast;
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
            return lastForecast = null;
        }

        const data = rawData[0];

        const currentCondition = data.observation?.condition;
        const currentlySunny = isSunny(currentCondition);

        const hourlyForecastRaw = data.hourlyFcst?.hourly;

        let forecastSunnyPercent = 0;
        let tempAvgWindow = null; 
        let tempMaxWindow = null;
        let tempMaxToday = null;
        if (!Array.isArray(hourlyForecastRaw) || hourlyForecastRaw.length < forecastWindowHours) {
            log.error(`${LOG_TAG} Weather API returned unexpected data.`, null, logLevel);
            return lastForecast = null;
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
        forecastSunnyPercent = (sunnyHoursCount / (conditionHourly.length + 1));

        const tempHourly = hourlyForecast.map((info) => parseInt(info.temperature?.metric));
        const tempHourlyWindow = tempHourly.slice(0, forecastWindowHours);
        // The avg temp over the forecast window isn't used currently, but please leave in place.
        tempAvgWindow = tempHourlyWindow.reduce((sum, temp) => sum + temp, 0) / tempHourlyWindow.length;
        tempMaxWindow = tempHourlyWindow.reduce((max, temp) => Math.max(max, temp), -Infinity);
        tempMaxToday = tempHourly.reduce((max, temp) => Math.max(max, temp), -Infinity);

        log.info(`${LOG_TAG} Weather API response:`, logLevel);
        log.info(`${LOG_TAG} - Currently sunny? ${currentlySunny ? 'Yes' : 'No'}`, logLevel);
        log.info(`${LOG_TAG} - Forecast sunny? ${forecastSunnyPercent.toFixed(2)}`, logLevel);
        log.info(`${LOG_TAG} - Avg temp during ${forecastWindowHours}h window: ${tempAvgWindow}°C`, logLevel);
        log.info(`${LOG_TAG} - Max temp during ${forecastWindowHours}h window: ${tempMaxWindow}°C`, logLevel);
        log.info(`${LOG_TAG} - Max temp forecast for today: ${tempMaxToday}°C`, logLevel);

        return lastForecast = {
            currentlySunny,
            forecastSunnyPercent,
            forecastCloudy: 1 - forecastSunnyPercent,
            tempAvgWindow,
            tempMaxWindow,
            tempMaxToday
        }
    } catch (error) {
        log.error(`${LOG_TAG} getForecast error: ${error.message}`);
        return lastForecast = null;
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

        if (typeof temp === 'number') {
            allProvidedTemps.push({ temp, index: i - 1 });
            if (typeof time === 'string' && timeRegex.test(time)) {
                schedules.push({ temp, time, index: i - 1 });
            } else if (time) {
                log.debug(`${LOG_TAG} getScheduledSetpoint: Slot ${i} rejected. Time "${time}" must be string in HH:mm format.`, logLevel);
            }
        }
    }

    // If no timed schedules exist
    if (schedules.length === 0) {
        // Fallback: If exactly one target temp is provided, use it for 24h
        if (allProvidedTemps.length === 1) {
            return { ...allProvidedTemps[0], time: 'always' };
        }
        return null; // Inactive
    }

    if (schedules.length === 1) return schedules[0];

    // Sort schedules chronologically
    schedules.sort((a, b) => a.time.localeCompare(b.time));

    const now = new Date();
    const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Find the current active schedule (the latest one that has already passed)
    // Default to the last schedule of the day (handles wrap-around past midnight)
    let active = schedules[schedules.length - 1];

    for (const s of schedules) {
        if (nowStr >= s.time) {
            active = s;
        } else {
            break;
        }
    }

    log.debug(`${LOG_TAG} Selected setpoint: ${active.temp}°C (from schedule starting at ${active.time})`, logLevel);
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
    const pushCommand = options.pushCommand || 'whileOn';
    const forecastWindowHours = options.forecastWindowHours || 7;
    const forecastMaxTempDeltaTrigger = -Math.abs(options.forecastMaxTempDeltaTrigger || -10);
    const maxOffsetMaxTemp = options.maxOffsetMaxTemp || 1;
    const maxOffsetSkyCondition = options.maxOffsetSkyCondition || 1;
    const maxTotalOffset = options.maxTotalOffset || 5;
    
    // Schedule Override Logic: 
    // If the active schedule slot has changed since the last run, 
    // we force the currentTargetTemp to match the new scheduled temperature.
    if (scheduledTime !== options._lastScheduledTime) {
        // Retain the current target from the overnight setpoint, use as safety floor later.
        const previousTargetTemp = options.currentTargetTemp;
        // Default to setting the target temp to the new setpoint.
        options.currentTargetTemp = scheduledTemp;

        // Consider adjustments now.
        if (activeSchedule.index === 0 && options.useWeatherAdjustments) {
            // Transitioning to the first setpoint of the day: consider optimizations if configured.
            // The idea is to consider the forecast and see if we should reduce the target temperature
            // from the scheduled target temperature for today.
            log.info(`${LOG_TAG} Transitioning to morning setpoint. Evaluating weather-based offsets.`, logLevel);
            let offset = 0;

            const forecastInfo = await getForecast(lat, lon, forecastWindowHours,logLevel);
            if (forecastInfo) {
                const { forecastSunnyPercent, tempAvgWindow, tempMaxWindow } = forecastInfo;

                // Calculate an offset based on sky condition. forecastSunnyPercent is a factor between 0 and 1 based on
                // how sunny the next forecastWindowHours hour are.
                const offsetSkyCondition = maxOffsetSkyCondition * forecastSunnyPercent;

                // This is positive if the forecast max temp is greater than the setpoint temp
                // and negative if the forecast max temp is lower than the setpoint temp.
                const forecastScheduleTempDelta = tempMaxWindow - scheduledTemp;

                log.debug(`${LOG_TAG} Adjustment Data: MaxTemp: ${tempMaxWindow}°C, Scheduled: ${scheduledTemp}°C, Delta: ${forecastScheduleTempDelta.toFixed(2)}`, logLevel);

                if (forecastScheduleTempDelta <= forecastMaxTempDeltaTrigger) {
                    // Forecast max temp is too far below the setpoint to rely on
                    // sunshine to help heat the house.
                    log.info(`${LOG_TAG} Weather Adjustment Scenario A: Too cold (Delta ${forecastScheduleTempDelta.toFixed(1)} <= ${forecastMaxTempDeltaTrigger}). No adjustment.`, logLevel);
                } else if (forecastScheduleTempDelta > forecastMaxTempDeltaTrigger && forecastScheduleTempDelta <= 0) {
                    // Forecast max temp is no colder than 10 degrees below but not greater
                    // than the setpoint. Here the sun will make a difference, we'll take off up to
                    // maxOffsetMaxTemp degrees from the setpoint.
                    log.info(`${LOG_TAG} Weather Adjustment Scenario B: Interpolating based on forecast max.`, logLevel);
                    
                    // Assuming forecastMaxTempDeltaTrigger = -10 as an example,
                    // this mapping results in the following offsets for forecastScheduleTempDelta value:
                    // -10 => 0, -5 => 0.5 * maxOffsetMaxTemp, 0 => maxOffsetMaxTemp
                    const offsetMaxTemp =
                        ((forecastScheduleTempDelta - forecastMaxTempDeltaTrigger) / -forecastMaxTempDeltaTrigger) * maxOffsetMaxTemp;

                    // Note the offset should be positive. It gets subtracted from the target temp below.
                    offset = offsetMaxTemp + offsetSkyCondition;
                    log.debug(`${LOG_TAG} Scenario B details: offsetMaxTemp=${offsetMaxTemp.toFixed(2)}, offsetSkyCondition=${offsetSkyCondition.toFixed(2)}`, logLevel);
                } else if (forecastScheduleTempDelta > 0) {
                    // Forecast max temp is greater than the setpoint temp.
                    // Carry over the max offset from Scenario B, plus apply the difference as an offset.
                    offset = maxOffsetMaxTemp + offsetSkyCondition + forecastScheduleTempDelta;
                    log.info(`${LOG_TAG} Weather Adjustment Scenario C: Warm day forecast (Delta ${forecastScheduleTempDelta.toFixed(1)}). Total offset: ${offset.toFixed(2)}`, logLevel);
                }
            } else {
                log.error(`${LOG_TAG} Failed to obtain the weather forecast.`, logLevel);
            }

            // Calculate adjusted temp, but don't drop below the previous (overnight) setpoint
            // and respect the maximum total offset allowed.
            const floorFromPrevious = previousTargetTemp ?? scheduledTemp;
            const floorFromMaxOffset = scheduledTemp - maxTotalOffset;
            const floor = Math.max(floorFromPrevious, floorFromMaxOffset);
            const scheduledTempAdjusted = Math.max(scheduledTemp - offset, floor);

            log.debug(`${LOG_TAG} Result: Target ${scheduledTemp} - Offset ${offset.toFixed(2)} = ${(scheduledTemp - offset).toFixed(2)}. Floor (Prev: ${floorFromPrevious.toFixed(1)}, MaxOff: ${floorFromMaxOffset.toFixed(1)}): ${floor.toFixed(1)}. Final: ${scheduledTempAdjusted.toFixed(1)}`, logLevel);

            log.info(
                `${LOG_TAG} Schedule transition to ${scheduledTime} (morning setpoint) detected. Target: ${scheduledTempAdjusted.toFixed(1)}°C (Scheduled: ${scheduledTemp}°C, Solar Adjustment: -${offset.toFixed(1)}°C)`,
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

    const now = Date.now();
    const lastOnSentTime = options._lastOnSentTime || 0;
    const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    const shouldSend =
        (pushCommand === 'always') || 
        (desiredState !== actualIsOn) || 
        (pushCommand === 'whileOn' && desiredState === true && (now - lastOnSentTime >= REFRESH_INTERVAL_MS));

    if (shouldSend) {
        log.info(`${LOG_TAG} Issuing furnace command: ${desiredState ? 'ON' : 'OFF'} (Mode: ${pushCommand}, Temp: ${currentValue}°)`, logLevel);
        try {
            await addCommand(targetDevice, { [targetSubDevice]: { setState: desiredState } });
            if (desiredState === true) options._lastOnSentTime = now;
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