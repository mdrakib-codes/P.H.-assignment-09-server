import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { env } from './config/env.js';
import { corsOptions } from './config/cors.js';
import { createPaymentController } from './controllers/payment.controller.js';
import {
  bookingRepository,
  paymentRepository,
  userRepository
} from './repositories/index.js';
import { createPaymentWebhookRoutes } from './routes/payment-webhook.routes.js';
import routes from './routes/index.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { createSecurityHeaders } from './middleware/securityHeaders.js';

const app = express();
const stripeClient = env.stripeSecretKey ? new Stripe(env.stripeSecretKey) : null;
const paymentController = createPaymentController({
  stripeClient,
  payments: paymentRepository,
  bookings: bookingRepository,
  users: userRepository,
  clientOrigin: env.allowedOrigins[0]
});
const sharedRateLimitOptions = {
  windowMs: env.rateLimitWindowMs,
  maxEntries: env.rateLimitMaxEntries
};

app.disable('x-powered-by');
app.set('trust proxy', env.trustProxy ? 1 : false);
app.use(
  createSecurityHeaders({
    isProduction: env.isProduction,
    trustProxy: env.trustProxy
  })
);

if (env.rateLimitEnabled) {
  app.use(
    '/api/payments/webhook',
    createRateLimiter({
      ...sharedRateLimitOptions,
      max: env.webhookRateLimitMax
    })
  );
}
app.use(
  '/api/payments/webhook',
  createPaymentWebhookRoutes({
    controller: paymentController,
    stripeClient,
    webhookSecret: env.stripeWebhookSecret
  })
);
app.use(cors(corsOptions));
if (env.rateLimitEnabled) {
  app.use(
    '/api/health',
    createRateLimiter({
      ...sharedRateLimitOptions,
      max: env.healthRateLimitMax
    })
  );
  app.use(
    '/api/services',
    createRateLimiter({
      ...sharedRateLimitOptions,
      max: env.serviceRateLimitMax
    })
  );
  app.use(
    '/api',
    createRateLimiter({
      ...sharedRateLimitOptions,
      max: env.rateLimitMax
    })
  );
}
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

export default app;
