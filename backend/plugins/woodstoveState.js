/**
 * Woodstove State Plugin
 * Analyzes temperature data to determine woodstove running mode.
 */
export const run = async (extractedDeviceData, deviceType, deviceSubtype, deviceName, db, options, fieldKeys) => {
    // Dummy implementation for now
    // In the future, this will analyze extractedDeviceData.tempC and history from db
    // to determine if the stove is Off, Heating Up, Operating, or Cooling Down.

    // fieldKeys contains any device metric key that is configured in iotConfig.json to be supplied by the plugin.
    const stateFieldKey = fieldKeys.length ? fieldKeys[0] : null;

    if (stateFieldKey) {
        // process data...
        //extractedDeviceData[stateFieldKey] = '...';
    }
    return extractedDeviceData;
};