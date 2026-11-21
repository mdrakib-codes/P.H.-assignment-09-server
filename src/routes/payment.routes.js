import { Router } from 'express';

export const createPaymentRoutes = ({ controller, requireActor }) => {
  if (typeof requireActor !== 'function') {
    throw new TypeError('createPaymentRoutes requires a requireActor middleware.');
  }

  const router = Router();

  router.post('/create-checkout-session', requireActor, controller.createCheckoutSession);
  router.get('/verify', requireActor, controller.verifyPayment);

  return router;
};
