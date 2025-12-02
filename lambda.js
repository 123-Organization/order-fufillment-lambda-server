const server = require('./app');
const serverless = require('serverless-http');
const serverlessApp = serverless(server);
const debug = require('debug');
const log = debug('app:local');
const http = require('http');
log('Starting');
// Lambda handler function
exports.handler = async (event, context) => {
    // If invoked by a CloudWatch/EventBridge schedule, simulate an HTTP GET
    // request to the /api/health-check endpoint so the same Express route runs.
    if (event && event.source === 'aws.events') {
        const healthCheckEvent = {
            httpMethod: 'GET',
            path: '/api/health-check',
            headers: {},
            queryStringParameters: null,
            pathParameters: null,
            body: null,
            isBase64Encoded: false,
        };
        return await serverlessApp(healthCheckEvent, context);
    }

    // Default behavior for API Gateway / HTTP events
    return await serverlessApp(event, context);
};
// const port = 9001;
// server.listen(port, () => {
//     log(`start application on port ${port}`)
//     console.log(`Example app listening on port ${port}`);
// });