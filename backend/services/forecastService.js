import log from '../utils/logger.js';

const LOG_TAG = '[Forecast]';
const CACHE_MS = 30 * 60 * 1000;

const cache = new Map();

const isSunny = (conditionText) => {
    if (!conditionText) return false;
    const terms = ['sunny', 'partly cloudy', 'clear'];
    return terms.some(term => conditionText.toLowerCase().includes(term));
};

const toNumber = (value) => {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
};

const parseClockMinutes = (hhmm, fallback) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
    if (!match) return fallback;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return fallback;
    return hours * 60 + minutes;
};

/**
 * Day window is [dayStart, nightStart) in local time. Default is 05:00 through 17:00.
 */
export const isDaytimeWindow = (date, dayStart = '05:00', nightStart = '17:00') => {
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    const start = parseClockMinutes(dayStart, 5 * 60);
    const end = parseClockMinutes(nightStart, 17 * 60);
    if (start === end) return true;
    if (start < end) return nowMinutes >= start && nowMinutes < end;
    return nowMinutes >= start || nowMinutes < end;
};

const periodValue = (period, role) => {
    if (!period?.temperature) return null;
    if (role === 'high') return toNumber(period.temperature.periodHigh ?? period.temperature.metric);
    return toNumber(period.temperature.periodLow ?? period.temperature.metric);
};

export const dailyHighLow = (place) => {
    const periods = Array.isArray(place?.dailyFcst?.daily) ? place.dailyFcst.daily : [];
    const today = periods.find((period) => String(period.periodLabel || '').toLowerCase() === 'today');
    const tonight = periods.find((period) => String(period.periodLabel || '').toLowerCase() === 'tonight');
    return {
        todayHigh: periodValue(today, 'high'),
        tonightLow: periodValue(tonight, 'low'),
    };
};

const cacheKey = (lat, lon) => `${lat},${lon}`;

const loadPlace = async (lat, lon, logLevel) => {
    const key = cacheKey(lat, lon);
    const cached = cache.get(key);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < CACHE_MS) {
        return { ...cached, refreshed: false };
    }

    const url = `https://weather.gc.ca/api/app/v3/en/Location/${lat},${lon}?type=city`;
    try {
        log.info(`${LOG_TAG} Fetching forecast for ${lat},${lon}`, logLevel);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Weather API error: ${response.status}`);
        }
        const rawData = await response.json();
        const place = Array.isArray(rawData) && rawData.length ? rawData[0] : null;
        if (!place) {
            throw new Error('Weather API returned no location');
        }

        const parsed = dailyHighLow(place);
        const entry = {
            fetchedAt: now,
            place,
            todayHigh: parsed.todayHigh ?? cached?.todayHigh ?? null,
            tonightLow: parsed.tonightLow ?? cached?.tonightLow ?? null,
        };
        cache.set(key, entry);
        log.info(
            `${LOG_TAG} Today high ${entry.todayHigh ?? 'n/a'}°C, tonight low ${entry.tonightLow ?? 'n/a'}°C`,
            logLevel,
        );
        return { ...entry, refreshed: true };
    } catch (error) {
        log.error(`${LOG_TAG} ${error.message}`, error, logLevel);
        if (cached?.place) {
            const entry = { ...cached, fetchedAt: now };
            cache.set(key, entry);
            return { ...entry, refreshed: false };
        }
        const entry = { fetchedAt: now, place: null, todayHigh: null, tonightLow: null };
        cache.set(key, entry);
        return { ...entry, refreshed: false };
    }
};

const summarizeHourly = (place, forecastWindowHours) => {
    const hourlyForecastRaw = place.hourlyFcst?.hourly;
    if (!Array.isArray(hourlyForecastRaw) || hourlyForecastRaw.length < forecastWindowHours) {
        return null;
    }

    const currentlySunny = isSunny(place.observation?.condition);
    const firstDate = hourlyForecastRaw[0].date;
    const hourlyForecast = [];
    hourlyForecastRaw.forEach((info, index) => {
        if (info.date === firstDate || index < forecastWindowHours) {
            hourlyForecast.push(info);
        }
    });

    const conditionHourly = hourlyForecast.slice(0, forecastWindowHours).map((info) => info.condition);
    const sunnyHoursCount = conditionHourly.filter(isSunny).length + (currentlySunny ? 1 : 0);
    const forecastSunnyPercent = sunnyHoursCount / (conditionHourly.length + 1);

    const tempHourly = hourlyForecast.map((info) => parseInt(info.temperature?.metric, 10));
    const tempHourlyWindow = tempHourly.slice(0, forecastWindowHours);
    const tempAvgWindow = tempHourlyWindow.reduce((sum, temp) => sum + temp, 0) / tempHourlyWindow.length;
    const tempMaxWindow = tempHourlyWindow.reduce((max, temp) => Math.max(max, temp), -Infinity);
    const tempMaxToday = tempHourly.reduce((max, temp) => Math.max(max, temp), -Infinity);

    return {
        currentlySunny,
        forecastSunnyPercent,
        forecastCloudy: 1 - forecastSunnyPercent,
        tempAvgWindow,
        tempMaxWindow,
        tempMaxToday,
    };
};

/**
 * Shared Environment Canada forecast, cached for 30 minutes per lat/lon.
 * A failed refresh keeps the last good forecast.
 */
export const getForecast = async (lat, lon, forecastWindowHours = 7, logLevel) => {
    const entry = await loadPlace(lat, lon, logLevel);
    if (!entry?.place) return null;

    const summary = summarizeHourly(entry.place, forecastWindowHours);
    if (!summary) {
        log.error(`${LOG_TAG} Weather API returned unexpected hourly data.`, null, logLevel);
        return null;
    }

    if (entry.refreshed) {
        log.info(`${LOG_TAG} Currently sunny? ${summary.currentlySunny ? 'Yes' : 'No'}`, logLevel);
        log.info(`${LOG_TAG} Forecast sunny? ${summary.forecastSunnyPercent.toFixed(2)}`, logLevel);
        log.info(`${LOG_TAG} Avg temp during ${forecastWindowHours}h window: ${summary.tempAvgWindow}°C`, logLevel);
        log.info(`${LOG_TAG} Max temp during ${forecastWindowHours}h window: ${summary.tempMaxWindow}°C`, logLevel);
        log.info(`${LOG_TAG} Max temp forecast for today: ${summary.tempMaxToday}°C`, logLevel);
    }

    return {
        ...summary,
        todayHigh: entry.todayHigh,
        tonightLow: entry.tonightLow,
    };
};

export const getDailyHighLow = async (lat, lon, logLevel) => {
    const entry = await loadPlace(lat, lon, logLevel);
    return {
        todayHigh: entry?.todayHigh ?? null,
        tonightLow: entry?.tonightLow ?? null,
    };
};
