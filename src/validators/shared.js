import { ObjectId } from 'mongodb';
import { z } from 'zod';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\/\S+$/i;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(EMAIL_PATTERN, 'Invalid email address.');

export const objectIdSchema = z
  .union([
    z.instanceof(ObjectId),
    z.string().regex(OBJECT_ID_PATTERN, 'Invalid ObjectId.')
  ])
  .transform((value) => (value instanceof ObjectId ? value : new ObjectId(value)));

export const urlSchema = z
  .string()
  .trim()
  .regex(URL_PATTERN, 'Must be a valid http(s) URL.');

export const positiveMoneySchema = z
  .number()
  .finite('Must be a finite number.')
  .positive('Must be greater than 0.');

export const requiredString = (label) =>
  z.string().trim().min(1, `${label} is required.`);

export const optionalTextSchema = z.string().trim().optional().default('');

export const timestampSchema = z.date().default(() => new Date());

export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format.');
