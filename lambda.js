const server = require('./app');
const serverless = require('serverless-http');
const serverlessApp = serverless(server);
const debug = require('debug');
const log = debug('app:local');
const http = require('http');
log('Starting');
// Lambda handler function
// exports.handler = async (event, context) => {
//     // Pass the event and context to the serverless app
//     return await serverlessApp(event, context);
// };
const port = 9001;
server.listen(port, () => {
    log(`start application on port ${port}`)
    console.log(`Example app listening on port ${port}`);
});