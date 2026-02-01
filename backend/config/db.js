import { MongoClient } from 'mongodb';
import log from '../utils/logger.js';

const url = 'mongodb://localhost:27017';
const dbName = 'iot_platform';

let _db;

const connectDB = async () => {
  try {
    const client = await MongoClient.connect(url);
    _db = client.db(dbName);
    log.info("Connected to MongoDB Native Driver");
  } catch (err) {
    log.error("Failed to connect to MongoDB", err);
    process.exit(1);
  }
};

const getDb = () => {
  if (!_db) throw new Error("Database not initialized");
  return _db;
};

export { connectDB, getDb };