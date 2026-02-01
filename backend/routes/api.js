import express from 'express';
import * as iotController from '../controllers/iotController.js';

const router = express.Router();
router.post('/', iotController.processData);

export default router;