import { Router } from 'express';
import { getLiveness, getReadiness } from '../controllers/health.controller.js';

const router = Router();

router.get('/health', getReadiness);
router.get('/health/live', getLiveness);

export default router;
