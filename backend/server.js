import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from './config/db.js';
import apiRoutes from './routes/api.js';
import frontendRoutes from './routes/frontend.js';
import log from './utils/logger.js';
import { initMqttService } from './controllers/mqttService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Connect to Database
connectDB().then(() => {
  initMqttService();
});

app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Request Logger Middleware
app.use((req, res, next) => {
  log.info(`Incoming request: ${req.method} ${req.url}`);
  next();
});

// Use Routes
app.use('/automation_api', apiRoutes);
app.use('/api', frontendRoutes);

app.listen(8101, () => log.info('IoT Service running on port 8101'));
