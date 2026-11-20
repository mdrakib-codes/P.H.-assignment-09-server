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

export const paidPaymentStatusSchema = z.literal('paid');
export const stripeSessionIdSchema = requiredString('Stripe session ID');
export const transactionIdSchema = requiredString('Transaction ID');

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
