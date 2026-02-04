import express from 'express';
import * as frontendController from '../controllers/frontendController.js';

const router = express.Router();
router.get('/devices', frontendController.getDevices);
router.get('/device/:deviceId/keys', frontendController.getDeviceKeys);
router.get('/device/:deviceId/data', frontendController.getDeviceData);
router.get('/status', frontendController.getDeviceStatus);
router.get('/device/:deviceId/stats', frontendController.getDeviceStats);
router.get('/device/:deviceId/controls', frontendController.getControllableDevices);
router.get('/device/:deviceId/latest', frontendController.getLatestData);
router.get('/commands/definitions', frontendController.getCommandDefinitions);
router.post('/commands/queue', frontendController.queueCommand);

export default router;