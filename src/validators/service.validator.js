import { z } from 'zod';
import {
  emailSchema,
  objectIdSchema,
  positiveMoneySchema,
  requiredString,
  timestampSchema,
  urlSchema
} from './shared.js';

export const SERVICE_CATEGORIES = Object.freeze([
  'Smartphone',
  'Laptop & PC',
  'AC',
  'Refrigerator',
  'TV',
  'Washing Machine',
  'Electrical'
]);

export const SERVICE_MODES = Object.freeze(['Home Visit', 'Shop Drop-off']);
export const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
export const APPROVAL_DECISIONS = Object.freeze(['approved', 'rejected']);

export const serviceCategorySchema = z.enum(SERVICE_CATEGORIES);
export const serviceModeSchema = z.enum(SERVICE_MODES);
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export const availabilitySchema = z.boolean();

export const serviceSchema = z.object({
  _id: objectIdSchema.optional(),
  title: requiredString('Title'),
  category: serviceCategorySchema,
  description: requiredString('Description'),
  image: urlSchema,
  basePrice: positiveMoneySchema,
  estimatedDuration: requiredString('Estimated duration'),
  serviceMode: serviceModeSchema,
  serviceArea: requiredString('Service area'),
  technicianName: requiredString('Technician name'),
  technicianEmail: emailSchema,
  approvalStatus: approvalStatusSchema.default('pending'),
  isAvailable: availabilitySchema.default(true),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const serviceUpdateSchema = z
  .object({
    title: requiredString('Title').optional(),
    category: serviceCategorySchema.optional(),
    description: requiredString('Description').optional(),
    image: urlSchema.optional(),
    basePrice: positiveMoneySchema.optional(),
    estimatedDuration: requiredString('Estimated duration').optional(),
    serviceMode: serviceModeSchema.optional(),
    serviceArea: requiredString('Service area').optional()
  })
  .strict();

export const serviceCreateInputSchema = z
  .object({
    title: requiredString('Title'),
    category: serviceCategorySchema,
    description: requiredString('Description'),
    image: urlSchema,
    basePrice: positiveMoneySchema,
    estimatedDuration: requiredString('Estimated duration'),
    serviceMode: serviceModeSchema,
    serviceArea: requiredString('Service area')
  })
  .strict();

export const serviceAvailabilityUpdateSchema = z
  .object({
    isAvailable: availabilitySchema
  })
  .strict();

export const serviceApprovalUpdateSchema = z
  .object({
    approvalStatus: approvalDecisionSchema
  })
  .strict();
