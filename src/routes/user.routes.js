import { Router } from 'express';

export const createUserRoutes = ({ controller, requireActor }) => {
  if (typeof requireActor !== 'function') {
    throw new TypeError('createUserRoutes requires a requireActor middleware.');
  }

  const router = Router();

  router.patch('/profile', requireActor, controller.updateProfile);

  return router;
};
