import { createRequire } from 'module';
import suncalc from 'suncalc';
import log from '../utils/logger.js';
import { addCommand } from './commandService.js';
import { getDeviceByKey } from './logicalDeviceManager.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');

const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute
const lastRunTimestamps = new Map();
const LOG_TAG = '[Scheduler]';

/**
 * Checks all configured schedules and queues commands if their triggers are met.
 * @param {boolean} isInitialRun - If true, past schedules for the current day will be skipped.
 */
const checkSchedules = async (isInitialRun = false) => {
    log.debug(`${LOG_TAG} Checking schedules...${isInitialRun ? ' (Initial Run)' : ''}`);
    const now = new Date();
    const schedules = iotConfig.schedules || [];
    const location = iotConfig.system?.location;
    const schedulerOptions = iotConfig.system?.scheduler || {};

    if (schedules.length === 0) {
        return;
    }

    // Pre-calculate celestial times if needed for any active schedule
    let celestialTimes;
    if (location && schedules.some(s => s.enabled && s.trigger.type === 'celestial')) {
        if (typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
            log.error(`${LOG_TAG} Celestial schedule configured, but system.location latitude/longitude is missing or invalid.`);
            return;
        }
        celestialTimes = suncalc.getTimes(now, location.latitude, location.longitude);

        if (schedulerOptions.log) {
            const futureEvents = Object.entries(celestialTimes)
                .map(([event, time]) => ({ event, time }))
                .filter(({ time }) => time > now)
                .sort((a, b) => a.time.getTime() - b.time.getTime());

            let nextEvent;
            let isTomorrow = false;

            if (futureEvents.length > 0) {
                nextEvent = futureEvents[0];
            } else {
                const tomorrow = new Date(now);
                tomorrow.setDate(now.getDate() + 1);
                const tomorrowTimes = suncalc.getTimes(tomorrow, location.latitude, location.longitude);
                const sortedTomorrowEvents = Object.entries(tomorrowTimes)
                    .map(([event, time]) => ({ event, time }))
                    .sort((a, b) => a.time.getTime() - b.time.getTime());
                if (sortedTomorrowEvents.length > 0) {
                    nextEvent = sortedTomorrowEvents[0];
                    isTomorrow = true;
                }
            }

            if (nextEvent) {
                const timeToNext = nextEvent.time.getTime() - now.getTime();
                const hours = Math.floor(timeToNext / (1000 * 60 * 60));
                const minutes = Math.floor((timeToNext % (1000 * 60 * 60)) / (1000 * 60));
                log.debug(`${LOG_TAG} Next celestial event is '${nextEvent.event}' in ${hours}h ${minutes}m${isTomorrow ? ' (tomorrow)' : ''}.`);
            }
        }
    }

    for (const schedule of schedules) {
        if (!schedule.enabled) {
            continue;
        }

        let triggerTime;
        const { trigger } = schedule;

        try {
            if (trigger.type === 'celestial') {
                if (!celestialTimes) continue; // Location missing, logged above
                const eventTime = celestialTimes[trigger.event];
                if (eventTime instanceof Date && !isNaN(eventTime)) {
                    triggerTime = new Date(eventTime);
                    if (trigger.offsetMinutes) {
                        triggerTime.setMinutes(triggerTime.getMinutes() + trigger.offsetMinutes);
                    }
                }
            } else if (trigger.type === 'daily') {
                const [hour, minute] = trigger.time.split(':').map(Number);
                triggerTime = new Date(now);
                triggerTime.setHours(hour, minute, 0, 0);
            }
        } catch (e) {
            log.error(`${LOG_TAG} Error calculating trigger time for schedule "${schedule.name}"`, e);
            continue;
        }

        if (triggerTime) {
            const lastRun = lastRunTimestamps.get(schedule.name);

            // On the initial run, if a trigger time is in the past for today,
            // set its last run time to now to prevent it from running, then skip.
            if (isInitialRun && now >= triggerTime) {
                log.info(`${LOG_TAG} Skipping past schedule "${schedule.name}" on initial run.`);
                lastRunTimestamps.set(schedule.name, now);
                continue;
            }
            // Condition: current time is past the trigger time, AND
            // (we have never run this OR the last run was before this trigger time)
            if (now >= triggerTime && (!lastRun || lastRun < triggerTime)) {
                log.info(`${LOG_TAG} Triggering schedule "${schedule.name}"`);
                for (const target of schedule.targets) {
                    try {
                        const logicalDevice = await getDeviceByKey(target.deviceKey);
                        if (logicalDevice) {
                            await logicalDevice.sendCommand(target.command);
                        } else {
                            if (target.command && typeof target.command === "object") {
                                await addCommand(target.deviceId, target.command);
                                log.info(`${LOG_TAG} Queued command object for ${target.deviceId}`);
                            } else {
                                await addCommand(target.deviceId, {
                                    [target.subDevice]: { [target.command]: target.argument },
                                });
                                log.info(
                                    `${LOG_TAG} Queued command "${target.command}" for ${target.deviceId}/${target.subDevice}`,
                                );
                            }
                        }
                    } catch (e) {
                        log.error(`${LOG_TAG} Failed to queue command for schedule "${schedule.name}"`, e);
                    }
                }
                lastRunTimestamps.set(schedule.name, now);
            }
        }
    }
};

/**
 * Initializes the scheduler service, starting the periodic check.
 */
export const initSchedulerService = () => {
    if (iotConfig.schedules && iotConfig.schedules.length > 0) {
        log.info(`${LOG_TAG} Initializing...`);
        checkSchedules(true); // Run once on startup, skipping past events for today
        setInterval(checkSchedules, CHECK_INTERVAL_MS);
    }
};