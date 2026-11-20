import { AppError } from '../utils/AppError.js';
import { env } from './env.js';

export const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, false);
    }

    if (env.allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
      return callback(null, true);
    }

    return callback(
      new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed by CORS.')
    );
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 204
};
