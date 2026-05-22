const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { handleWixAppInstanceInstalled } = require('./src/controllers/wix-webhooks');
const { handleWixOAuthCallback } = require('./src/controllers/wix-auth');
const { handleWixOrderCreateWebhook } = require('./src/controllers/wix-order-create-webhook');

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
wixJwtBodyRouter.post('/wix/webhooks/app-instance-installed', wixJwtText, handleWixAppInstanceInstalled);
wixJwtBodyRouter.post('/wix/oauth/callback', wixJwtText, handleWixOAuthCallback);
wixJwtBodyRouter.post('/webhooks/wix/order-create', wixJwtText, handleWixOrderCreateWebhook);
app.use('/api', wixJwtBodyRouter);

app.use(express.json());
app.use(express.urlencoded({extended: true}));
const apiRoutes = require('./src/controllers/routes');
const server = http.createServer(app);
app.use('/api', apiRoutes);
const debug = require('debug');
const log = debug('app:appIndex');
app.get('/', (req, res) => {
    res.send('File Management App will run on this port');
  });
// const port = 5001;
// server.listen(port, () => {
//     log(`start application on port ${port}`)
//     console.log(`Example app listening on port ${port}`);
// });
module.exports = server;