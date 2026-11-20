const MONGODB_URI_PATTERN = /(mongodb(?:\+srv)?:\/\/[^\s"'<>]+)/gi;
const URI_CREDENTIALS_PATTERN = /(:\/\/)([^\s/@]+)@/g;

export const redactSecrets = (value) =>
  String(value ?? '')
    .replace(MONGODB_URI_PATTERN, '[REDACTED_MONGODB_URI]')
    .replace(URI_CREDENTIALS_PATTERN, '$1[REDACTED_CREDENTIALS]@');
