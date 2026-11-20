import net from 'node:net';
import { z } from 'zod';

const PLACEHOLDER_PATTERN = /<[^>]+>|cluster\.example\.com/i;
const ALLOWED_URI_PROTOCOLS = new Set(['mongodb:', 'mongodb+srv:']);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    CLIENT_ORIGIN: z.string().trim().optional(),
    CLIENT_ORIGINS: z.string().trim().optional(),
    MONGODB_URI: z.string().trim().min(1, 'MONGODB_URI is required.'),
    MONGODB_DNS_SERVERS: z.string().trim().optional()
  })
  .superRefine((value, ctx) => {
    const entries = [value.CLIENT_ORIGIN, value.CLIENT_ORIGINS].filter(Boolean);
    const origins = entries.flatMap((entry) =>
      entry
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    );

    for (const origin of origins) {
      try {
        const parsed = new URL(origin);
        const isValid =
          ['http:', 'https:'].includes(parsed.protocol) &&
          parsed.hostname.length > 0 &&
          (parsed.pathname === '/' || parsed.pathname === '') &&
          !parsed.search &&
          !parsed.hash;

        if (!isValid) {
          throw new Error('invalid origin');
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: [origin === value.CLIENT_ORIGIN ? 'CLIENT_ORIGIN' : 'CLIENT_ORIGINS'],
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
