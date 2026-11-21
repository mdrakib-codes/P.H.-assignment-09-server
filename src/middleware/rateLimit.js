// In-memory state is per process; multiple instances require a shared limiter.
import { sendError } from '../utils/apiResponse.js';

const defaultKeyGenerator = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

export const createRateLimiter = ({
  windowMs = 60000,
  max = 600,
  maxEntries = 10000,
  keyGenerator = defaultKeyGenerator,
  message = 'Too many requests. Please try again later.'
} = {}) => {
  const entries = new Map();

  const purgeExpired = (now) => {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) {
        entries.delete(key);
      }
    }
  };

  const enforceEntryLimit = () => {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }
  };

  return (req, res, next) => {
    const now = Date.now();

    purgeExpired(now);

    const key = keyGenerator(req);
    let entry = entries.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
      enforceEntryLimit();
    }

    entry.count += 1;

    if (entry.count > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      return sendError(res, {
        statusCode: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        message
      });
    }

    return next();
  };
};
