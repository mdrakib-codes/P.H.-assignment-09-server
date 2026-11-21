import { sendError } from '../utils/apiResponse.js';
import { AppError } from '../utils/AppError.js';
import { redactSecrets, redactUrl } from '../utils/redact.js';

const isJsonParseError = (error) =>
  error?.type === 'entity.parse.failed' ||
  (error instanceof SyntaxError && 'body' in error);

const isZodError = (error) =>
  error?.name === 'ZodError' && typeof error.flatten === 'function';

export const errorHandler = (error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  let statusCode = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : Number.isInteger(error?.status)
      ? error.status
      : 500;
  let code = error?.code || (statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR');
  let message = error?.message || 'Something went wrong.';
  let details = error?.details;

  if (isJsonParseError(error)) {
    statusCode = 400;
    code = 'MALFORMED_JSON';
    message = 'Malformed JSON body.';
    details = undefined;
  } else if (error?.type === 'entity.too.large') {
    statusCode = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request payload is too large.';
    details = undefined;
  } else if (isZodError(error)) {
    statusCode = 422;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed.';
    details = error.flatten();
  } else if (!(error instanceof AppError)) {
    code = statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR';
    message =
      statusCode >= 500
        ? 'Something went wrong.'
        : 'Request could not be completed.';
    details = undefined;
  }

  if (statusCode >= 500) {
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${redactUrl(req.originalUrl)}`,
      redactSecrets(error?.message || 'Unknown error')
    );
    if (error?.stack) {
      console.error(redactSecrets(error.stack));
    }
    code = 'INTERNAL_SERVER_ERROR';
    message = 'Something went wrong.';
    details = undefined;
  }

  return sendError(res, { statusCode, code, message, details });
};
