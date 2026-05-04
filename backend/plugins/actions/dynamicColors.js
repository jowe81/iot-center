import log from "../../utils/logger.js";
import { addCommand } from "../../controllers/commandService.js";

const LOG_TAG = "[Action: DynamicColors]";

/**
 * Converts a value to an RGB color based on a range.
 * Low value is blue, high value is red. Middle can be green or magenta depending on useGreen.
 * @param {number} value The current value.
 * @param {number} lowBoundary The bottom of the range.
 * @param {number} highBoundary The top of the range.
 * @param {number} saturationFactor Factor between 0 (white) and 1 (pure color).
 * @param {boolean} useGreen Whether to go through green in the middle (true) or magenta (false).
 * @returns {{r: number, g: number, b: number}} An object with RGB values.
 */
const valueToColor = (value, lowBoundary, highBoundary, saturationFactor = 1, useGreen = true) => {
    // Clamp the value to the defined range
    const clampedValue = Math.max(lowBoundary, Math.min(value, highBoundary));

    // Calculate the fraction (0.0 to 1.0) of the value within the range
    const fraction = (clampedValue - lowBoundary) / (highBoundary - lowBoundary);

    let r, g, b;

    if (useGreen) {
        if (fraction < 0.5) {
            // Blue to Green
            const localFraction = fraction * 2;
            r = 0;
            g = Math.round(255 * localFraction);
            b = Math.round(255 * (1 - localFraction));
        } else {
            // Green to Red
            const localFraction = (fraction - 0.5) * 2;
            r = Math.round(255 * localFraction);
            g = Math.round(255 * (1 - localFraction));
            b = 0;
        }
    } else {
        // Blue to Red (via Magenta)
        r = Math.round(255 * fraction);
        g = 0;
        b = Math.round(255 * (1 - fraction));
    }

    // Apply saturation (mix with white)
    r = Math.round(r * saturationFactor + 255 * (1 - saturationFactor));
    g = Math.round(g * saturationFactor + 255 * (1 - saturationFactor));
    b = Math.round(b * saturationFactor + 255 * (1 - saturationFactor));

    return { r, g, b };
};

/**
 * Reads a value and sets an RGB device color accordingly.
 * @param {Array} currentValues Array of values from the defined sources.
 * @param {object} options The options block from the action configuration.
 */
export const run = async (currentValues, options) => {
    const { targetDevice, targetSubDevice } = getTarget(options);    

    // Architecture change: read the first element from the new currentValue array
    const currentValue = Array.isArray(currentValues) ? currentValues[0] : currentValues;

    const logLevel = options.log;
    log.debug(`${LOG_TAG} running with value: ${currentValue}`, logLevel);

    if (typeof currentValue !== "number") {
        log.warn(`${LOG_TAG} Invalid value provided (${currentValue}), exiting.`, logLevel);
        return;
    }

    const resolution = options.resolution || 1;
    const value = Math.round(currentValue / resolution) * resolution;

    const lowBoundary = options.lowBoundary || 0;
    const highBoundary = options.highBoundary || 100;
    const saturationFactor = options.saturationFactor ?? 1;
    const useGreen = options.useGreen !== false;

    const { r, g, b } = valueToColor(value, lowBoundary, highBoundary, saturationFactor, useGreen);

    const colorKey = `${r},${g},${b}`;
    if (options._lastColor === colorKey) {
        log.debug(`${LOG_TAG} Color unchanged (${colorKey}). Skipping command.`, logLevel);
        return;
    }

    const now = Date.now();
    const lastSent = options._lastSentTime || 0;

    // Set a minimum interval for data transmission.
    const minInterval = (options.minIntervalMinutes ?? 5) * 60 * 1000;

    if (now - lastSent < minInterval) {
        log.debug(
            `${LOG_TAG} Rate limit active (last sent ${Math.round((now - lastSent) / 1000)}s ago). Skipping command.`,
            logLevel,
        );
        return;
    }

    const commandConfig = { setR: r, setG: g, setB: b };

    log.info(
        `${LOG_TAG} Value ${currentValue.toFixed(2)} -> Color(R:${r},G:${g},B:${b}). Queuing command for ${targetDevice}/${targetSubDevice}`,
        logLevel,
    );
    await addCommand(targetDevice, { [targetSubDevice]: commandConfig });
    options._lastColor = colorKey;
    options._lastSentTime = now;
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