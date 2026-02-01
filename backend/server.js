const express = require('express');
const { connectDB } = require('./config/db');
const apiRoutes = require('./routes/api');
const log = require('./utils/logger');

const app = express();

// Connect to Database
connectDB();

app.use(express.json());

// Request Logger Middleware
app.use((req, res, next) => {
  log.info(`Incoming request: ${req.method} ${req.url}`);
  next();
});

// Use Routes
app.use('/automation_api', apiRoutes);

app.listen(8101, () => log.info('IoT Service running on port 8101'));
