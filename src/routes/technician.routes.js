import { Router } from 'express';

export const createTechnicianServiceRoutes = ({ controller, requireActor }) => {
  if (typeof requireActor !== 'function') {
    throw new TypeError(
      'createTechnicianServiceRoutes requires a requireActor middleware.'
    );
  }

  const router = Router();

  router.post('/', requireActor, controller.createService);
  router.get('/technician', requireActor, controller.listMyServices);
  router.patch('/:id/availability', requireActor, controller.updateAvailability);
  router.patch('/:id', requireActor, controller.updateService);
  router.delete('/:id', requireActor, controller.deleteService);

  return router;
};

export const createTechnicianBookingRoutes = ({ controller, requireActor }) => {
  if (typeof requireActor !== 'function') {
    throw new TypeError(
      'createTechnicianBookingRoutes requires a requireActor middleware.'
    );
  }

  const router = Router();

  router.get('/technician', requireActor, controller.listAssignedBookings);
  router.patch('/:id/status', requireActor, controller.updateBookingStatus);

  return router;
};
