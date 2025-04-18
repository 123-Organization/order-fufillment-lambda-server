const createEvent = require('../helpers/create-event');
const finerworksService = require('../helpers/finerworks-service');
const debug = require('debug');
const log = debug('app:updateCompanyInformation');
log('Update company information');
const Joi = require('joi');

/**
 * Updates the company information.
 * 
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves when the company information is updated.
 * @throws {Error} - If there is an error updating the company information.
 */
exports.updateCompanyInformation = async (req, res) => {
  try {
      const reqBody = JSON.parse(JSON.stringify(req.body));
      let payloadForCompanyInformation = {};
      if (!reqBody.account_key) {
          res.status(400).json({
              statusCode: 400,
              status: false,
              message: 'Account key is required',
          });
          return;
      }

      payloadForCompanyInformation.account_key = reqBody.account_key;

      if (reqBody.business_info) {
          /** check for the validations for the customer_info */
          payloadForCompanyInformation.business_info = reqBody.business_info
          
      }

      if (reqBody.billing_info) {
          /** check for the validations for the billing_info */
          payloadForCompanyInformation.billing_info = reqBody.billing_info;
      }
      if(reqBody.shipping_preferences){
        payloadForCompanyInformation.shipping_preferences = reqBody.shipping_preferences;
      }
      /** Check for connections */
      if(reqBody.connections){
        payloadForCompanyInformation.connections = reqBody.connections;
      }

      if(reqBody.logo_url){
        payloadForCompanyInformation.logo_url = reqBody.logo_url;
      }

      const updateInformation = await finerworksService.UPDATE_INFO(payloadForCompanyInformation);
      if(!updateInformation?.status){
        res.status(400).json({
          statusCode: 400,
          status: false,
          message: updateInformation.message,
        });
      }
      if (updateInformation) {
          res.status(200).json({
              statusCode: 200,
              status: true,
              message: "company information has been updated successfully",
              data: updateInformation?.user_account 
          });
      }
  } catch (error) {
    res.status(400).json({
          statusCode: 400,
          status: false,
          message: error.response.data,
      });
  }
};