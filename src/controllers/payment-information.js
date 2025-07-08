const braintree = require("braintree");
const debug = require("debug");
const log = debug("app:paymentInformation");
const finerworksService = require("../helpers/finerworks-service");
// const gateway = new braintree.BraintreeGateway({
//     environment: braintree.Environment.Sandbox,
//     merchantId: 'gz4pdd3wyb4m6534',
//     publicKey: 'cybd68b4cqvkkqv3',
//     privateKey: 'c0a5b9010c6c7f80f9aa1be4e18c7986'
// });

// Helper function to handle Braintree errors
const getErrorMessage = (error) => {
  if (error instanceof braintree.errors.AuthenticationError) return "Invalid API credentials.";
  if (error instanceof braintree.errors.AuthorizationError) return "Access denied.";
  if (error instanceof braintree.errors.NotFoundError) return "Resource not found.";
  if (error instanceof braintree.errors.RequestTimeoutError) return "Request timed out.";
  if (error instanceof braintree.errors.ServiceUnavailableError) return "Braintree service is unavailable.";
  if (error instanceof braintree.errors.UpgradeRequiredError) return "Braintree API upgrade required.";
  if (error instanceof braintree.errors.TooManyRequestsError) return "Rate limit exceeded.";
  return "An unknown error occurred.";
};

const environment = process.env.BRAINTREE_ENVIRONMENT === 'Production'
  ? braintree.Environment.Production
  : braintree.Environment.Sandbox;

const gateway = new braintree.BraintreeGateway({
  environment: environment,  // Use the resolved environment directly
  merchantId: process.env.BRAINTREE_MERCHANT_ID,
  publicKey: process.env.BRAINTREE_PUBLIC_KEY,
  privateKey: process.env.BRAINTREE_PRIVATE_KEY,
});

exports.getClientToken = async (req, res) => {
  try {
    gateway.clientToken.generate({}, (err, response) => {
      if (err) {
        res.status(500).send(err);
      } else {
        res.status(200).json({
          statusCode: 200,
          status: true,
          token: response.clientToken,
        });
      }
    });
  } catch (error) {
    console.log("error is", error);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};

exports.processVaultedPaymentToken = async (req, res) => {
  try {
    const { paymentToken, amount, customerId } = req.body;

    // Validate request body
    if (!paymentToken || !amount || !customerId) {
      return res.status(400).json({
        success: false,
        message: "Payment token, customer ID and amount are required.",
      });
    }
    // Ensure amount is a valid number
    if (isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount. It must be a positive number.",
      });
    }
    // Process payment using the vaulted token
    const result = await gateway.transaction.sale({
      amount: amount,
      paymentMethodToken: paymentToken,
      options: { submitForSettlement: true },
    });

    // Handle successful transactions
    if (result.success) {
      return res.status(200).json({
        success: true,
        message: "Transaction successful.",
        transactionId: result.transaction.id,
        status: result.transaction.status,
      });
    }

    // Handle transaction failures
    const errorMessages = result.errors
      .deepErrors()
      .map((error) => error.message);
    return res.status(400).json({
      success: false,
      message: "Transaction failed.",
      errors: errorMessages.length ? errorMessages : result.message,
    });
  } catch (error) {
    log("error is", error);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};

// exports.createCustomer = async (req, res) => {
//   try {
//     const reqBody = JSON.parse(JSON.stringify(req.body));
//     log("requestBody", reqBody);
//     gateway.customer.create(
//       {
//         firstName: reqBody.firstName,
//         lastName: reqBody.lastName,
//         email: reqBody.email,
//         company: reqBody.companyName,
//         phone: reqBody.phone,
//       },
//       async (err, result) => {
//         if (err) {
//           log("Error creating customer:", err);
//           return;
//         }
//         if (result.success) {
//           log("Customer created successfully:", result.customer.id);

//           // get User Details
//           const getInformation = await finerworksService.GET_INFO(reqBody);
//           let payloadForCompanyInformation = {};
//           payloadForCompanyInformation.account_key = reqBody.account_key;
//           payloadForCompanyInformation = getInformation.user_account;
//           payloadForCompanyInformation.payment_profile_id = result.customer.id;
//           log(
//             "payloadForCompanyInformation",
//             JSON.stringify(payloadForCompanyInformation)
//           );
//           const updateData = await finerworksService.UPDATE_INFO(
//             payloadForCompanyInformation
//           );
//           log("check if data updates", JSON.stringify(updateData));
//           log(
//             "Customer Id update in the api:",
//             JSON.stringify(payloadForCompanyInformation)
//           );
//           res.status(200).json({
//             statusCode: 200,
//             status: true,
//             message: "Customer created successfully on brain tree",
//             customerId: result.customer.id,
//           });
//         } else {
//           log("Failed to create customer:", result.message);
//         }
//       }
//     );
//   } catch (error) {
//     log("error is", error);
//     res.status(400).json({
//       statusCode: 400,
//       status: false,
//       message: JSON.stringify(error),
//     });
//   }
// };

exports.createCustomer = async (req, res) => {
  try {
    const reqBody = req.body;  // No need to stringify and parse, req.body is already parsed
    log("requestBody", reqBody);

    // Use await for customer creation
    const result = await new Promise((resolve, reject) => {
      gateway.customer.create(
        {
          firstName: reqBody.firstName,
          lastName: reqBody.lastName,
          email: reqBody.email,
          company: reqBody.companyName,
          phone: reqBody.phone,
        },
        (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        }
      );
    });

    if (result.success) {
      log("Customer created successfully:", result.customer.id);
      console.log("result========>>>",result);

      // Get user details
      const getInformation = await finerworksService.GET_INFO(reqBody);
      let payloadForCompanyInformation = {
        account_key: reqBody.account_key,
        ...getInformation.user_account,
        payment_profile_id: result.customer.id,
      };
      console.log("getInformation=======>>>>>",getInformation);
      log("payloadForCompanyInformation", JSON.stringify(payloadForCompanyInformation));
      console.log("payloadForCompanyInformation=======>>>>>",payloadForCompanyInformation);

      // Update company information
      const updateData = await finerworksService.UPDATE_INFO(payloadForCompanyInformation);
      console.log("updateData=============>>>>>>>>>>>",updateData);
      log("check if data updates", JSON.stringify(updateData));
      log("Customer Id update in the api:", JSON.stringify(payloadForCompanyInformation));

      res.status(200).json({
        statusCode: 200,
        status: true,
        message: "Customer created successfully on brain tree",
        customerId: result.customer.id,
      });
    } else {
      log("Failed to create customer:", result.message);
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: result.message,
      });
    }
  } catch (error) {
    log("Error is", error);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};


exports.addPaymentCard = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    log("requestBody", reqBody);
    gateway.paymentMethod.create(
      {
        paymentMethodNonce: reqBody.nonceFromClient,
        customerId: reqBody.customerId,
      },
      (err, result) => {
        log("result is", result);
        if (err) {
          res.status(400).json({
            statusCode: 400,
            status: true,
            message: err,
          });
        } else if (result.success) {
          log("result success", JSON.stringify(result));
          res.status(200).json({
            statusCode: 200,
            status: true,
            message: "card Added Successfully",
          });
        } else if (result.errors) {
          res.status(400).json({
            statusCode: 400,
            status: true,
            message: result.message,
          });
        }
      }
    );
  } catch (error) {
    log("error is", error);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};

exports.getFullCustomerDetails = async (req, res) => {
  try {
    if (!req.query.customerId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Please provide customer id",
      });
    }
    gateway.customer.find(req.query.customerId, (err, customer) => {
      if (err) {
        res.status(400).json({
          statusCode: 400,
          status: false,
          data: "Invalid customer id",
        });
      }

      if (customer) {
        res.status(200).json({
          statusCode: 200,
          status: true,
          data: customer,
        });
      } else {
        res.status(400).json({
          statusCode: 400,
          status: false,
          data: "Invalid customer id",
        });
      }
    });
  } catch (error) {
    log("error is", error);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};

exports.removePaymentCard = async (req, res) => {
  try {
    const { paymentMethodToken, customerId } = req.body;

    // Validate request body
    if (!paymentMethodToken || !customerId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Payment method token and customer ID are required.",
      });
    }
    const result = await gateway.paymentMethod.delete(paymentMethodToken);
    return  res.status(200).json({
      status: true,
      message: "Successfully Removed Payment Method",
    });

  } catch (error) {
    log("error is", error);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};
