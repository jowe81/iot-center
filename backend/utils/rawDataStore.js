const rawDataStore = new Map();

export const saveRawData = (deviceId, data) => {
    rawDataStore.set(deviceId, data);
};

export const getRawData = (deviceId) => {
    return rawDataStore.get(deviceId);
};