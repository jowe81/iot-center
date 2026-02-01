const express = require('express');
const router = express.Router();
const frontendController = require('../controllers/frontendController');

router.get('/devices', frontendController.getDevices);
router.get('/device/:deviceId/keys', frontendController.getDeviceKeys);
router.get('/device/:deviceId/data', frontendController.getDeviceData);
router.get('/status', frontendController.getDeviceStatus);
router.get('/device/:deviceId/controls', frontendController.getControllableDevices);
router.get('/commands/definitions', frontendController.getCommandDefinitions);
router.post('/commands/queue', frontendController.queueCommand);

module.exports = router;