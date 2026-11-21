import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  emailSchema,
  objectIdSchema,
  optionalTextSchema,
  requiredString,
  timestampSchema,
  urlSchema
} from './shared.js';

export const USER_ROLES = Object.freeze(['customer', 'technician', 'admin']);
export const PUBLIC_ROLES = Object.freeze(['customer', 'technician']);

export const publicRoleSchema = z.enum(PUBLIC_ROLES).catch('customer');
export const userRoleSchema = z.enum(USER_ROLES);
export const actorIdSchema = z.union([
  z.instanceof(ObjectId),
  z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid actor id.')
]);
export const verifiedActorSchema = z.object({
  id: actorIdSchema,
  email: emailSchema,
  role: userRoleSchema,
  name: requiredString('Actor name')
});

export const userSchema = z.object({
  _id: objectIdSchema.optional(),
  name: requiredString('Name'),
  email: emailSchema,
  image: urlSchema.optional(),
  role: userRoleSchema.default('customer'),
  phone: optionalTextSchema,
  area: optionalTextSchema,
  bio: optionalTextSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const userUpdateSchema = z
  .object({
    name: requiredString('Name').optional(),
    image: urlSchema.optional(),
    phone: z.string().trim().optional(),
    area: z.string().trim().optional(),
    bio: z.string().trim().optional()
  })
  .strict();

export const userProfileUpdateSchema = userUpdateSchema;

export const userRoleUpdateSchema = z
  .object({
    role: userRoleSchema
  })
  .strict();
