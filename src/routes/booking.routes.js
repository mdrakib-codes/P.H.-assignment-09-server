import { Router } from 'express';

export const createBookingRoutes = ({ controller, requireActor }) => {
  if (typeof requireActor !== 'function') {
    throw new TypeError('createBookingRoutes requires a requireActor middleware.');
  }

  const router = Router();

  router.post('/', requireActor, controller.create);
  router.get('/my', requireActor, controller.listMine);
  router.patch('/:id/cancel', requireActor, controller.cancel);

  return router;
};

export default createBookingRoutes;
