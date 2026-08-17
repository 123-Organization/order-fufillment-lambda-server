const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const {
  handleWixAppInstanceInstalled,
  handleWixProductDeletedWebhook,
  handleWixProductCreatedWebhook,
  handleWixProductChangedWebhook,
} = require('./src/controllers/wix-webhooks');
const { handleWixOAuthCallback } = require('./src/controllers/wix-auth');
const { handleWixOrderCreateWebhook } = require('./src/controllers/wix-order-create-webhook');
const { squareCatalogWebhook } = require('./src/controllers/platform-order-sync');
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
wixJwtBodyRouter.post('/webhooks/wix/product-delete', wixJwtText, asyncHandler(handleWixProductDeletedWebhook));
wixJwtBodyRouter.post('/webhooks/wix/product-create', wixJwtText, asyncHandler(handleWixProductCreatedWebhook));
wixJwtBodyRouter.post('/webhooks/wix/product-update', wixJwtText, asyncHandler(handleWixProductChangedWebhook));
app.use('/api', wixJwtBodyRouter);

// Square catalog webhook needs the raw request body to verify x-square-hmacsha256-signature
// (HMAC over notificationUrl + rawBody) — capture it via express.json's verify hook before the
// global parser below would otherwise consume the stream without keeping the raw bytes.
const squareWebhookRouter = express.Router();
const squareJsonWithRawBody = express.json({
  type: '*/*',
  limit: '512kb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
});
squareWebhookRouter.post('/webhooks/square/catalog', squareJsonWithRawBody, asyncHandler(squareCatalogWebhook));
app.use('/api', squareWebhookRouter);

app.use(express.json());
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
