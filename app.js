const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { handleWixAppInstanceInstalled } = require('./src/controllers/wix-webhooks');
const { handleWixOAuthCallback } = require('./src/controllers/wix-auth');
const { handleWixOrderCreateWebhook } = require('./src/controllers/wix-order-create-webhook');
const optionalAccountKeyValidator = require('./src/middleware/optional-account-key-validator');
const asyncHandler = require('./src/middleware/async-handler');
const { errorHandler, notFoundHandler } = require('./src/middleware/error-handler');
const debug = require('debug');
const log = debug('app:appIndex');

function registerProcessErrorHooks() {
  process.on('unhandledRejection', (reason) => {
    log('Unhandled promise rejection: %s', reason?.message || reason);
    if (process.env.NODE_ENV !== 'production' && reason?.stack) {
      log(reason.stack);
    }
  });
  process.on('uncaughtException', (err) => {
    log('Uncaught exception: %s', err?.message || err);
    if (err?.stack) log(err.stack);
  });
}

registerProcessErrorHooks();
app.use(cors({
  origin: '*', // Allow requests from this origin
  methods: ['*'], // Allow only specified methods
  allowedHeaders: ['*'], // Allow only specified headers
  credentials: true // Allow credentials (e.g., cookies)
}));
app.options('*', cors());

// Wix app webhooks (e.g. App installed) and POST /wix/oauth/callback when used as that webhook send a
// signed JWT as the raw body (not JSON). If express.json() runs first, parsing fails. Use text first.
const wixJwtBodyRouter = express.Router();
const wixJwtText = express.text({ type: '*/*', limit: '512kb' });
wixJwtBodyRouter.use(optionalAccountKeyValidator);
wixJwtBodyRouter.post('/wix/webhooks/app-instance-installed', wixJwtText, asyncHandler(handleWixAppInstanceInstalled));
wixJwtBodyRouter.post('/wix/oauth/callback', wixJwtText, asyncHandler(handleWixOAuthCallback));
wixJwtBodyRouter.post('/webhooks/wix/order-create', wixJwtText, asyncHandler(handleWixOrderCreateWebhook));
app.use('/api', wixJwtBodyRouter);

// TikTok Shop's webhook signature is computed over the raw request bytes (HMAC over
// app_key+rawBody), so unlike Wix's JWT webhooks above, it doesn't need its own
// pre-express.json() router — the `verify` hook below stashes the raw bytes on req.rawBody
// before express.json() parses them, so the TikTok webhook route can live in routes.js
// like every other webhook and still verify against the exact bytes TikTok signed.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
const apiRoutes = require('./src/controllers/routes');
const server = http.createServer(app);
app.use('/api', optionalAccountKeyValidator);
app.use('/api', apiRoutes);
app.use(notFoundHandler);
app.use(errorHandler);
app.get('/', (req, res) => {
  res.send('File Management App will run on this port');
})
module.exports = server;
