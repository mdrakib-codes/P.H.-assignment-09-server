import { Router, raw } from 'express';
import { AppError } from '../utils/AppError.js';
import { sendSuccess } from '../utils/apiResponse.js';

export const createPaymentWebhookRoutes = ({ controller, stripeClient, webhookSecret }) => {
  if (typeof controller?.handleWebhookEvent !== 'function') {
    throw new TypeError('createPaymentWebhookRoutes requires a webhook controller.');
  }

  const canVerify = typeof stripeClient?.webhooks?.constructEvent === 'function';
  const secret = typeof webhookSecret === 'string' ? webhookSecret.trim() : '';
  const router = Router();

  router.post('/', raw({ type: 'application/json' }), async (req, res, next) => {
    try {
      if (!canVerify || !secret) {
        throw new AppError(
          503,
          'WEBHOOK_NOT_CONFIGURED',
          'Webhook verification is not configured.'
        );
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new AppError(400, 'INVALID_WEBHOOK_BODY', 'Invalid webhook body.');
      }

      const signature = req.headers['stripe-signature'];

      if (typeof signature !== 'string' || signature.trim().length === 0) {
        throw new AppError(
          400,
          'MISSING_STRIPE_SIGNATURE',
          'Missing Stripe signature.'
        );
      }

      let event;

      try {
        event = stripeClient.webhooks.constructEvent(req.body, signature, secret);
      } catch {
        throw new AppError(
          400,
          'INVALID_STRIPE_SIGNATURE',
          'Invalid Stripe signature.'
        );
      }

      const result = await controller.handleWebhookEvent(event);

      return sendSuccess(res, {
        message: 'Webhook processed successfully.',
        received: result.received,
        ignored: result.ignored
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
};
