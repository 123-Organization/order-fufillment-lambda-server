const AWS = require("aws-sdk");
const debug = require('debug');
const log = debug('app:getCompanyInformation');
const finerworksService = require('../helpers/finerworks-service');
log('get company information api');
exports.getCompanyInformation = async (req, res) => {
  try {
      const reqBody = JSON.parse(JSON.stringify(req.body));
      const getInformation = await finerworksService.GET_INFO(reqBody);
      if (getInformation) {
          res.status(200).json({
              statusCode: 200,
              status: true,
              data: getInformation?.user_account
          });
      }
  } catch (error) {
      console.log("error is", error);
      res.status(400).json({
          statusCode: 400,
          status: false,
          message: JSON.stringify(error),
      });
  }
};