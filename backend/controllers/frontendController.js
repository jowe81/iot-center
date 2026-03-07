import { createRequire } from 'module';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../config/db.js';
import log from '../utils/logger.js';
import { sendMqttCommand } from './mqttService.js';
import { addCommand, markCommandAsSent } from './commandService.js';
import { detectPlateauAtTime, getValue } from '../utils/dataUtils.js';
import { getRawData } from '../utils/rawDataStore.js';
import { reloadActions } from './actionService.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');

export const getDevices = async (req, res) => {
    try {
        const db = getDb();
        // List all collections
        const collections = await db.listCollections().toArray();
        // Filter for those starting with 'device_' and strip the prefix
        const devices = collections
            .filter(c => c.name.startsWith('device_'))
            .map(c => {
                const id = c.name.replace('device_', '');
                const config = iotConfig.devices?.[id];
                return { id, name: config?.meta?.name || id };
            });
        
        res.json(devices);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getDeviceActions = async (req, res) => {
    try {
        const { deviceId } = req.params;
        const actions = (iotConfig.actions || []).filter(a => 
            (a.options && a.options.sourceDevice === deviceId) || 
            (a.options && a.options.targetDevice === deviceId) ||
            (a.options && a.options.tankDevice === deviceId)
        );
        res.json(actions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const updateAction = async (req, res) => {
    try {
        const { name } = req.params;
        const updates = req.body;
        
        const action = (iotConfig.actions || []).find(a => a.name === name);
        if (!action) {
            return res.status(404).json({ error: 'Action not found' });
        }

        if (updates.enabled !== undefined) action.enabled = updates.enabled;
        if (updates.interval !== undefined) action.interval = updates.interval;
        if (updates.options) {
            action.options = { ...action.options, ...updates.options };
        }

        await saveConfig();
        reloadActions();
        
        res.json(action);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Save the configuration but ignore any keys that start with an underscore (plugins may add those for internal caching)
const saveConfig = async () => {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const configPath = path.join(__dirname, '../config/iotConfig.json');        
        const replacer = (key, value) => key.startsWith('_') ? undefined : value;
        await fs.writeFile(configPath, JSON.stringify(iotConfig, replacer, 4));
    } catch (error) {
        log.error('Failed to save config:', error);
    }
    log.info('Saved the configuration.');
};

export const getDashboards = async (req, res) => {
    res.json(iotConfig.dashboards || []);
};

export const saveDashboard = async (req, res) => {
    try {
        const dashboard = req.body;
        if (!dashboard.id) {
            dashboard.id = 'dash_' + Date.now();
        }
        
        if (!iotConfig.dashboards) iotConfig.dashboards = [];
        
        const idx = iotConfig.dashboards.findIndex(d => d.id === dashboard.id);
        if (idx >= 0) {
            iotConfig.dashboards[idx] = dashboard;
        } else {
            iotConfig.dashboards.push(dashboard);
        }
        
        await saveConfig();
        res.json(dashboard);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const deleteDashboard = async (req, res) => {
    try {
        const { id } = req.params;
        if (iotConfig.dashboards) {
            iotConfig.dashboards = iotConfig.dashboards.filter(d => d.id !== id);
            await saveConfig();
        }
        res.json({ status: 'deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getDashboardValues = async (req, res) => {
    try {
        const { id } = req.params;
        const dashboard = (iotConfig.dashboards || []).find(d => d.id === id);
        if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });

        const results = {};
        // Group metrics by device to minimize DB calls
        const deviceMetrics = {};
        dashboard.metrics.forEach(metric => {
            const parts = metric.split('.');
            const deviceId = parts[0];
            const key = parts.slice(1).join('.');
            if (!deviceMetrics[deviceId]) deviceMetrics[deviceId] = [];
            deviceMetrics[deviceId].push({ fullMetric: metric, key });
        });

        for (const deviceId in deviceMetrics) {
            const latest = await fetchLatestData(deviceId);
            if (latest) {
                deviceMetrics[deviceId].forEach(m => {
                    const val = getValue(latest, 'data.' + m.key);
                    results[m.fullMetric] = { value: val, timestamp: latest.receivedAt };
                });
            }
        }
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const fetchDeviceStats = async (deviceId) => {
    try {
        const db = getDb();
        const collection = db.collection(`device_${deviceId}`);

        const totalRecords = await collection.countDocuments();
        
        if (totalRecords === 0) {
            return {
                lastSeen: null,
                totalRecords: 0,
                recordsToday: 0,
                dailyAvg: 0
            };
        }

        const lastDoc = await collection.findOne({}, { sort: { receivedAt: -1 }, projection: { receivedAt: 1, protocol: 1 } });
        const firstDoc = await collection.findOne({}, { sort: { receivedAt: 1 }, projection: { receivedAt: 1 } });

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        const recordsToday = await collection.countDocuments({ 
            receivedAt: { $gte: startOfToday } 
        });

        let dailyAvg = 0;
        if (firstDoc && lastDoc) {
            const firstDate = new Date(firstDoc.receivedAt);
            const lastDate = new Date(lastDoc.receivedAt);
            const timeDiff = Math.abs(lastDate - firstDate);
            const daysDiff = timeDiff / (1000 * 3600 * 24);
            dailyAvg = Math.round(totalRecords / Math.max(1, daysDiff));
        }

        return {
            lastSeen: lastDoc ? lastDoc.receivedAt : null,
            lastProtocol: lastDoc ? lastDoc.protocol : null,
            totalRecords,
            recordsToday,
            dailyAvg
        };
    } catch (error) {
        throw error;
    }
};

export const getDeviceStats = async (req, res) => {
    try {
        const stats = await fetchDeviceStats(req.params.deviceId);
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getCommandDefinitions = async (req, res) => {
    res.json(iotConfig.deviceTypes || {});
};

export const queueCommand = async (req, res) => {
    try {
        const { deviceId, subDevice, command, argument } = req.body;

        if (!deviceId || !subDevice || !command) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const db = getDb();
        
        let commandObj = {
            [subDevice]: {}
        };

        if (typeof command === 'object') {
            // Entire commmand object (may contain multiple commands)
            commandObj[subDevice] = { ...command };
        } else {
            // Single command and argument
            commandObj[subDevice][command] = argument;
        }

        const insertedId = await addCommand(deviceId, commandObj);

        // Check if we should send immediately via MQTT
        const deviceCollection = db.collection(`device_${deviceId}`);
        const lastDoc = await deviceCollection.findOne({}, { sort: { receivedAt: -1 }, projection: { protocol: 1 } });

        if (lastDoc && lastDoc.protocol === 'mqtt') {
            if (sendMqttCommand(deviceId, commandObj, insertedId)) {
                await markCommandAsSent(insertedId);
            }
        }

        res.json({ status: "Queued" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getDeviceKeys = async (req, res) => {
    try {
        const { deviceId } = req.params;
        const db = getDb();
        const collection = db.collection(`device_${deviceId}`);
        
        // Get the most recent document to determine schema
        const doc = await collection.findOne({}, { sort: { receivedAt: -1 } });
        
        if (!doc || !doc.data) {
            return res.json([]);
        }

        // Recursive function to find all keys in the data object
        const findKeys = (obj, prefix = '') => {
            let keys = [];
            for (const key in obj) {
                if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                    keys = keys.concat(findKeys(obj[key], prefix + key + '.'));
                } else {
                    keys.push(prefix + key);
                }
            }
            return keys;
        };

        const keys = findKeys(doc.data, 'data.');
        res.json(keys);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const fetchDeviceData = async (deviceId, { field, fields, timeframe, accuracy }) => {
    try {
        
        // Support 'fields' (comma separated) or 'field' (legacy/single)
        let fieldsToFetch = [];
        if (fields) {
            fieldsToFetch = fields.split(',');
        } else if (field) {
            fieldsToFetch = [field];
        } else {
            throw new Error('Fields parameter is required');
        }

        const db = getDb();
        const collection = db.collection(`device_${deviceId}`);

        let query = {};
        let startTime;
        let endTime = new Date();

        if (timeframe && timeframe !== 'all') {
            const now = new Date();
            startTime = new Date(now);
            
            switch (timeframe) {
                case "30m":
                    startTime.setMinutes(now.getMinutes() - 30);
                    break;
                case "1h":
                    startTime.setHours(now.getHours() - 1);
                    break;
                case "3h":
                    startTime.setHours(now.getHours() - 3);
                    break;
                case "6h":
                    startTime.setHours(now.getHours() - 6);
                    break;
                case "12h":
                    startTime.setHours(now.getHours() - 12);
                    break;
                case "24h":
                    startTime.setHours(now.getHours() - 24);
                    break;
                case "7d":
                    startTime.setDate(now.getDate() - 7);
                    break;
                case "30d":
                    startTime.setDate(now.getDate() - 30);
                    break;
                case "1y":
                    startTime.setFullYear(now.getFullYear() - 1);
                    break;
                case "5y":
                    startTime.setFullYear(now.getFullYear() - 5);
                    break;
            }
            query.receivedAt = { $gte: startTime };
        }

        // Projection to fetch only time and the specific field
        const projection = { receivedAt: 1 };
        fieldsToFetch.forEach(f => projection[f] = 1);

        const data = await collection.find(query, { projection })
            .sort({ receivedAt: -1 })
            .limit(500000) // Increased limit to allow for larger timeframes
            .toArray();

        if (startTime) {
            const duration = endTime.getTime() - startTime.getTime();
            const threshold = duration * 0.05;

            const hasStartData = data.length > 0 && (data[data.length - 1].receivedAt.getTime() - startTime.getTime()) <= threshold;

            if (!hasStartData) {
                const beforeDoc = await collection.findOne(
                    { receivedAt: { $lt: startTime } },
                    { sort: { receivedAt: -1 }, projection }
                );
                if (beforeDoc) {
                    beforeDoc.receivedAt = startTime;
                    data.push(beforeDoc);
                }
            }

            const hasEndData = data.length > 0 && (endTime.getTime() - data[0].receivedAt.getTime()) <= threshold;

            if (!hasEndData) {
                const afterDoc = await collection.findOne(
                    { receivedAt: { $gt: endTime } },
                    { sort: { receivedAt: 1 }, projection }
                );
                if (afterDoc) {
                    afterDoc.receivedAt = endTime;
                    data.unshift(afterDoc);
                } else if (data.length > 0) {
                    const lastKnownDoc = { ...data[0] };
                    lastKnownDoc.receivedAt = endTime;
                    data.unshift(lastKnownDoc);
                }
            }
        }

        // Downsample data if too large to prevent frontend performance issues
        let processedData = data;
        const targetPoints = 1000; // About the max display width of the graph in pixels.
        if (data.length > targetPoints) {
            processedData = [];
            const step = data.length / targetPoints;
            for (let i = 0; i < targetPoints; i++) {
                const index = Math.floor(i * step);
                if (index < data.length) {
                    processedData.push(data[index]);
                }
            }
        }

        const result = {};
        const mappings = {};
        const deviceConfig = iotConfig.devices?.[deviceId]?.data || {};

        fieldsToFetch.forEach(field => {
            // Extract raw values first to detect types
            const rawPoints = processedData.map(doc => {
                const value = field.split('.').reduce((obj, key) => (obj && obj[key] !== undefined) ? obj[key] : null, doc);
                return { doc, value };
            });

            // Resolve config for this field to check for valueMap
            let customMap = null;
            const fieldPath = field.startsWith('data.') ? field.substring(5) : field;
            const parts = fieldPath.split('.');
            
            if (parts.length >= 2) {
                const metric = parts.pop();
                const parentPath = parts.join('.');
                
                // Try exact match
                let groupConfig = deviceConfig[parentPath];
                
                // Try wildcard (assuming 3 levels: Type.Subtype.Name -> Type.Subtype.*)
                if (!groupConfig && parts.length >= 2) {
                     const wildcardPath = parts.slice(0, 2).join('.') + '.*';
                     groupConfig = deviceConfig[wildcardPath];
                }
                
                if (groupConfig && groupConfig[metric] && typeof groupConfig[metric] === 'object' && groupConfig[metric].valueMap) {
                    customMap = groupConfig[metric].valueMap;
                }
            }

            // Handle string values by mapping them to integers
            const stringValues = rawPoints.filter(p => typeof p.value === 'string').map(p => p.value);
            let stringMap = null;
            if (stringValues.length > 0) {
                if (customMap) {
                    stringMap = customMap;
                } else {
                    const unique = [...new Set(stringValues)].sort();
                    stringMap = {};
                    unique.forEach((val, idx) => { stringMap[val] = idx; });
                }
                mappings[field] = stringMap;
            }

            // Format for Chart.js (x: time, y: value)
            result[field] = rawPoints.map(p => {
                let value = p.value;
                
                if (stringMap && typeof value === 'string') {
                    value = stringMap[value] !== undefined ? stringMap[value] : null;
                }

                // Apply rounding if requested and value is a number
                if (accuracy && accuracy !== 'raw' && typeof value === 'number') {
                    const step = parseFloat(accuracy);
                    if (!isNaN(step) && step !== 0) {
                        value = Math.round(value / step) * step;
                    }
                }
                return { x: p.doc.receivedAt, y: value };
            }).filter(point => point.y !== null).reverse(); // Reverse to chronological order
        });

        return { data: result, mappings };
    } catch (error) {
        throw error;
    }
};

export const getDeviceData = async (req, res) => {
    try {
        const { data, mappings } = await fetchDeviceData(req.params.deviceId, req.query);
        res.json({ data, mappings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const _getAllDeviceStatusesData = async () => {
    try {
        const db = getDb();
        const collections = await db.listCollections().toArray();
        const deviceCollections = collections.filter(c => c.name.startsWith('device_'));

        const statusPromises = deviceCollections.map(async (c) => {
            const deviceId = c.name.replace('device_', '');
            const collection = db.collection(c.name);
            const lastDoc = await collection.findOne({}, { sort: { receivedAt: -1 }, projection: { receivedAt: 1, 'data.System.DataExchanger': 1 } });
            
            const config = iotConfig.devices?.[deviceId];
            const name = config?.meta?.name || deviceId;

            let interval = null;
            if (lastDoc?.data?.System?.DataExchanger) {
                const exchangers = lastDoc.data.System.DataExchanger;
                const keys = Object.keys(exchangers);
                if (keys.length > 0 && exchangers[keys[0]].interval) {
                    interval = exchangers[keys[0]].interval;
                }
            }

            return {
                deviceId,
                name,
                lastSeen: lastDoc ? lastDoc.receivedAt : null,
                interval
            };
        });

        const statuses = await Promise.all(statusPromises);
        return statuses.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    } catch (error) {
        log.error("Error fetching all device statuses data:", error);
        throw error;
    }
};

export const getDeviceStatus = async (req, res) => {
    try {
        const statuses = await _getAllDeviceStatusesData();
        res.json(statuses);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getAllDeviceStatusesData = async () => {
    return _getAllDeviceStatusesData();
};

export const getSingleDeviceStatusData = async (deviceId) => {
    const allStatuses = await _getAllDeviceStatusesData();
    return allStatuses.find(s => s.deviceId === deviceId);
};

export const fetchLatestData = async (deviceId) => {
    try {
        const db = getDb();
        const collection = db.collection(`device_${deviceId}`);

        const latestDoc = await collection.findOne({}, { sort: { receivedAt: -1 } });
        return latestDoc;
    } catch (error) {
        throw error;
    }
};

export const getLatestData = async (req, res) => {
    try {
        const latestDoc = await fetchLatestData(req.params.deviceId);
        res.json(latestDoc);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const fetchLatestRawData = async (deviceId) => {
    return getRawData(deviceId);
};

export const fetchDeviceConfig = async (deviceId) => {
    const deviceSettings = iotConfig.devices?.[deviceId];
    return deviceSettings?.data || {};
};

export const getDeviceConfig = async (req, res) => {
    try {
        const { deviceId } = req.params;
        const deviceSettings = iotConfig.devices?.[deviceId];
        res.json(deviceSettings?.data || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getSchedules = async (req, res) => {
    try {
        const { deviceId } = req.query;
        let schedules = iotConfig.schedules || [];
        
        if (deviceId) {
            schedules = schedules.filter(s => 
                s.targets && s.targets.some(t => t.deviceId === deviceId)
            );
        }
        
        res.json(schedules);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};