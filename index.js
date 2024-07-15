
const AWS = require('aws-lambda');
const express = require('express');
const serverless = require('serverless-http');
const app = express();
const cors = require('cors');
require('dotenv').config();
app.use(cors());

// Define a route for GET requests to the root URL
app.get('/', (req, res) => {
    res.send('Hello from Express in Lambda!');
});

// Define a route for POST requests to '/data'
app.post('/data', (req, res) => {
    // Handle the POST request
    res.send('Received POST request');
});

// Define a route for POST requests to '/data'
app.post('/api/uploadimage', (req, res) => {
    // Handle the POST request
    res.send('Received POST request for upload image');
});

// Define a route with route parameters
app.get('/users/:userId', (req, res) => {
    const userId = req.params.userId;
    res.send(`User ID: ${userId}`);
});
// Wrap your Express.js app with serverless-http
const serverlessApp = serverless(app);

// Lambda handler function
exports.handler = async (event, context) => {
    // Pass the event and context to the serverless app
    return await serverlessApp(event, context);
};