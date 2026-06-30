const debug = require("debug");
const finerworksService = require("../helpers/finerworks-service");
const log = debug("app:UserInformation");
log("User Information");


exports.updateUserInformation = async (req, res) => {
    try {
      log("user token payload", JSON.stringify(req?.body));
      const reqBody = JSON.parse(JSON.stringify(req.body));
      log("user token payload",reqBody);

      if (!reqBody) {
        res.status(400).json({
          statusCode: 400,
          status: false,
          message: "Bad Request",
        });
      } else {
        const getUserDetails =
          await finerworksService.UPDATE_INFO(reqBody);
        if (getUserDetails) {
          const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'finerworks',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'updateUserInformation',
            operation: 'User information updated successfully',
            account_key: req.body?.account_key || 'unknown',
            result: { updated: true },
            timestamp: new Date().toISOString()
          });
          console.log(successLog);
          log('Success in updateUserInformation: %s', successLog);
          res.status(200).json({
            statusCode: 200,
            status: true,
            data: getUserDetails,
          });
        } else {
          res.status(404).json({
            statusCode: 404,
            status: false,
            message: "User Details Not Found",
          });
        }
      }
    } catch (err) {
      console.log("error", JSON.stringify(err), err);
      const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
      const errorJson = JSON.stringify({
        level: 'ERROR',
        platform: 'finerworks',
        source: isFinerworksError ? 'finerworks_api' : 'lambda',
        function: 'updateUserInformation',
        account_key: req.body?.account_key || 'unknown',
        httpStatus: err?.response?.status || null,
        message: `Failed to update user information: ${err?.message || 'Unknown error'}`,
        detail: err?.response?.data?.message || err?.response?.data?.error || null,
        timestamp: new Date().toISOString()
      });
      console.error(errorJson);
      log('Formatted error in updateUserInformation: %s', errorJson);
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: err?.response?.data,
      });
    }
  };