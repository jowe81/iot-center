export const isRedundant = (valA, valB, valC) => {
    const strA = JSON.stringify(valA);
    const strB = JSON.stringify(valB);
    const strC = JSON.stringify(valC);
    return strA === strB && strB === strC;
};

export const getValue = (doc, path) => {
    return path.split('.').reduce((acc, part) => acc && acc[part], doc);
};

export const findDataKeys = (obj, prefix = '') => {
    const keys = [];
    const traverse = (o, p) => {
        for (const key in o) {
            if (key === 'receivedAt' || key === '_id' || key === 'deviceId' || key === 'protocol') continue;
            if (typeof o[key] === 'object' && o[key] !== null && !Array.isArray(o[key]) && !(o[key] instanceof Date)) {
                traverse(o[key], p + key + '.');
            } else {
                keys.push(p + key);
            }
        }
    };
    traverse(obj, prefix);
    return keys;
};


/**
 * Detects a voltage plateau using millisecond-based windows.
 * * @param {Array} data - Array of data objects
 * @param {string} vKey - Key for voltage
 * @param {string} tKey - Key for timestamp
 * @param {number} cutoffTimestamp - The "now" point (ms)
 * @param {number} windowMs - Duration of each window in ms (e.g., 900000 for 15 min)
 */
export const detectPlateauAtTime = (data, vKey, tKey, cutoffTimestamp = null, windowMs = 900000) => {
    
    // Helper to get median voltage within a specific time range
    const getMedianInRange = (startTime, endTime) => {
        const values = data
            .filter(item => item[tKey] > startTime && item[tKey] <= endTime)
            .map(item => item[vKey])
            .filter(v => v != null)
            .sort((a, b) => a - b);

        if (values.length === 0) return null;
        return values[Math.floor(values.length / 2)];
    };

    if (cutoffTimestamp === null) {
        cutoffTimestamp = new Date().getTime();
    }
    // Define our three temporal buckets
    const vNow     = getMedianInRange(cutoffTimestamp - windowMs,      cutoffTimestamp);
    const vRecent  = getMedianInRange(cutoffTimestamp - (windowMs*2),  cutoffTimestamp - windowMs);
    const vHistory = getMedianInRange(cutoffTimestamp - (windowMs*3),  cutoffTimestamp - (windowMs*2));

    // If any bucket is empty, we can't reliably determine the state
    if (vNow === null || vRecent === null || vHistory === null) {
        return { isPlateau: false, status: "gap_in_data" };
    }

    const currentRate = vNow - vRecent;    
    const previousRate = vRecent - vHistory;

    // Logic: Is it flat now, but was it climbing earlier?
    const isFlat = Math.abs(currentRate) < 0.01;
    const wasClimbing = previousRate > 0.03;
    const isCharging = vNow > 13.0;

    return {
        isPlateau: isFlat && wasClimbing && isCharging,
        voltage: vNow,
        currentDelta: currentRate.toFixed(4),
        previousDelta: previousRate.toFixed(4),
        vNow,
        vRecent,
        vHistory,
        
    };
}