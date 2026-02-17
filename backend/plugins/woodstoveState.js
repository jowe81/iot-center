/**
 * Woodstove State Plugin
 * Analyzes temperature data to determine woodstove running mode.
 */
export const run = async (extractedDeviceData, deviceType, deviceSubtype, deviceName, db, options) => {
    // Dummy implementation for now
    // In the future, this will analyze extractedDeviceData.tempC and history from db
    // to determine if the stove is Off, Heating Up, Operating, or Cooling Down.

    return extractedDeviceData;
};