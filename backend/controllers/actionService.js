import { createRequire } from 'module';
import log from '../utils/logger.js';
import { getDb } from '../config/db.js';
import { getValue } from '../utils/dataUtils.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');
const LOG_TAG = '[ActionService]';

const loadedPlugins = {};
let runningActions = [];

const getPlugin = async (name) => {
    if (loadedPlugins[name]) {
        return loadedPlugins[name];
    }
    if (!name.match(/^[a-zA-Z0-9_-]+$/)) {
        log.error(`${LOG_TAG} Invalid plugin name requested: ${name}`);
        return null;
    }
    try {
        const plugin = await import(`../plugins/actions/${name}.js`);
        loadedPlugins[name] = plugin;
        return plugin;
    } catch (e) {
        log.error(`${LOG_TAG} Could not load action plugin ${name}`, e);
        return null;
    }
};

const executeAction = async (actionConfig, currentValue) => {
    log.debug(`${LOG_TAG} Executing action: ${actionConfig.name} with value ${currentValue}`);
    try {
        const plugin = await getPlugin(actionConfig.plugin);
        if (!plugin || !plugin.run) {
            log.error(`${LOG_TAG} Plugin ${actionConfig.plugin} not found or has no run method.`);
            return;
        }
        await plugin.run(currentValue, actionConfig.options);
    } catch (e) {
        log.error(`${LOG_TAG} Error executing action "${actionConfig.name}"`, e);
    }
};

const runActionWithLatestData = async (actionConfig) => {
    log.debug(`${LOG_TAG} Running action with latest data: ${actionConfig.name}`);
    try {
        const db = getDb();
        const collection = db.collection(`device_${actionConfig.options.sourceDevice}`);
        const latestDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });

        if (!latestDoc) {
            log.debug(`${LOG_TAG} No data for source device ${actionConfig.options.sourceDevice} for action "${actionConfig.name}"`);
            return;
        }

        const currentValue = getValue(latestDoc, actionConfig.options.sourceKey);
        if (currentValue !== undefined) {
            await executeAction(actionConfig, currentValue);
        }
    } catch (e) {
        log.error(`${LOG_TAG} Error running action "${actionConfig.name}" with latest data`, e);
    }
};

export const runDataDrivenActions = async (deviceId, dataDoc) => {
    // Backward compatibility: if trigger is missing, it can't be data-driven.
    const actions = (iotConfig.actions || []).filter(a =>
        a.enabled &&
        a.trigger?.type === 'data' &&
        a.options?.sourceDevice === deviceId
    );

    if (actions.length === 0) {
        return;
    }

    log.debug(`${LOG_TAG} Checking for data-driven actions for device ${deviceId}`);
    for (const action of actions) {
        const currentValue = getValue(dataDoc, action.options.sourceKey);
        if (currentValue !== undefined) {
            await executeAction(action, currentValue);
        }
    }
};

export const initActionService = () => {
    const previouslyRunningActions = [...runningActions];

    // Clear existing intervals
    previouslyRunningActions.forEach(({ intervalId }) => {
        if (intervalId) clearInterval(intervalId);
    });
    runningActions = [];

    const actions = iotConfig.actions || [];
    if (actions.length > 0) {
        log.info(`${LOG_TAG} Initializing...`);
        actions.forEach(action => {
            if (action.enabled) {
                // Default to 'interval' for backward compatibility if trigger object is missing
                const triggerType = action.trigger?.type || 'interval';

                if (triggerType === 'interval') {
                    const interval = action.interval || action.trigger?.interval || 60000;
                    log.info(`${LOG_TAG} Scheduling action "${action.name}" to run every ${interval}ms`);
                    const id = setInterval(() => runActionWithLatestData(action), interval);
                    runningActions.push({ action, intervalId: id });
                } else if (triggerType === 'data') {
                    log.info(`${LOG_TAG} Initializing data-driven action "${action.name}", running once with latest data.`);
                    // Run once on startup to set initial state based on last known value.
                    runActionWithLatestData(action);
                    runningActions.push({ action, intervalId: null });
                }
            }
        });
    }

    // Find disabled actions and run their stop method
    previouslyRunningActions.forEach(async ({ action: prevAction }) => {
        const currentAction = (iotConfig.actions || []).find(a => a.name === prevAction.name);
        if (!currentAction || currentAction.enabled === false) {
            log.info(`${LOG_TAG} Action "${prevAction.name}" has been disabled. Calling stop method.`);
            try {
                const plugin = await getPlugin(prevAction.plugin);
                if (plugin && plugin.stop) {
                    await plugin.stop(prevAction.options);
                } else {
                    log.debug(`${LOG_TAG} Plugin ${prevAction.plugin} for action "${prevAction.name}" has no stop method.`);
                }
            } catch (e) {
                log.error(`${LOG_TAG} Error running stop method for action "${prevAction.name}"`, e);
            }
        }
    });
};

export const reloadActions = () => {
    log.info(`${LOG_TAG} Reloading actions...`);
    initActionService();
};