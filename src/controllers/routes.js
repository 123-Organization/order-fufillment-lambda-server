const { Router } = require('express');
const { updateCompanyInformation } = require('./update-company-information');
const { getCompanyInformation } = require('./get-company-information');
const app = Router();
app.put('/update-company-information',updateCompanyInformation);
app.get('/get-info', getCompanyInformation);
module.exports = app;