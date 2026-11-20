import { Router } from 'express';
import { serviceController } from '../controllers/service.controller.js';

export const createServiceRoutes = (controller = serviceController) => {
  const router = Router();

  router.get('/', controller.list);
  router.get('/:id', controller.getById);

  return router;
};

export default createServiceRoutes();
