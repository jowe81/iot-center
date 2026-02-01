const express = require('express');
const router = express.Router();
const frontendController = require('../controllers/frontendController');

router.get('/devices', frontendController.getDevices);
router.get('/device/:deviceId/keys', frontendController.getDeviceKeys);
router.get('/device/:deviceId/data', frontendController.getDeviceData);

module.exports = router;