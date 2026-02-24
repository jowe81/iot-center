import express from 'express';
import * as frontendController from '../controllers/frontendController.js';

const router = express.Router();
router.get('/devices', frontendController.getDevices);
router.get('/device/:deviceId/keys', frontendController.getDeviceKeys);
router.get('/device/:deviceId/data', frontendController.getDeviceData);
router.get('/status', frontendController.getDeviceStatus);
router.get('/device/:deviceId/stats', frontendController.getDeviceStats);
router.get('/device/:deviceId/latest', frontendController.getLatestData);
router.get('/commands/definitions', frontendController.getCommandDefinitions);
router.post('/commands/queue', frontendController.queueCommand);
router.get('/device/:deviceId/config', frontendController.getDeviceConfig);
router.get('/schedules', frontendController.getSchedules);
router.get('/dashboards', frontendController.getDashboards);
router.post('/dashboards', frontendController.saveDashboard);
router.delete('/dashboards/:id', frontendController.deleteDashboard);
router.get('/dashboards/:id/values', frontendController.getDashboardValues);

export default router;