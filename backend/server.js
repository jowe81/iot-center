import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { connectDB } from './config/db.js';
import apiRoutes from './routes/api.js';
import frontendRoutes from './routes/frontend.js';
import log from './utils/logger.js';
import { initMqttService } from './controllers/mqttService.js';
import { initWebSocket } from './controllers/websocketService.js';
import { initSchedulerService } from './controllers/schedulerService.js';
import { initActionService } from './controllers/actionService.js';
import { initKasaService } from './controllers/kasaService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const iotConfig = require('./config/iotConfig.json');

const app = express();

log.info(`-------------------------------`);
log.info(`[System] Backend starting up...`);

// Connect to Database
connectDB().then(() => {
  initMqttService();
  initSchedulerService();
  initActionService();
  initKasaService();
});

app.use(express.json());

// Serve dashboards.html as home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboards.html'));
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Request Logger Middleware
app.use((req, res, next) => {
  log.info(`[HTTP] Incoming request: ${req.method} ${req.url}`);
  next();
});

// Use Routes
app.use('/automation_api', apiRoutes);
app.use('/api', frontendRoutes);

const server = http.createServer(app);
initWebSocket(server);

const port = iotConfig.system.http?.port || 8101;
server.listen(port, () => log.info(`[System] IoT Service running on port ${port}`));
