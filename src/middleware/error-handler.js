const debug = require('debug');
const { normalizeError, sanitizePublicData, sendApiError } = require('../helpers/api-error');

const log = debug('app:error');

function isJsonSyntaxError(err) {
    return (
        err instanceof SyntaxError &&
        (err.status === 400 || err.type === 'entity.parse.failed' || /json/i.test(String(err.message)))
    );
}

function errorHandler(err, req, res, _next) {
    if (res.headersSent) {
        log('Error after headers sent on %s %s: %s', req.method, req.originalUrl, err?.message);
        return;
    }

    log('Error on %s %s: %s', req.method, req.originalUrl || req.url, err?.message);
    if (process.env.NODE_ENV !== 'production' && err?.stack) {
        log(err.stack);
    }

    if (isJsonSyntaxError(err)) {
        return sendApiError(res, 400, 'Invalid JSON body', {});
    }

    const normalized = normalizeError(err);
    const safeData = sanitizePublicData(normalized.data);
    return res.status(normalized.statusCode).json({
        status: false,
        message: normalized.message,
        data: safeData,
    });
}

function notFoundHandler(req, res) {
    if (!String(req.originalUrl || req.url || '').startsWith('/api')) {
        return res.status(404).send('Not found');
    }
    return sendApiError(res, 404, 'Not found', {});
}

module.exports = {
    errorHandler,
    notFoundHandler,
};