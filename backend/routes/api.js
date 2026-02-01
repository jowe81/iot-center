const express = require('express');
const router = express.Router();
const iotController = require('../controllers/iotController');

router.post('/', iotController.processData);

module.exports = router;