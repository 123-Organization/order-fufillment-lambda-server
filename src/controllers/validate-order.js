const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:validateOrderPayload");
log("Validate order");
exports.validateOrderPayload = async (orders) => {
    try {
      let isValid = false;
      log('Request comes to validate order', JSON.stringify(orders));
      if (orders?.length) {
        const payloadToBeSubmitted = {
          orders,
          payment_token: "xxxx",
          validate_only: true,
        };
        const orderValidated = await finerworksService.SUBMIT_ORDERS(
          payloadToBeSubmitted
        );
        log('orderValidated', JSON.stringify(orderValidated));
        if (orderValidated) {
            isValid =  true;
        } 
      }
      return isValid;
    } catch (err) {
        console.log("errorMessage", JSON.stringify(err), err);
     }
};