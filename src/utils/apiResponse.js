export const sendSuccess = (res, { message, statusCode = 200, ...payload }) =>
  res.status(statusCode).json({
    success: true,
    message,
    ...payload
  });

export const sendError = (
  res,
  {
    statusCode = 500,
    code = 'INTERNAL_SERVER_ERROR',
    message = 'Something went wrong.',
    details
  }
) => {
  const body = {
    success: false,
    message,
    error: { code }
  };

  if (details !== undefined) {
    body.error.details = details;
  }

  return res.status(statusCode).json(body);
};
