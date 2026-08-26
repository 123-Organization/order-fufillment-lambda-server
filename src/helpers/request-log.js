/**
 * Shared helper for logging incoming request payloads consistently across controllers, with
 * sensitive fields (payment card data, tokens, secrets) redacted before anything is written to
 * CloudWatch. Field names are matched case-insensitively and by substring, so e.g. `cardNumber`,
 * `card_number`, and `CardNumber` are all caught by the same `card` entry.
 */

const SENSITIVE_KEY_PATTERNS = [
  'password',
  'cvv',
  'cvc',
  'cardnumber',
  'card_number',
  'cardno',
  'card',
  'ccnumber',
  'expirationdate',
  'expiration_date',
  'expdate',
  'securitycode',
  'payment_method_nonce',
  'paymentmethodnonce',
  'nonce',
  // Broad "token" match catches access_token, refresh_token, payment_token, client_token,
  // auth_token, etc. — anything with "token" in the name is treated as sensitive by default.
  'token',
  'session',
  'client_secret',
  'clientsecret',
  'secret',
  'api_key',
  'apikey',
  'authorization',
  'auth_code',
  'authcode',
  'ssn',
  'pin',
];

function isSensitiveKey(key) {
  const k = String(key || '').toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => k.includes(pattern));
}

/**
 * Deep-clones `value`, replacing any value whose key matches a sensitive pattern with
 * '[REDACTED]'. Arrays are walked element-by-element; non-plain values (Buffer, Date, etc.) are
 * passed through as-is rather than traversed.
 */
function redactSensitive(value, seen = new WeakSet()) {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  if (typeof value === 'object' && value.constructor === Object) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? '[REDACTED]' : redactSensitive(val, seen);
    }
    return out;
  }

  return value;
}

/** Caps the JSON-stringified size of a logged payload so one giant request body can't flood a log line. */
function redactAndTruncate(value, maxLen = 4000) {
  const redacted = redactSensitive(value);
  let str;
  try {
    str = JSON.stringify(redacted);
  } catch (_) {
    return '[UNSERIALIZABLE]';
  }
  if (!str) return str;
  return str.length > maxLen ? `${str.slice(0, maxLen)}...[truncated ${str.length - maxLen} chars]` : str;
}

/**
 * One-line "request received" log, sanitized and size-capped. Call at the top of a route handler,
 * right after entering the try block, so every request leaves a trace before any processing (and
 * therefore any failure) happens.
 */
function logIncomingRequest(log, { method, path, functionName, accountKey, body, query }) {
  log(
    'Incoming request: %s %s function=%s account_key=%s query=%s body=%s',
    method || 'UNKNOWN',
    path || 'UNKNOWN',
    functionName || 'unknown',
    accountKey || 'unknown',
    query && Object.keys(query || {}).length ? redactAndTruncate(query) : '{}',
    body && Object.keys(body || {}).length ? redactAndTruncate(body) : '{}'
  );
}

module.exports = {
  redactSensitive,
  redactAndTruncate,
  logIncomingRequest,
};
