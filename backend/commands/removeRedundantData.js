import { createRequire } from 'module';
import { connectDB, getDb } from '../config/db.js';
import log from '../utils/logger.js';
import { findDataKeys, getValue, isRedundant } from '../utils/dataUtils.js';

const require = createRequire(import.meta.url);
const iotConfig = require('../config/iotConfig.json');

const BATCH_SIZE = 1000;

async function run() {
    const deviceId = process.argv[2];

    if (!deviceId) {
        console.error("Please provide a deviceId as an argument.");
        process.exit(1);
    }

    await connectDB();
    const db = getDb();
    const collection = db.collection(`device_${deviceId}`);

    log.info(`Starting redundancy cleanup for device: ${deviceId}`);

    // 1. Identify all unique data keys
    // We scan the latest 100 records to guess keys, or use the config. 
    // For robustness, let's use the config + a quick scan.
    const keys = new Set();
    
    // Add keys from config
    const deviceConfig = iotConfig.devices[deviceId]?.data || {};
    const findKeys = (obj, prefix = '') => {
        for (const key in obj) {
            if (typeof obj[key] === 'object' && obj[key] !== null && !obj[key].save) {
                findKeys(obj[key], prefix + key + '.');
            } else {
                keys.add('data.' + prefix + key);
            }
        }
    };
    findKeys(deviceConfig);

    // Also scan recent documents to find keys not in config
    const recentDocs = await collection.find().sort({ receivedAt: -1 }).limit(50).toArray();
    recentDocs.forEach(doc => {
        findDataKeys(doc).forEach(k => keys.add(k));
    });

    const allKeys = Array.from(keys);
    log.info(`Processing keys: ${allKeys.join(', ')}`);

    // 2. Iterate and Compress
    const cursor = collection.find().sort({ receivedAt: 1 });
    
    // State tracking per key: { key: [ {id, val}, {id, val} ] }
    // We need 2 previous points to compare with current (3rd point)
    const history = {}; 
    allKeys.forEach(k => history[k] = []);

    let bulkOps = [];
    let processedCount = 0;
    let removedCount = 0;

    while (await cursor.hasNext()) {
        const doc = await cursor.next();
        processedCount++;

        for (const key of allKeys) {
            // Resolve value from dot notation
            const val = getValue(doc, key);

            if (val === undefined) continue;

            const track = history[key];

            if (track.length < 2) {
                track.push({ id: doc._id, val });
                continue;
            }

            const a = track[0]; // 2nd most recent
            const b = track[1]; // most recent
            const ref = { id: doc._id, val }; // current

            // Check for redundancy: a == b == ref
            if (isRedundant(a.val, b.val, ref.val)) {
                // 'b' is redundant. 
                // We queue an unset for 'b'.
                bulkOps.push({
                    updateOne: {
                        filter: { _id: b.id },
                        update: { $unset: { [key]: "" } }
                    }
                });
                removedCount++;

                // Update history: 
                // We keep 'a' (start of sequence)
                // We replace 'b' with 'ref' (current end of sequence)
                // Effectively, 'b' is removed from our "significant points" list
                track[1] = ref;
            } else {
                // Not redundant (value changed or sequence broken).
                // Shift window: a becomes b, b becomes ref
                track.shift();
                track.push(ref);
            }
        }

        if (bulkOps.length >= BATCH_SIZE) {
            await collection.bulkWrite(bulkOps);
            bulkOps = [];
            log.info(`Processed ${processedCount} records, queued ${removedCount} field removals...`);
        }
    }

    if (bulkOps.length > 0) {
        await collection.bulkWrite(bulkOps);
    }

    log.info(`Finished. Total records: ${processedCount}. Total fields removed: ${removedCount}.`);
    process.exit(0);
}

run().catch(err => {
    log.error(err);
    process.exit(1);
});