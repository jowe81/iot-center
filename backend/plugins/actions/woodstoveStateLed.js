import log from "../../utils/logger.js";
import { addCommand } from "../../controllers/commandService.js";

const LOG_TAG = "[Action: WoodstoveStateLed]";

const STATE_TO_COMMAND_MAP = {
    off: {
        setR: 0,
        setG: 0,
        setB: 0,
        setState: false,
        setPercentage: 0,
    },
    cooldown: {
        setR: 0,
        setG: 0,
        setB: 255,
        setState: true,
        setPercentage: 1,
    },
    warumup: {
        setR: 100,
        setG: 0,
        setB: 0,
        setState: true,
        setPercentage: 1,
    },
    running: {
        setR: 0,
        setG: 255,
        setB: 0,
        setState: true,
        setPercentage: 2,
    },
    refuel: {
        setR: 255,
        setG: 0,
        setB: 0,
        setState: true,
        setPercentage: 20,
    },
};

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

    if (options._lastState === state) {
        if (doLog) log.debug(`${LOG_TAG} State "${state}" unchanged. Skipping command.`);
        return;
    }

    const commandConfig = STATE_TO_COMMAND_MAP[state];

    if (commandConfig) {
        if (doLog) {
            log.debug(
                `${LOG_TAG} State "${state}" matches. Queuing commands: ${JSON.stringify(commandConfig)} for ${options.targetDevice}/${options.targetSubDevice}`,
            );
        }

        try {
            await addCommand(options.targetDevice, { [options.targetSubDevice]: commandConfig });
            options._lastState = state;
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue command`, e);
        }
    } else {
        options._lastState = state;
    }
};
