import { z } from 'zod';
import {
  emailSchema,
  objectIdSchema,
  positiveMoneySchema,
  requiredString,
  timestampSchema
} from './shared.js';

export const PAYMENT_CURRENCIES = Object.freeze(['usd']);
export const PAYMENT_STATUSES = Object.freeze(['paid']);
const STRIPE_SESSION_ID_PATTERN = /^cs_(?:test|live)_[A-Za-z0-9_]+$/;

export const paidPaymentStatusSchema = z.literal('paid');
export const stripeSessionIdSchema = z
  .string()
  .max(255, 'Stripe session ID is too long.')
  .regex(STRIPE_SESSION_ID_PATTERN, 'Invalid Stripe session ID.');
export const transactionIdSchema = requiredString('Transaction ID');
export const checkoutSessionInputSchema = z
  .object({
    bookingId: objectIdSchema
  })
  .strict();
export const paymentVerificationQuerySchema = z
  .object({
    session_id: stripeSessionIdSchema
  })
  .strict();

export const paymentSchema = z.object({
  _id: objectIdSchema.optional(),
  bookingId: objectIdSchema,
  serviceTitle: requiredString('Service title'),
  customerName: requiredString('Customer name'),
  customerEmail: emailSchema,
  technicianName: requiredString('Technician name'),
  technicianEmail: emailSchema,
  amount: positiveMoneySchema,
  currency: z.enum(PAYMENT_CURRENCIES).default('usd'),
  transactionId: requiredString('Transaction ID'),
  stripeSessionId: z.string().trim().min(1).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).default('paid'),
  paidAt: z.date().default(() => new Date()),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});
