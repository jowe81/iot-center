import log from '../../utils/logger.js';

/**
 * Virtual Device plugin for an old ESP8266 that requires polling.
 */
export const run = async (deviceId, db, config) => {
    const url = 'http://192.168.1.23/read';
    const LOG_TAG = `[Plugin: ESP8266LegacyDevice]`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const rawData = await response.json();

        // Initialize return array with a system status object
        const data = [
            {
                type: "System",
                subtype: "DeviceStatus",
                name: "connectivity",
                deviceId: deviceId,
                online: true
            }
        ];

        // Map temperature sensors to the standard Sensor format
        if (rawData.temperature_sensors && Array.isArray(rawData.temperature_sensors)) {
            rawData.temperature_sensors.forEach((sensor, index) => {
                let name = `temp_${index}`;

                switch (index) {
                    case 0:
                        name = 'crawlSpace';
                        break;
                    case 1:
                        name = 'laundryRoom';
                        break;

                }
                data.push({
                    type: "Sensor",
                    subtype: "DS18B20",
                    name,
                    tempC: sensor.tempC
                });
            });
        }

        return data;
    } catch (error) {
        log.error(`${LOG_TAG} Error polling legacy device ${deviceId} at ${url}: ${error.message}`);
        return null;
    }
};