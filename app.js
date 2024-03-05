const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();
const http = require('http');
app.use(cors({
    origin: '*', // Allow requests from this origin
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], // Allow only specified methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Allow only specified headers
    credentials: true // Allow credentials (e.g., cookies)
}));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({extended: true}));
const apiRoutes = require('./src/controllers/routes');
const server = http.createServer(app);
app.use('/api', apiRoutes);
app.get('/', (req, res) => {
    res.send('OrderFullfillment App will run on this port');
});
// const port = 5000;
// server.listen(port, () => {
//     log(`start application on port ${port}`)
//     console.log(`Example app listening on port ${port}`);
// });
module.exports = server;