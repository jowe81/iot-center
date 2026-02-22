/**
 * Woodstove State Plugin
 * Analyzes temperature data to determine woodstove running mode.
 */
export const run = async (deviceId, filteredData, inputs, outputKey, options, db, lastRecord, previousValue) => {
    // inputs contains values for keys defined in config
    const inputKeys = Object.keys(inputs);
    if (inputKeys.length === 0) return "off";

    // Assume the first input key is the temperature
    const tempKey = inputKeys[0];
    const currentTemp = inputs[tempKey];

    if (typeof currentTemp !== 'number') return "off";

    let previousState = previousValue || 'off';
    previousState = previousState.toLowerCase();

    // Thresholds
    const T_WARMUP = options.warmupTemp || 30;
    const T_REFUEL = options.refuelTemp || 42;
    const T_COOLDOWN = options.cooldownTemp || 38;
    const T_OFF = options.offTemp || 26;
    const HYSTERESIS = options.hysteresis || 2;

    let newState = previousState;

    switch (previousState) {
        case 'off':
            if (currentTemp > T_WARMUP) newState = 'warmup';
            break;
        case 'warmup':
            if (currentTemp > T_REFUEL) newState = 'running';
            else if (currentTemp < T_OFF) newState = 'off';
            break;
        case 'running':
            if (currentTemp < T_REFUEL) newState = 'refuel';
            break;
        case 'refuel':
            if (currentTemp > T_REFUEL + HYSTERESIS) newState = 'running'; // Hysteresis
            else if (currentTemp < T_COOLDOWN) newState = 'cooldown';
            break;
        case 'cooldown':
            if (currentTemp < T_OFF) newState = 'off';
            else if (currentTemp > T_REFUEL) newState = 'running';
            else if (currentTemp > T_WARMUP) newState = 'warmup';
            break;
        default:
            newState = 'off';
    }

    return newState;
};