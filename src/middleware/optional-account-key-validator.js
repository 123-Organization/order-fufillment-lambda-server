const debug = require('debug');
const { validateAccountKey, extractAccountKey } = require('../validators/accountKey.validator');
const { shouldSkipAccountKeyValidation } = require('./account-key-validation-config');

const log = debug('app:optionalAccountKeyValidator');

/**
 * When account_key / accountKey / x-account-key is present, validate UUID v4.
 * Absent or blank values pass through. Skipped routes bypass validation entirely.
 */
function optionalAccountKeyValidator(req, res, next) {
  try {
    if (shouldSkipAccountKeyValidation(req)) {
      return next();
    }

    const raw = extractAccountKey(req);
    if (!raw) {
      return next();
    }

    const { valid, error } = validateAccountKey(raw);
    if (!valid) {
      log('Rejected invalid account_key on %s %s', req.method, req.originalUrl || req.url);
      return res.status(400).json({
        success: false,
        message: error?.message || 'Invalid account key'
      });
    }

    req.validatedAccountKey = raw;
    return next();
  } catch (err) {
    log('optionalAccountKeyValidator error: %s', err?.message);
    return res.status(500).json({
      success: false,
      message: 'Account key validation failed'
    });
  }
}

module.exports = optionalAccountKeyValidator;
