import { z } from 'zod';
import { SERVICE_CATEGORIES } from './service.validator.js';
import {
  dateOnlySchema,
  emailSchema,
  objectIdSchema,
  positiveMoneySchema,
  requiredString,
  timestampSchema,
  urlSchema
} from './shared.js';

export const BOOKING_STATUSES = Object.freeze([
  'requested',
  'accepted',
  'rejected',
  'in-progress',
  'completed',
  'cancelled'
]);

export const BOOKING_PAYMENT_STATUSES = Object.freeze(['unpaid', 'paid']);
export const ACTIVE_BOOKING_STATUSES = Object.freeze([
  'requested',
  'accepted',
  'in-progress'
]);

export const ALLOWED_BOOKING_STATUS_TRANSITIONS = Object.freeze({
  requested: Object.freeze(['accepted', 'rejected', 'cancelled']),
  accepted: Object.freeze(['in-progress']),
  'in-progress': Object.freeze(['completed']),
  completed: Object.freeze([]),
  rejected: Object.freeze([]),
  cancelled: Object.freeze([])
});

export const TECHNICIAN_ALLOWED_BOOKING_STATUS_TRANSITIONS = Object.freeze({
  requested: Object.freeze(['accepted', 'rejected']),
  accepted: Object.freeze(['in-progress']),
  'in-progress': Object.freeze(['completed']),
  completed: Object.freeze([]),
  rejected: Object.freeze([]),
  cancelled: Object.freeze([])
});

const isTodayOrFuture = (value) => {
  const selected = new Date(`${value}T00:00:00.000Z`);
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  return selected >= today;
};

export const bookingCreateInputSchema = z
  .object({
    serviceId: objectIdSchema,
    customerPhone: requiredString('Customer phone'),
    address: requiredString('Address'),
    preferredDate: dateOnlySchema.refine(
      isTodayOrFuture,
      'Preferred date cannot be in the past.'
    ),
    problemDescription: z
      .string()
      .trim()
      .min(20, 'Problem description must be at least 20 characters.')
  })
  .strict();

export const bookingSchema = z
  .object({
    _id: objectIdSchema.optional(),
    serviceId: objectIdSchema,
    serviceTitle: requiredString('Service title'),
    serviceImage: urlSchema,
    category: z.enum(SERVICE_CATEGORIES),
    basePrice: positiveMoneySchema,
    technicianName: requiredString('Technician name'),
    technicianEmail: emailSchema,
    customerName: requiredString('Customer name'),
    customerEmail: emailSchema,
    customerPhone: requiredString('Customer phone'),
    address: requiredString('Address'),
    preferredDate: dateOnlySchema.refine(isTodayOrFuture, 'Preferred date cannot be in the past.'),
    problemDescription: z
      .string()
      .trim()
      .min(20, 'Problem description must be at least 20 characters.'),
    status: z.enum(BOOKING_STATUSES).default('requested'),
    finalAmount: positiveMoneySchema.optional(),
    paymentStatus: z.enum(BOOKING_PAYMENT_STATUSES).default('unpaid'),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .transform((booking) => ({
    ...booking,
    finalAmount: booking.finalAmount ?? booking.basePrice
  }));

export const bookingStatusUpdateSchema = z
  .object({
    status: z.enum(BOOKING_STATUSES),
    finalAmount: positiveMoneySchema.optional()
  })
  .strict();
