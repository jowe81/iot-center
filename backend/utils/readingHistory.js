const series = new Map();
const extremes = new Map();
const retainMs = new Map();

const seriesKey = (deviceId, key) => `${deviceId}|${key}`;

const localDay = (timeMs) => {
    const date = new Date(timeMs);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

const prune = (id, nowMs) => {
    const keep = retainMs.get(id);
    if (!keep) return;
    const points = series.get(id);
    if (!points) return;
    const cutoff = nowMs - keep;
    let drop = 0;
    while (drop < points.length && points[drop].time < cutoff) drop += 1;
    if (drop > 0) points.splice(0, drop);
};

/**
 * Remembers one reported numeric reading.
 * Daily high and low reset at local midnight. Samples older than the longest
 * requested trend window are dropped.
 */
export const recordSample = (deviceId, key, timeMs, value) => {
    if (!deviceId || !key || !Number.isFinite(timeMs) || !Number.isFinite(value)) return null;

    const id = seriesKey(deviceId, key);
    const points = series.get(id) || [];
    const last = points[points.length - 1];
    if (!last || last.time !== timeMs || last.value !== value) {
        if (last && last.time === timeMs) last.value = value;
        else points.push({ time: timeMs, value });
        series.set(id, points);
    }
    prune(id, timeMs);

    const day = localDay(timeMs);
    let extreme = extremes.get(id);
    if (!extreme || extreme.day !== day) {
        extreme = { day, high: value, low: value };
    } else {
        if (value > extreme.high) extreme.high = value;
        if (value < extreme.low) extreme.low = value;
    }
    extremes.set(id, extreme);
    return extreme;
};

export const samplesInWindow = (deviceId, key, startMs, endMs) => {
    const id = seriesKey(deviceId, key);
    const windowMs = endMs - startMs;
    if (windowMs > 0) retainMs.set(id, Math.max(retainMs.get(id) || 0, windowMs));
    prune(id, endMs);
    const points = series.get(id) || [];
    return points.filter((point) => point.time >= startMs && point.time <= endMs);
};
