const MONGODB_URI_PATTERN = /(mongodb(?:\+srv)?:\/\/[^\s"'<>]+)/gi;
const URI_CREDENTIALS_PATTERN = /(:\/\/)([^\s/@]+)@/g;
const STRIPE_SECRET_PATTERN = /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+/gi;
const STRIPE_WEBHOOK_SECRET_PATTERN = /\bwhsec_[A-Za-z0-9]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SENSITIVE_FIELD_PATTERN =
  /(^|[?&\s"'])((?:(?:imgbb[_-]?)?api[_-]?key|token|secret|password|session_id|authorization)\s*[=:]\s*)(["']?)([^\s&"'<>]+)\3/gi;
const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'secret',
  'key',
  'api_key',
  'apikey',
  'password',
  'session_id',
  'authorization'
]);

export const redactSecrets = (value) =>
  String(value ?? '')
    .replace(MONGODB_URI_PATTERN, '[REDACTED_MONGODB_URI]')
    .replace(STRIPE_SECRET_PATTERN, '[REDACTED_STRIPE_KEY]')
    .replace(STRIPE_WEBHOOK_SECRET_PATTERN, '[REDACTED_STRIPE_WEBHOOK_SECRET]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(SENSITIVE_FIELD_PATTERN, '$1$2$3[REDACTED]$3')
    .replace(URI_CREDENTIALS_PATTERN, '$1[REDACTED_CREDENTIALS]@');

export const redactUrl = (value) => {
  const raw = String(value ?? '');

  try {
    const url = new URL(raw, 'http://redact.invalid');

    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }

    return redactSecrets(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return redactSecrets(raw);
  }
};
