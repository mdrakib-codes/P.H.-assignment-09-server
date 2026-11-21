import { z } from 'zod';
import {
  APPROVAL_STATUSES,
  SERVICE_CATEGORIES,
  SERVICE_MODES
} from './service.validator.js';
import {
  BOOKING_PAYMENT_STATUSES,
  BOOKING_STATUSES
} from './booking.validator.js';
import {
  PAYMENT_CURRENCIES,
  PAYMENT_STATUSES
} from './payment.validator.js';
import { USER_ROLES } from './user.validator.js';

export const paginationSchema = z
  .object({
    page: z.coerce.number().int().positive().max(1000).default(1),
    limit: z.coerce.number().int().positive().max(100).default(20)
  })
  .strict();

export const userQuerySchema = paginationSchema
  .extend({
    role: z.enum(USER_ROLES).optional(),
    search: z.string().trim().max(100).optional()
  })
  .strict();

export const serviceQuerySchema = paginationSchema
  .extend({
    search: z.string().trim().max(100).optional(),
    category: z.enum(SERVICE_CATEGORIES).optional(),
    serviceMode: z.enum(SERVICE_MODES).optional(),
    sort: z.enum(['newest', 'price-asc', 'price-desc']).default('newest')
  })
  .strict();

export const technicianServiceQuerySchema = paginationSchema
  .extend({
    approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
    technicianEmail: z.unknown().optional()
  })
  .strict()
  .transform(({ technicianEmail, ...query }) => query);

export const bookingQuerySchema = paginationSchema
  .extend({
    status: z.enum(BOOKING_STATUSES).optional(),
    paymentStatus: z.enum(BOOKING_PAYMENT_STATUSES).optional(),
    customerEmail: z.unknown().optional(),
    technicianEmail: z.unknown().optional()
  })
  .strict()
  .transform(({ customerEmail, technicianEmail, ...query }) => query);

export const adminServiceQuerySchema = paginationSchema
  .extend({
    approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
    search: z.string().trim().max(100).optional(),
    category: z.enum(SERVICE_CATEGORIES).optional(),
    serviceMode: z.enum(SERVICE_MODES).optional(),
    sort: z
      .enum(['pending-first', 'newest', 'price-asc', 'price-desc'])
      .default('pending-first')
  })
  .strict();

export const adminPaymentQuerySchema = paginationSchema
  .extend({
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    currency: z.enum(PAYMENT_CURRENCIES).optional(),
    amount: z.unknown().optional(),
    revenue: z.unknown().optional()
  })
  .strict()
  .transform(({ amount, revenue, ...query }) => query);
