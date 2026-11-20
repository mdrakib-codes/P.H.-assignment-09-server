import { sendError } from '../utils/apiResponse.js';

export const notFound = (req, res) =>
  sendError(res, {
    statusCode: 404,
    code: 'ROUTE_NOT_FOUND',
    message: `Cannot ${req.method} ${req.originalUrl}.`
  });
