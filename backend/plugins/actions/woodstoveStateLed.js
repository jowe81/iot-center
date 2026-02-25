import log from '../../utils/logger.js';
import { addCommand } from '../../controllers/commandService.js';

const LOG_TAG = '[Action: WoodstoveStateLed]';

/**
 * Reads a state value and issues a command based on a configuration map.
 * @param {*} currentValue The value read from the sourceKey.
 * @param {object} options The options block from the action configuration.
 */
export const run = async (currentValue, options) => {
    const doLog = options.log === true;
    if (doLog) log.debug(`${LOG_TAG} running with value: ${currentValue}`);

    if (currentValue === undefined || currentValue === null) {
        if (doLog) log.debug(`${LOG_TAG} No current value provided, exiting.`);
        return;
    }

    const state = String(currentValue).toLowerCase();
    const commandMap = options.stateToCommandMap || {};
    const commandConfig = commandMap[state];

    if (commandConfig) {
        if (doLog) {
            log.debug(`${LOG_TAG} State "${state}" matches. Queuing commands: ${JSON.stringify(commandConfig)} for ${options.targetDevice}/${options.targetSubDevice}`);
        }

        try {
            await addCommand(options.targetDevice, { [options.targetSubDevice]: commandConfig });
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue command`, e);
        }
    }
};