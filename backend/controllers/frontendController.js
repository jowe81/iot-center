const { getDb } = require('../config/db');

exports.getDevices = async (req, res) => {
    try {
        const db = getDb();
        // List all collections
        const collections = await db.listCollections().toArray();
        // Filter for those starting with 'device_' and strip the prefix
        const devices = collections
            .filter(c => c.name.startsWith('device_'))
            .map(c => c.name.replace('device_', ''));
        
        res.json(devices);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getDeviceKeys = async (req, res) => {
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

exports.getDeviceData = async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { field, fields, timeframe, accuracy } = req.query;
        
        // Support 'fields' (comma separated) or 'field' (legacy/single)
        let fieldsToFetch = [];
        if (fields) {
            fieldsToFetch = fields.split(',');
        } else if (field) {
            fieldsToFetch = [field];
        } else {
            return res.status(400).json({ error: 'Fields parameter is required' });
        }

        const db = getDb();
        const collection = db.collection(`device_${deviceId}`);

        let query = {};

        if (timeframe && timeframe !== 'all') {
            const now = new Date();
            let startTime = new Date(now);
            
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
            .limit(10000) // Increased limit to allow for larger timeframes
            .toArray();

        const result = {};

        fieldsToFetch.forEach(field => {
            // Format for Chart.js (x: time, y: value)
            result[field] = data.map(doc => {
                // Resolve nested property
                let value = field.split('.').reduce((obj, key) => (obj && obj[key] !== undefined) ? obj[key] : null, doc);
                
                // Apply rounding if requested and value is a number
                if (accuracy && accuracy !== 'raw' && typeof value === 'number') {
                    const step = parseFloat(accuracy);
                    if (!isNaN(step) && step !== 0) {
                        value = Math.round(value / step) * step;
                    }
                }
                return { x: doc.receivedAt, y: value };
            }).filter(point => point.y !== null).reverse(); // Reverse to chronological order
        });

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};