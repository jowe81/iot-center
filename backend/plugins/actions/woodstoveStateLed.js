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
    warmup: {
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
 * @param {Array} currentValues Array of values from the defined sources.
 * @param {object} options The options block from the action configuration.
 */
export const run = async (currentValues, options) => {
    const { targetDevice, targetSubDevice } = getTarget(options);    

    // Architecture change: read the first element from the new currentValue array
    const currentValue = Array.isArray(currentValues) ? currentValues[0] : currentValues;

    const logLevel = options.log;
    log.debug(`${LOG_TAG} running with value: ${currentValue}`, logLevel);

    if (currentValue === undefined || currentValue === null) {
        log.debug(`${LOG_TAG} No current value provided, exiting.`, logLevel);
        return;
    }

    const state = String(currentValue).toLowerCase();

    if (options._lastState === state) {
        log.debug(`${LOG_TAG} State "${state}" unchanged. Skipping command.`, logLevel);
        return;
    }

    const commandConfig = STATE_TO_COMMAND_MAP[state];

    if (commandConfig) {
        log.info(
            `${LOG_TAG} State "${state}" matches. Queuing commands: ${JSON.stringify(commandConfig)} for ${targetDevice}/${targetSubDevice}`,
            logLevel
        );

        try {
            await addCommand(targetDevice, { [targetSubDevice]: commandConfig });
            options._lastState = state;
        } catch (e) {
            log.error(`${LOG_TAG} Failed to queue command`, e);
        }
    } else {
        options._lastState = state;
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
    };
}
