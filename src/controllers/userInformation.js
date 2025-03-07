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
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: err?.response?.data,
      });
    }
  };  