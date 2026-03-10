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

const runAction = async (actionConfig) => {
    log.debug(`${LOG_TAG} Running action: ${actionConfig.name}`);
    try {
        const plugin = await getPlugin(actionConfig.plugin);
        if (!plugin || !plugin.run) {
            log.error(`${LOG_TAG} Plugin ${actionConfig.plugin} not found or has no run method.`);
            return;
        }

        const db = getDb();
        const collection = db.collection(`device_${actionConfig.options.sourceDevice}`);
        const latestDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });

        if (!latestDoc) {
            log.debug(`${LOG_TAG} No data found for source device ${actionConfig.options.sourceDevice} for action "${actionConfig.name}"`);
            return;
        }

        const currentValue = getValue(latestDoc, actionConfig.options.sourceKey);
        await plugin.run(currentValue, actionConfig.options);

    } catch (e) {
        log.error(`${LOG_TAG} Error running action "${actionConfig.name}"`, e);
    }
};

export const initActionService = () => {
    const previouslyRunningActions = [...runningActions];

    // Clear existing intervals
    previouslyRunningActions.forEach(({ intervalId }) => clearInterval(intervalId));
    runningActions = [];

    const actions = iotConfig.actions || [];
    if (actions.length > 0) {
        log.info(`${LOG_TAG} Initializing...`);
        actions.forEach(action => {
            if (action.enabled) {
                const interval = action.interval || 60000;
                log.info(`${LOG_TAG} Scheduling action "${action.name}" to run every ${interval}ms`);
                const id = setInterval(() => runAction(action), interval);
                runningActions.push({ action, intervalId: id });
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