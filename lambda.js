const server = require('./app');
const serverless = require('serverless-http');
const serverlessApp = serverless(server);
const debug = require('debug');
const log = debug('app:local');
const { runSquarespaceTokenRenewalJob } = require('./src/controllers/squarespace-auth');

/**
 * EventBridge (scheduled rule), EventBridge Scheduler, or explicit payload from Scheduler.
 * For Scheduler targets with a custom JSON input, set e.g. {"squarespaceTokenRenewal": true}.
 */
function isScheduledSquarespaceRenewal(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.squarespaceTokenRenewal === true) return true;
    if (event.source === 'aws.events') return true;
    if (event.source === 'aws.scheduler') return true;
    if (event['detail-type'] === 'Scheduled Event') return true;
    return false;
}

// Lambda handler function
exports.handler = async (event, context) => {
    if (isScheduledSquarespaceRenewal(event)) {
        const summary = await runSquarespaceTokenRenewalJob();
        return {
            statusCode: 200,
            body: JSON.stringify({ ok: true, summary })
        };
    }

    return await serverlessApp(event, context);
};
// const port = 9001;
// server.listen(port, () => {
//     log(`start application on port ${port}`)
//     console.log(`Example app listening on port ${port}`);
// });