const server = require('./app');
const serverless = require('serverless-http');
const serverlessApp = serverless(server);
// const debug = require('debug');
// const log = debug('app:local');
const { runSquarespaceTokenRenewalJob } = require('./src/controllers/squarespace-auth');
const { runSquareTokenRenewalJob } = require('./src/controllers/square-auth');

/** Square's schedule always sends this explicit flag, so it never collides with the Squarespace job below. */
function isScheduledSquareRenewal(event) {
    if (!event || typeof event !== 'object') return false;
    return event.squareTokenRenewal === true;
}

/**
 * EventBridge (scheduled rule), EventBridge Scheduler, or explicit payload from Scheduler.
 * For Scheduler targets with a custom JSON input, set e.g. {"squarespaceTokenRenewal": true}.
 */
function isScheduledSquarespaceRenewal(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.squarespaceTokenRenewal === true) return true;
    if (event.squareTokenRenewal === true) return false;
    if (event.source === 'aws.events') return true;
    if (event.source === 'aws.scheduler') return true;
    if (event['detail-type'] === 'Scheduled Event') return true;
    return false;
}

// Lambda handler function
exports.handler = async (event, context) => {
    if (isScheduledSquareRenewal(event)) {
        const summary = await runSquareTokenRenewalJob();
        return {
            statusCode: 200,
            body: JSON.stringify({ ok: true, summary })
        };
    }

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
//     console.log(`OFA listening on port ${port}`);
// });