const Joi = require('joi');
const debug = require('debug');
const log = debug('app:accountKeyValidator');

const schema = Joi.object({
    account_key: Joi.string().uuid({ version: ['uuidv4'] }).required().label('Account Key')
});

function normalizeAccountKeyValue(value) {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed || null;
}

function extractAccountKey(req) {
    if (!req) return null;

    const fromQuery =
        req.query?.account_key ??
        req.query?.accountKey ??
        null;

    const fromBody =
        req.body &&
            typeof req.body === 'object' &&
            !Buffer.isBuffer(req.body)
            ? req.body.account_key ?? req.body.accountKey ?? null
            : null;

    const fromHeader =
        req.headers?.['x-account-key'] ??
        req.headers?.['account-key'] ??
        null;

    return (
        normalizeAccountKeyValue(fromQuery) ||
        normalizeAccountKeyValue(fromBody) ||
        normalizeAccountKeyValue(fromHeader)
    );
}

const validateAccountKey = (account_key) => {
    const { error } = schema.validate({ account_key }, { abortEarly: true });

    if (error) {
        log('Account key validation failed', error);
        return {
            valid: false,
            error: { message: error.details[0]?.message || 'Invalid account key' }
        };
    }
    return {
        valid: true,
        error: null
    };
};

module.exports = { validateAccountKey, extractAccountKey };