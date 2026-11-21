import net from 'node:net';
import { z } from 'zod';

const PLACEHOLDER_PATTERN = /<[^>]+>|cluster\.example\.com/i;
const ALLOWED_URI_PROTOCOLS = new Set(['mongodb:', 'mongodb+srv:']);
const booleanFromEnvSchema = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .regex(/^(true|false|1|0)$/i, 'Must be true or false.')
    .transform((value) => ['true', '1'].includes(value.toLowerCase()))
]);

const isValidOrigin = (origin) => {
  try {
    const parsed = new URL(origin);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      parsed.hostname.length > 0 &&
      (parsed.pathname === '/' || parsed.pathname === '') &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
};

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    CLIENT_ORIGIN: z.string().trim().optional(),
    CLIENT_ORIGINS: z.string().trim().optional(),
    MONGODB_URI: z.string().trim().min(1, 'MONGODB_URI is required.'),
    MONGODB_DNS_SERVERS: z.string().trim().optional(),
    STRIPE_SECRET_KEY: z.string().trim().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().trim().optional(),
    IMGBB_API_KEY: z.string().trim().optional(),
    TRUST_PROXY: booleanFromEnvSchema.optional(),
    RATE_LIMIT_ENABLED: booleanFromEnvSchema.optional(),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100000).default(600),
    HEALTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100000).default(120),
    SERVICE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100000).default(120),
    WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100000).default(1000),
    RATE_LIMIT_MAX_ENTRIES: z.coerce.number().int().min(100).max(100000).default(10000)
  })
  .superRefine((value, ctx) => {
    const hasMultiValuePrimaryOrigin = (value.CLIENT_ORIGIN || '').includes(',');
    const primaryOrigins =
      value.CLIENT_ORIGIN && !hasMultiValuePrimaryOrigin ? [value.CLIENT_ORIGIN] : [];
    const additionalOrigins = (value.CLIENT_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const origins = [...primaryOrigins, ...additionalOrigins];

    if (hasMultiValuePrimaryOrigin) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLIENT_ORIGIN'],
        message: 'CLIENT_ORIGIN must contain exactly one origin; use CLIENT_ORIGINS for additional origins.'
      });
    }

    for (const origin of primaryOrigins) {
      if (!isValidOrigin(origin)) {
        ctx.addIssue({
          code: 'custom',
          path: ['CLIENT_ORIGIN'],
          message: `Invalid CORS origin: ${origin}`
        });
      }
    }

    for (const origin of additionalOrigins) {
      if (!isValidOrigin(origin)) {
        ctx.addIssue({
          code: 'custom',
          path: ['CLIENT_ORIGINS'],
          message: `Invalid CORS origin: ${origin}`
        });
      }
    }

    if (value.NODE_ENV === 'production' && origins.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLIENT_ORIGIN'],
        message: 'CLIENT_ORIGIN or CLIENT_ORIGINS is required in production.'
      });
    }

    if (value.NODE_ENV === 'production' && !value.STRIPE_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'STRIPE_SECRET_KEY is required in production.'
      });
    }

    if (value.NODE_ENV === 'production' && !value.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'STRIPE_WEBHOOK_SECRET is required in production.'
      });
    }

    if (value.IMGBB_API_KEY && /<[^>]+>|replace[_-]?me/i.test(value.IMGBB_API_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMGBB_API_KEY'],
        message: 'Replace the IMGBB_API_KEY placeholder with a real server-side key.'
      });
    }

    const dnsServers = (value.MONGODB_DNS_SERVERS || '')
      .split(',')
      .map((server) => server.trim())
      .filter(Boolean);

    if (dnsServers.some((server) => net.isIP(server) === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_DNS_SERVERS'],
        message: 'MONGODB_DNS_SERVERS must contain only comma-separated IP addresses.'
      });
    }

    const uri = value.MONGODB_URI;

    if (PLACEHOLDER_PATTERN.test(uri)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_URI'],
        message: 'Replace the MONGODB_URI placeholder with your real MongoDB connection string.'
      });
      return;
    }

    try {
      const parsed = new URL(uri);
      if (!ALLOWED_URI_PROTOCOLS.has(parsed.protocol) || parsed.hostname.length === 0) {
        throw new Error('invalid protocol or host');
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_URI'],
        message: 'MONGODB_URI must be a valid mongodb:// or mongodb+srv:// connection string.'
      });
    }
  });

export const validateEnv = (source) => {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
};
