const DEFAULT_HSTS_MAX_AGE = 15552000;

export const createSecurityHeaders = ({
  isProduction = false,
  trustProxy = false,
  hstsMaxAge = DEFAULT_HSTS_MAX_AGE
} = {}) => {
  const hstsValue = `max-age=${hstsMaxAge}; includeSubDomains`;

  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );

    if (isProduction && trustProxy && req.secure) {
      res.setHeader('Strict-Transport-Security', hstsValue);
    }

    return next();
  };
};
