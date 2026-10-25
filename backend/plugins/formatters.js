import log from '../utils/logger.js';
import { recordSample, samplesInWindow } from '../utils/readingHistory.js';

const LOG_TAG = '[Formatter]';

/**
 * Formatters transform a value before it is published.
 * Each export is (value, options) => nextValue. Chain them from config:
 *   "formatters": [
 *     { "name": "round", "decimals": 1 },
 *     { "name": "suffix", "text": "°" }
 *   ]
 */

export const round = (value, options = {}) => {
    const decimals = Number.isInteger(options.decimals) ? options.decimals : 0;
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return value;
    return number.toFixed(decimals);
};

export const prefix = (value, options = {}) => {
    return `${options.text ?? ''}${value ?? ''}`;
};

export const suffix = (value, options = {}) => {
    return `${value ?? ''}${options.text ?? ''}`;
};

export const template = (value, options = {}) => {
    const pattern = options.template ?? '{value}';
    return String(pattern).replaceAll('{value}', value ?? '');
};

export const map = (value, options = {}) => {
    const values = options.values || {};
    if (Object.prototype.hasOwnProperty.call(values, value)) return values[value];
    const key = String(value);
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    if (options.default !== undefined) return options.default;
    return value;
};

const formatterSteps = (formatters) => {
    if (!formatters) return [];
    return Array.isArray(formatters) ? formatters : [formatters];
};

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
    return sorted[mid];
};

/**
 * Compares the older half of a time window with the newer half.
 * Returns "up", "down", "stable", or null when there is not enough history.
 * A change within threshold (same units as the value) counts as stable.
 */
export const resolveTrendDirection = (points, { now, windowMs, threshold = 0.5 } = {}) => {
    if (!Number.isFinite(now) || !Number.isFinite(windowMs) || windowMs <= 0) return null;

    const start = now - windowMs;
    const mid = now - windowMs / 2;
    const older = [];
    const newer = [];

    for (const point of points || []) {
        if (!point || !Number.isFinite(point.time) || !Number.isFinite(point.value)) continue;
        if (point.time < start || point.time > now) continue;
        if (point.time <= mid) older.push(point.value);
        else newer.push(point.value);
    }

    if (older.length === 0 || newer.length === 0) return null;

    const delta = median(newer) - median(older);
    const limit = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.5;
    if (Math.abs(delta) <= limit) return 'stable';
    return delta > 0 ? 'up' : 'down';
};

const trendGlyphs = { up: '↑', down: '↓', stable: '→' };

/**
 * Appends a trend glyph to the current text. Direction comes from readings kept
 * in memory for windowMinutes, not from the database.
 * Options: windowMinutes (30), threshold (0.5), up, down, stable.
 */
export const trend = (value, options = {}, context = {}) => {
    const current = Number(context.originalValue);
    const receivedAt = context.receivedAt instanceof Date
        ? context.receivedAt
        : new Date(context.receivedAt || Date.now());
    if (!context.deviceId || !context.key || !Number.isFinite(current) || Number.isNaN(receivedAt.getTime())) {
        return value;
    }

    const windowMinutes = Number(options.windowMinutes) > 0 ? Number(options.windowMinutes) : 30;
    const windowMs = windowMinutes * 60 * 1000;
    const now = receivedAt.getTime();
    recordSample(context.deviceId, context.key, now, current);
    const points = samplesInWindow(context.deviceId, context.key, now - windowMs, now);

    const direction = resolveTrendDirection(points, { now, windowMs, threshold: options.threshold });
    if (!direction) return value;

    const glyph = options[direction] ?? trendGlyphs[direction];
    log.debug(`${LOG_TAG} ${context.key} trend ${direction} over ${windowMinutes}m`);
    return `${value ?? ''}${glyph}`;
};

export const applyFormatters = async (value, formatters, context = {}) => {
    let current = value;
    for (const step of formatterSteps(formatters)) {
        const name = typeof step === 'string' ? step : step?.name;
        const fn = name && exports[name];
        if (typeof fn !== 'function') {
            log.error(`${LOG_TAG} Unknown formatter "${name}"`);
            continue;
        }
        try {
            const options = typeof step === 'string' ? {} : step;
            current = await fn(current, options, context);
        } catch (error) {
            log.error(`${LOG_TAG} Formatter "${name}" failed`, error);
        }
    }
    return current;
};

/**
 * Formats a Date with HH (24-hour), hh (12-hour), MM/mm (minutes), and ss (seconds).
 * "HH:MM" is 24-hour hours and minutes, from the server's local time.
 */
export const formatClock = (date, pattern = 'HH:MM') => {
    const hours = date.getHours();
    const tokens = {
        HH: String(hours).padStart(2, '0'),
        hh: String((hours % 12) || 12).padStart(2, '0'),
        MM: String(date.getMinutes()).padStart(2, '0'),
        mm: String(date.getMinutes()).padStart(2, '0'),
        ss: String(date.getSeconds()).padStart(2, '0'),
    };
    return String(pattern).replace(/HH|hh|MM|mm|ss/g, (token) => tokens[token]);
};

const exports = { round, prefix, suffix, template, map, trend };
