const axios = require('axios');
const crypto = require('crypto');
const finerworksService = require('../helpers/finerworks-service');
const {
    putSquareAccount,
    scanAllSquareAccounts,
    deleteSquareAccountsByAccountKey,
} = require('../helpers/square-accounts-dynamo');
const debug = require('debug');
const { sendApiError } = require('../helpers/api-error');
const log = debug('app:squareAuth');
require('dotenv').config();
const { validateAccountKey } = require('../validators/accountKey.validator');

const DEFAULT_SQUARE_SCOPES =
    'ORDERS_READ ORDERS_WRITE MERCHANT_PROFILE_READ ITEMS_READ ITEMS_WRITE INVENTORY_READ INVENTORY_WRITE';
// Any valid past API version works for OAuth endpoints; pin one so behavior doesn't
// silently shift if Square's default version changes.
const DEFAULT_SQUARE_API_VERSION = '2023-10-18';

const base64UrlEncode = (input) => {
    const b64 = Buffer.from(input, 'utf8').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecode = (input) => {
    const b64 = String(input).replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    return Buffer.from(b64 + pad, 'base64').toString('utf8');
};

const getApiBaseUrl = (req) => (req.baseUrl ? req.baseUrl : '/api');

const buildRedirectUri = (req) => {
    // Keep redirect_uri consistent between initiate + callback.
    return (
        process.env.SQUARE_REDIRECT_URI ||
        `${req.protocol}://${req.get('host')}${getApiBaseUrl(req)}/square/callback`
    );
};

const getSquareClientSecret = () => process.env.SQUARE_SECRET_KEY || process.env.SQUARE_CLIENT_SECRET;

const isSandboxClientId = (id) => typeof id === 'string' && id.startsWith('sandbox-');

/** Falls back to inferring sandbox vs production from the client_id prefix so a
 *  sandbox app id is never accidentally pointed at the production connect host. */
const getSquareEnvironment = () => {
    const configured = String(process.env.SQUARE_ENVIRONMENT || '').toLowerCase();
    if (configured === 'production' || configured === 'sandbox') return configured;
    return isSandboxClientId(process.env.SQUARE_CLIENT_ID) ? 'sandbox' : 'production';
};

const getSquareBaseUrl = () =>
    getSquareEnvironment() === 'production'
        ? 'https://connect.squareup.com'
        : 'https://connect.squareupsandbox.com';

const squareApiVersionHeader = () => ({
    'Square-Version': process.env.SQUARE_API_VERSION || DEFAULT_SQUARE_API_VERSION,
});

// 'squareup' (not 'squareup.com') so the sandbox host connect.squareupsandbox.com also matches.
const errorUrlIncludes = (err, needle) =>
    Boolean(err?.response?.config?.url?.includes(needle) || err?.config?.url?.includes(needle));

/** Flattens Square's error body ({message, type} or {errors:[{code, detail}]}) into one line. */
const squareErrorDetail = (err) => {
    const data = err?.response?.data;
    if (!data) return null;
    if (typeof data === 'string') return data.trim().slice(0, 500) || null;
    const parts = [];
    if (data.message) parts.push(String(data.message));
    if (data.type) parts.push(`type=${data.type}`);
    if (Array.isArray(data.errors)) {
        for (const e of data.errors) {
            if (e?.code) parts.push(`code=${e.code}`);
            if (e?.detail) parts.push(String(e.detail));
        }
    }
    return parts.length ? parts.join(' | ').slice(0, 500) : null;
};

/** A sandbox/production mismatch between client_id and secret always yields an
 *  opaque 401 "Not Authorized" from /oauth2/token, so fail fast with a clear message. */
const getSquareCredentialMismatch = () => {
    const clientId = process.env.SQUARE_CLIENT_ID;
    const secret = getSquareClientSecret();
    if (!clientId || !secret) return null;
    const secretIsSandbox = secret.startsWith('sandbox-');
    if (isSandboxClientId(clientId) === secretIsSandbox) return null;
    return secretIsSandbox
        ? 'Square credential mismatch: SQUARE_SECRET_KEY is a sandbox secret but SQUARE_CLIENT_ID is not a sandbox application id'
        : 'Square credential mismatch: SQUARE_CLIENT_ID is a sandbox application id but SQUARE_SECRET_KEY is not a sandbox secret';
};

/**
 * Initiates Square OAuth connection by redirecting user to Square's /oauth2/authorize.
 * Expected query/body:
 * - account_key (required): OFA/FinerWorks tenant account key
 * - scope (optional): space-separated Square permissions
 * - return_url (optional): where to send the browser after a successful connect
 */
const handleSquareAuth = async (req, res) => {
    try {
        const account_key = req.query?.account_key || req.body?.account_key || req.query?.accountKey;

        const { valid, error } = validateAccountKey(account_key);
        if (!valid) {
            return sendApiError(res, 400, error.message);
        }

        const clientId = process.env.SQUARE_CLIENT_ID;
        if (!clientId) {
            return sendApiError(res, 500, 'SQUARE_CLIENT_ID not configured');
        }

        if (!getSquareClientSecret()) {
            return sendApiError(res, 500, 'SQUARE_SECRET_KEY not configured');
        }

        const credentialMismatch = getSquareCredentialMismatch();
        if (credentialMismatch) {
            return sendApiError(res, 500, credentialMismatch);
        }

        const scopes = req.query?.scope || req.body?.scope || process.env.SQUARE_SCOPES || DEFAULT_SQUARE_SCOPES;

        // Required by Square OAuth to prevent CSRF.
        // We embed account_key into state so the callback can associate tokens with a tenant.
        const nonce = crypto.randomBytes(16).toString('hex');
        const return_url = req.query?.return_url || req.body?.return_url || 'https://fa.finerworks.com/';
        const state = base64UrlEncode(JSON.stringify({ account_key, nonce, return_url, scope: scopes }));

        const redirectUri = buildRedirectUri(req);
        console.log('square redirectUri', redirectUri);

        const qs = new URLSearchParams({
            client_id: clientId,
            scope: scopes,
            redirect_uri: redirectUri,
            state,
        });
        // Sandbox only supports the default session=true; forcing the login page
        // there dead-ends because test accounts can't sign in through it.
        if (getSquareEnvironment() === 'production') {
            // Always show the account picker instead of silently reusing an existing Square session.
            qs.set('session', 'false');
        }

        const authUrl = `${getSquareBaseUrl()}/oauth2/authorize?${qs.toString()}`;
        console.log('square authUrl====>>>', authUrl);
        const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'square',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'handleSquareAuth',
            operation: 'Square OAuth initiation redirect sent successfully',
            account_key: String(account_key).trim(),
            result: { scopes, environment: getSquareEnvironment() },
            timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in handleSquareAuth: %s', successLog);
        return res.redirect(authUrl);
    } catch (err) {
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'square',
            source: 'lambda',
            function: 'handleSquareAuth',
            account_key: req.query?.account_key || req.body?.account_key || 'unknown',
            message: `Square OAuth initiation failed: ${err?.message || 'Unknown error'}`,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in handleSquareAuth: %s', errorJson);
        return sendApiError(res, err);
    }
};

/**
 * OAuth callback handler:
 * - exchanges `code` for access_token/refresh_token via POST /oauth2/token
 * - saves the tokens into FinerWorks tenant connections
 * - persists the row into the `square-accounts` DynamoDB table for the renewal job
 * - optionally redirects the browser (if return_url provided)
 */
const handleSquareCallback = async (req, res) => {
    try {
        const code = req.query?.code;
        const state = req.query?.state;
        const error = req.query?.error;
        const error_description = req.query?.error_description;
        let return_url = req.query?.return_url;
        log('handleSquareCallback', { code, state, error, error_description, return_url });

        if (error) {
            return sendApiError(res, 400, error_description || error || 'oauth_error');
        }

        if (!code || !state) {
            return sendApiError(res, 400, 'Missing required parameters: code, state');
        }

        let stateObj = null;
        try {
            stateObj = JSON.parse(base64UrlDecode(state));
        } catch (_e) {
            // Not a state we generated; treat as invalid.
            return sendApiError(res, 400, 'Invalid state');
        }
        return_url = stateObj?.return_url || return_url || null;

        const account_key = stateObj?.account_key;
        if (!account_key) {
            return sendApiError(res, 400, 'Invalid state: missing account_key');
        }

        const clientId = process.env.SQUARE_CLIENT_ID;
        const clientSecret = getSquareClientSecret();
        if (!clientId || !clientSecret) {
            return sendApiError(res, 500, 'Square OAuth credentials not configured');
        }

        const credentialMismatch = getSquareCredentialMismatch();
        if (credentialMismatch) {
            return sendApiError(res, 500, credentialMismatch);
        }

        const redirectUri = buildRedirectUri(req);

        const tokenResp = await axios.post(
            `${getSquareBaseUrl()}/oauth2/token`,
            {
                client_id: clientId,
                client_secret: clientSecret,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...squareApiVersionHeader(),
                },
                timeout: 20000,
            }
        );

        const tokenData = tokenResp?.data;
        if (!tokenData?.access_token) {
            return sendApiError(res, 400, 'Token exchange succeeded but access_token missing');
        }

        const getInformation = await finerworksService.GET_INFO({ account_key });
        const connections = getInformation?.user_account?.connections || [];

        // Replace existing Square connection (if any).
        const nextConnections = Array.isArray(connections)
            ? (() => {
                const idx = connections.findIndex((c) => c && c.name === 'Square');
                const copy = JSON.parse(JSON.stringify(connections));
                if (idx !== -1) copy.splice(idx, 1);

                copy.push({
                    name: 'Square',
                    // Keep the same pattern as Shopify/Squarespace: id stores the access token.
                    id: tokenData.access_token,
                    data: JSON.stringify({
                        ...tokenData,
                        scope: stateObj?.scope || null,
                        redirect_uri: redirectUri,
                        state_nonce: stateObj?.nonce,
                        needs_reauth: false,
                    }),
                });
                return copy;
            })()
            : [
                {
                    name: 'Square',
                    id: tokenData.access_token,
                    data: JSON.stringify({
                        ...tokenData,
                        scope: stateObj?.scope || null,
                        needs_reauth: false,
                    }),
                },
            ];

        await finerworksService.UPDATE_INFO({
            account_key,
            connections: nextConnections,
        });

        try {
            await putSquareAccount({
                id: crypto.randomUUID(),
                account_key,
                merchant_id: tokenData.merchant_id || null,
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token || null,
                expires_at: tokenData.expires_at ?? null,
                token_type: tokenData.token_type ?? null,
                redirect_uri: redirectUri,
                scope: stateObj?.scope || null,
                needs_reauth: false,
            });
        } catch (dynamoErr) {
            console.error(JSON.stringify({
                level: 'ERROR',
                platform: 'square',
                source: 'lambda',
                function: 'handleSquareCallback',
                account_key: account_key || 'unknown',
                message: `Failed to write Square account to DynamoDB: ${dynamoErr?.message || 'Unknown error'}`,
                timestamp: new Date().toISOString()
            }));
        }

        if (return_url) {
            const callbackRedirectLog = JSON.stringify({
                level: 'INFO',
                platform: 'square',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'handleSquareCallback',
                operation: 'Square OAuth callback handled successfully, redirecting',
                account_key: String(account_key).trim(),
                result: { redirected: true, merchant_id: tokenData.merchant_id || null },
                timestamp: new Date().toISOString()
            });
            console.log(callbackRedirectLog);
            log('Success in handleSquareCallback: %s', callbackRedirectLog);
            const sep = return_url.includes('?') ? '&' : '?';
            return res.redirect(`${return_url}${sep}success=1`);
        }

        const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'square',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'handleSquareCallback',
            operation: 'Square OAuth callback handled and connection saved successfully',
            account_key: String(account_key).trim(),
            result: { connected: true, merchant_id: tokenData.merchant_id || null },
            timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in handleSquareCallback: %s', successLog);
        return res.status(200).json({
            success: true,
            message: 'Square connection added successfully',
        });
    } catch (err) {
        const isSquareError = errorUrlIncludes(err, 'squareup');
        const isFinerworksError = errorUrlIncludes(err, 'finerworks');
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'square',
            source: isSquareError ? 'square_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
            function: 'handleSquareCallback',
            httpStatus: err?.response?.status || null,
            message: `Square OAuth callback failed: ${err?.message || 'Unknown error'}`,
            detail: squareErrorDetail(err),
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in handleSquareCallback: %s', errorJson);
        return sendApiError(res, err);
    }
};

const exchangeSquareRefreshToken = async (refresh_token) => {
    const clientId = process.env.SQUARE_CLIENT_ID;
    const clientSecret = getSquareClientSecret();
    if (!clientId || !clientSecret) {
        throw new Error('Square OAuth credentials not configured');
    }

    const tokenResp = await axios.post(
        `${getSquareBaseUrl()}/oauth2/token`,
        {
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: String(refresh_token).trim(),
        },
        {
            headers: {
                'Content-Type': 'application/json',
                ...squareApiVersionHeader(),
            },
            timeout: 20000,
        }
    );

    return tokenResp?.data || {};
};

/** Square returns a 401 + `errors[]` body when a refresh/access token is dead; only then try FinerWorks fallback. */
function isSquareInvalidTokenError(err) {
    const status = err?.response?.status;
    const errors = err?.response?.data?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
        return errors.some((e) =>
            ['ACCESS_TOKEN_REVOKED', 'ACCESS_TOKEN_EXPIRED', 'UNAUTHORIZED', 'INVALID_REQUEST_ERROR', 'INVALID_REQUEST'].includes(e?.code)
        );
    }
    return status === 401;
}

/**
 * Reads OAuth material from FinerWorks `connections` Square entry (may be newer than Dynamo after a web re-link).
 */
async function getFinerworksSquareOAuthSnapshot(account_key) {
    const getInformation = await finerworksService.GET_INFO({ account_key });
    const connections = getInformation?.user_account?.connections;
    if (!Array.isArray(connections)) return null;
    const conn = connections.find((c) => c && c.name === 'Square');
    if (!conn) return null;

    let data = {};
    if (typeof conn.data === 'string') {
        try {
            data = JSON.parse(conn.data);
        } catch (_) {
            data = {};
        }
    } else if (conn.data && typeof conn.data === 'object') {
        data = { ...conn.data };
    }

    const refresh_token = data.refresh_token != null ? String(data.refresh_token).trim() : '';
    const access_token =
        data.access_token != null
            ? String(data.access_token).trim()
            : conn.id != null
                ? String(conn.id).trim()
                : '';

    return {
        refresh_token: refresh_token || null,
        access_token: access_token || null,
        merchant_id: data.merchant_id ?? null,
        redirect_uri: data.redirect_uri ?? null,
        scope: data.scope ?? null,
        expires_at: data.expires_at ?? null,
        needs_reauth: data.needs_reauth === true,
    };
}

/**
 * Marks Square connection in FinerWorks so the app/UI can prompt for OAuth again.
 * Does not remove existing tokens (so partial recovery / support is still possible).
 */
async function markSquareNeedsReauthInFinerworks(account_key, reasonCode) {
    const getInformation = await finerworksService.GET_INFO({ account_key });
    const connections = Array.isArray(getInformation?.user_account?.connections)
        ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
        : [];
    const idx = connections.findIndex((c) => c && c.name === 'Square');
    if (idx === -1) return;

    const existingDataRaw = connections[idx]?.data;
    let existingData = {};
    if (typeof existingDataRaw === 'string') {
        try {
            existingData = JSON.parse(existingDataRaw);
        } catch (_) {
            existingData = {};
        }
    } else if (existingDataRaw && typeof existingDataRaw === 'object') {
        existingData = { ...existingDataRaw };
    }

    const mergedData = {
        ...existingData,
        needs_reauth: true,
        needs_reauth_reason: reasonCode || 'invalid-token',
        needs_reauth_at: new Date().toISOString(),
    };

    connections[idx] = {
        name: 'Square',
        id: connections[idx].id,
        data: JSON.stringify(mergedData),
    };

    await finerworksService.UPDATE_INFO({ account_key, connections });
}

/**
 * Refreshes tokens using Dynamo row first; if Square rejects the refresh token, retries with FinerWorks
 * `connections[].data` refresh_token when it differs (e.g. user re-linked in browser but cron still had stale Dynamo).
 * New pairs can only be issued by Square after the user completes OAuth again — there is no server-side mint.
 */
async function refreshSquareTokensForRenewalJob(account_key, dynamoRefreshToken) {
    const rtDynamo = String(dynamoRefreshToken || '').trim();
    try {
        return await refreshSquareTokensCore(account_key, rtDynamo);
    } catch (primaryErr) {
        if (!isSquareInvalidTokenError(primaryErr)) {
            throw primaryErr;
        }

        let fw = null;
        try {
            fw = await getFinerworksSquareOAuthSnapshot(account_key);
        } catch (fwErr) {
            log('renewal: FinerWorks snapshot failed', { account_key, message: fwErr?.message });
        }

        const rtFw = fw?.refresh_token ? String(fw.refresh_token).trim() : '';
        if (rtFw && rtFw !== rtDynamo) {
            log('renewal: retry refresh with FinerWorks refresh_token', { account_key });
            return await refreshSquareTokensCore(account_key, rtFw);
        }

        throw primaryErr;
    }
}

const saveSquareTokensToFinerworks = async (account_key, tokenData) => {
    if (!tokenData?.access_token) {
        throw new Error('Square token payload missing access_token');
    }

    const getInformation = await finerworksService.GET_INFO({ account_key });
    const connections = Array.isArray(getInformation?.user_account?.connections)
        ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
        : [];

    const idx = connections.findIndex((c) => c && c.name === 'Square');
    const existingDataRaw = idx !== -1 ? connections[idx]?.data : null;
    let existingData = {};
    if (typeof existingDataRaw === 'string') {
        try {
            existingData = JSON.parse(existingDataRaw);
        } catch (_) {
            existingData = {};
        }
    } else if (existingDataRaw && typeof existingDataRaw === 'object') {
        existingData = existingDataRaw;
    }

    const mergedData = {
        ...existingData,
        ...tokenData,
        needs_reauth: false,
    };
    delete mergedData.needs_reauth_reason;
    delete mergedData.needs_reauth_at;

    const nextConnection = {
        name: 'Square',
        id: tokenData.access_token,
        data: JSON.stringify(mergedData),
    };

    if (idx !== -1) {
        connections[idx] = nextConnection;
    } else {
        connections.push(nextConnection);
    }

    await finerworksService.UPDATE_INFO({
        account_key,
        connections,
    });
};

const refreshSquareTokensCore = async (account_key, refresh_token) => {
    const tokenData = await exchangeSquareRefreshToken(refresh_token);
    if (!tokenData?.access_token) {
        const err = new Error('Token refresh response missing access_token');
        err.tokenData = tokenData;
        throw err;
    }
    await saveSquareTokensToFinerworks(account_key, tokenData);
    return tokenData;
};

/**
 * Refreshes Square access token using refresh_token and persists
 * the new access/refresh token into tenant connections.
 *
 * Expected body/query:
 * - account_key (required)
 * - refresh_token (required)
 */
const refreshSquareToken = async (req, res) => {
    try {
        const account_key =
            req.body?.account_key ||
            req.body?.accountKey ||
            req.query?.account_key ||
            req.query?.accountKey;
        const refresh_token =
            req.body?.refresh_token ||
            req.body?.refreshToken ||
            req.query?.refresh_token ||
            req.query?.refreshToken;

        if (!account_key || !refresh_token) {
            return sendApiError(res, 400, 'Missing required parameters: account_key and refresh_token');
        }

        const tokenData = await refreshSquareTokensCore(account_key, refresh_token);

        try {
            await putSquareAccount({
                id: crypto.randomUUID(),
                account_key,
                merchant_id: tokenData.merchant_id || null,
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token || refresh_token,
                expires_at: tokenData.expires_at ?? null,
                token_type: tokenData.token_type ?? null,
                needs_reauth: false,
            });
        } catch (dynamoErr) {
            log('refreshSquareToken: failed to sync DynamoDB', { account_key, message: dynamoErr?.message });
        }

        const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'square',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'refreshSquareToken',
            operation: 'Square access token refreshed successfully',
            account_key: String(account_key).trim(),
            result: { expires_at: tokenData.expires_at ?? null, hasRefreshToken: !!(tokenData.refresh_token || refresh_token) },
            timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in refreshSquareToken: %s', successLog);
        return res.status(200).json({
            success: true,
            message: 'Square token refreshed successfully',
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || refresh_token,
            expires_at: tokenData.expires_at ?? null,
            merchant_id: tokenData.merchant_id ?? null,
        });
    } catch (err) {
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'square',
            source: 'square_api',
            function: 'refreshSquareToken',
            account_key: req.body?.account_key || req.query?.account_key || 'unknown',
            httpStatus: err?.response?.status || null,
            message: `Square token refresh failed: ${err?.message || 'Unknown error'}`,
            detail: squareErrorDetail(err),
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in refreshSquareToken: %s', errorJson);
        return sendApiError(res, err);
    }
};

/**
 * Scans `square-accounts` DynamoDB table, refreshes tokens, updates FinerWorks
 * connections, and writes refreshed tokens back to DynamoDB.
 */
const runSquareTokenRenewalJob = async () => {
    const rows = await scanAllSquareAccounts();
    const summary = { renewed: [], skipped: [], errors: [], needs_reauth: [] };

    for (const row of rows) {
        log('runSquareTokenRenewalJob', { row });
        const account_key = row.account_key;
        const refresh_token = row.refresh_token;
        if (!account_key || !refresh_token) {
            summary.skipped.push({
                account_key: account_key || null,
                reason: 'missing account_key or refresh_token',
            });
            continue;
        }

        if (row.id == null || String(row.id).trim() === '') {
            summary.skipped.push({
                account_key,
                reason: 'missing id on DynamoDB item',
            });
            continue;
        }

        try {
            const tokenData = await refreshSquareTokensForRenewalJob(account_key, refresh_token);
            await putSquareAccount({
                id: row.id,
                account_key,
                merchant_id: tokenData.merchant_id || row.merchant_id || null,
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token || refresh_token,
                expires_at: tokenData.expires_at ?? null,
                token_type: tokenData.token_type ?? null,
                redirect_uri: row.redirect_uri ?? null,
                scope: row.scope ?? null,
                needs_reauth: false,
            });
            summary.renewed.push(account_key);
        } catch (err) {
            const errorJsonRoot = JSON.stringify({
                level: 'ERROR',
                platform: 'square',
                source: isSquareInvalidTokenError(err) ? 'square_api' : 'lambda',
                function: 'runSquareTokenRenewalJob',
                account_key: account_key || 'unknown',
                httpStatus: err?.response?.status || null,
                message: `Square token renewal failed: ${err?.message || 'Unknown error'}`,
                detail: squareErrorDetail(err),
                timestamp: new Date().toISOString()
            });
            console.error(errorJsonRoot);
            log('Formatted error in runSquareTokenRenewalJob: %s', errorJsonRoot);
            summary.errors.push({
                account_key,
                message: err?.message || 'Unknown error',
                ...(isSquareInvalidTokenError(err) ? { code: 'invalid-token' } : {}),
            });

            if (isSquareInvalidTokenError(err)) {
                try {
                    await markSquareNeedsReauthInFinerworks(account_key, 'invalid-token');
                } catch (markFwErr) {
                    console.error(JSON.stringify({
                        level: 'ERROR',
                        platform: 'square',
                        source: 'finerworks_api',
                        function: 'runSquareTokenRenewalJob',
                        account_key: account_key || 'unknown',
                        httpStatus: markFwErr?.response?.status || null,
                        message: `Failed to mark Square needs_reauth in FinerWorks: ${markFwErr?.message || 'Unknown error'}`,
                        timestamp: new Date().toISOString()
                    }));
                }
                try {
                    await putSquareAccount({
                        id: row.id,
                        account_key,
                        merchant_id: row.merchant_id ?? null,
                        access_token: row.access_token,
                        refresh_token: row.refresh_token,
                        expires_at: row.expires_at ?? null,
                        token_type: row.token_type ?? null,
                        redirect_uri: row.redirect_uri ?? null,
                        scope: row.scope ?? null,
                        needs_reauth: true,
                        needs_reauth_reason: 'invalid-token',
                        needs_reauth_at: new Date().toISOString(),
                    });
                    summary.needs_reauth.push(account_key);
                } catch (dynamoErr) {
                    console.error(JSON.stringify({
                        level: 'ERROR',
                        platform: 'square',
                        source: 'lambda',
                        function: 'runSquareTokenRenewalJob',
                        account_key: account_key || 'unknown',
                        message: `Failed to write Square needs_reauth flag to DynamoDB: ${dynamoErr?.message || 'Unknown error'}`,
                        timestamp: new Date().toISOString()
                    }));
                }
            }
        }
    }

    return summary;
};

/** POST client_id + access_token/merchant_id to /oauth2/revoke, auth'd via `Authorization: Client <secret>`. */
const revokeSquareAccessToken = async ({ access_token, merchant_id }) => {
    const clientId = process.env.SQUARE_CLIENT_ID;
    const clientSecret = getSquareClientSecret();
    if (!clientId || !clientSecret) {
        throw new Error('Square OAuth credentials not configured');
    }
    if (!access_token && !merchant_id) {
        throw new Error('revokeSquareAccessToken: access_token or merchant_id is required');
    }

    const body = { client_id: clientId };
    if (access_token) body.access_token = access_token;
    if (merchant_id) body.merchant_id = merchant_id;

    const resp = await axios.post(`${getSquareBaseUrl()}/oauth2/revoke`, body, {
        headers: {
            Authorization: `Client ${clientSecret}`,
            'Content-Type': 'application/json',
            ...squareApiVersionHeader(),
        },
        timeout: 20000,
    });

    return resp?.data || {};
};

/**
 * Disconnects Square: revokes the token with Square, then clears the local
 * FinerWorks connection and DynamoDB row so the seller can reconnect cleanly.
 * Expects body/query: { account_key }
 */
const handleSquareDisconnect = async (req, res) => {
    try {
        const account_key = req.body?.account_key || req.query?.account_key;
        if (!account_key) {
            return sendApiError(res, 400, 'Missing required parameter: account_key');
        }

        const getInformation = await finerworksService.GET_INFO({ account_key });
        const connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections || []));
        const idx = connections.findIndex((c) => c && c.name === 'Square');

        if (idx === -1) {
            return res.status(200).json({
                success: true,
                message: 'No Square connection found; nothing to disconnect',
                connections,
            });
        }

        let existingData = {};
        const raw = connections[idx]?.data;
        if (typeof raw === 'string') {
            try {
                existingData = JSON.parse(raw);
            } catch (_) {
                existingData = {};
            }
        } else if (raw && typeof raw === 'object') {
            existingData = raw;
        }

        try {
            await revokeSquareAccessToken({
                access_token: existingData.access_token || connections[idx].id,
                merchant_id: existingData.merchant_id,
            });
        } catch (revokeErr) {
            // A seller-initiated disconnect shouldn't get stuck if Square already
            // invalidated the token on its side — log and proceed to clear locally.
            console.error(JSON.stringify({
                level: 'ERROR',
                platform: 'square',
                source: 'square_api',
                function: 'handleSquareDisconnect',
                account_key,
                httpStatus: revokeErr?.response?.status || null,
                message: `Square token revoke failed: ${revokeErr?.message || 'Unknown error'}`,
                timestamp: new Date().toISOString(),
            }));
        }

        connections[idx] = { name: 'Square', id: null, data: null };
        await finerworksService.UPDATE_INFO({ account_key, connections });

        try {
            await deleteSquareAccountsByAccountKey(account_key);
        } catch (dynamoErr) {
            console.error(JSON.stringify({
                level: 'ERROR',
                platform: 'square',
                source: 'lambda',
                function: 'handleSquareDisconnect',
                account_key,
                message: `Failed to delete Square DynamoDB row(s): ${dynamoErr?.message || 'Unknown error'}`,
                timestamp: new Date().toISOString(),
            }));
        }

        const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'square',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'handleSquareDisconnect',
            operation: 'Square disconnected successfully',
            account_key,
            result: { disconnected: true },
            timestamp: new Date().toISOString(),
        });
        console.log(successLog);
        log('Success in handleSquareDisconnect: %s', successLog);
        return res.status(200).json({
            success: true,
            message: 'Square disconnected successfully',
            connections,
        });
    } catch (err) {
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'square',
            source: 'finerworks_api',
            function: 'handleSquareDisconnect',
            account_key: req.body?.account_key || req.query?.account_key || 'unknown',
            httpStatus: err?.response?.status || null,
            message: `Square disconnect failed: ${err?.message || 'Unknown error'}`,
            timestamp: new Date().toISOString(),
        });
        console.error(errorJson);
        log('Formatted error in handleSquareDisconnect: %s', errorJson);
        return sendApiError(res, err);
    }
};

module.exports = {
    handleSquareAuth,
    handleSquareCallback,
    refreshSquareToken,
    runSquareTokenRenewalJob,
    handleSquareDisconnect,
    // Shared Square helpers (used by square-products sync)
    getSquareBaseUrl,
    squareApiVersionHeader,
    refreshSquareTokensCore,
    getFinerworksSquareOAuthSnapshot,
    isSquareInvalidTokenError,
    squareErrorDetail,
};
