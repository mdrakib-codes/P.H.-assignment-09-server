import { Router } from 'express';

export const createAdminRoutes = ({ controller, requireActor }) => {
  if (typeof requireActor !== 'function') {
    throw new TypeError('createAdminRoutes requires a requireActor middleware.');
  }

  const router = Router();
  const admin = [requireActor, controller.requireAdmin];

  router.get('/users', ...admin, controller.listUsers);
  router.patch('/users/:id/role', ...admin, controller.updateUserRole);
  router.get('/services', ...admin, controller.listServices);
  router.patch('/services/:id/approval', ...admin, controller.updateServiceApproval);
  router.get('/bookings', ...admin, controller.listBookings);
  router.get('/payments', ...admin, controller.listPayments);

  return router;
};
