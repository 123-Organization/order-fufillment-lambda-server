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

// Helper function to handle Braintree errors. Might be used later for more detailed error handling.
// const getErrorMessage = (error) => {
//   if (error instanceof braintree.errors.AuthenticationError) return "Invalid API credentials.";
//   if (error instanceof braintree.errors.AuthorizationError) return "Access denied.";
//   if (error instanceof braintree.errors.NotFoundError) return "Resource not found.";
//   if (error instanceof braintree.errors.RequestTimeoutError) return "Request timed out.";
//   if (error instanceof braintree.errors.ServiceUnavailableError) return "Braintree service is unavailable.";
//   if (error instanceof braintree.errors.UpgradeRequiredError) return "Braintree API upgrade required.";
//   if (error instanceof braintree.errors.TooManyRequestsError) return "Rate limit exceeded.";
//   return "An unknown error occurred.";
// };

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
        const isBraintreeError = true; // braintree gateway callback error
        const errorJson = JSON.stringify({
          level: 'ERROR',
          platform: 'braintree',
          source: 'braintree_api',
          function: 'getClientToken',
          account_key: req.body?.account_key || req.query?.account_key || 'unknown',
          httpStatus: null,
          message: `Failed to generate Braintree client token: ${err?.message || 'Unknown error'}`,
          detail: null,
          timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in getClientToken: %s', errorJson);
        res.status(500).send(err);
      } else {
        const successLog = JSON.stringify({
          level: 'INFO',
          platform: 'braintree',
          method: req.method,
          api: req.originalUrl || req.url,
          function: 'getClientToken',
          operation: 'Braintree client token generated successfully',
          account_key: req.body?.account_key || req.query?.account_key || 'unknown',
          result: { hasToken: !!response.clientToken },
          timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in getClientToken: %s', successLog);
        res.status(200).json({
          statusCode: 200,
          status: true,
          token: response.clientToken,
        });
      }
    });
  } catch (error) {
    console.log("error is", error);
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'braintree',
      source: 'braintree_api',
      function: 'getClientToken',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: error?.response?.status || null,
      message: `Failed to generate Braintree client token: ${error?.message || 'Unknown error'}`,
      detail: null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getClientToken: %s', errorJson);
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
      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'braintree',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'processVaultedPaymentToken',
        operation: 'Vaulted payment transaction completed successfully',
        account_key: req.body?.account_key || req.query?.account_key || 'unknown',
        result: { transactionId: result.transaction.id, status: result.transaction.status },
        timestamp: new Date().toISOString()
      });
      console.log(successLog);
      log('Success in processVaultedPaymentToken: %s', successLog);
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
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'braintree',
      source: 'braintree_api',
      function: 'processVaultedPaymentToken',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: error?.response?.status || null,
      message: `Failed to process vaulted payment token: ${error?.message || 'Unknown error'}`,
      detail: null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in processVaultedPaymentToken: %s', errorJson);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};

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
      console.log("result========>>>", result);

      // Get user details
      const getInformation = await finerworksService.GET_INFO(reqBody);
      // let payloadForCompanyInformation = {
      //   account_key: reqBody.account_key,
      //   ...getInformation.user_account,
      //   payment_profile_id: result.customer.id,
      // };
      const payloadForCompanyInformation = {
        account_key: reqBody.account_key,
        payment_profile_id: result.customer.id,
      };

      // Conditionally add business_info
      if (hasAnyValue(getInformation.user_account.business_info)) {
        payloadForCompanyInformation.business_info = getInformation.user_account.business_info;
      }

      // Conditionally add billing_info
      if (hasAnyValue(getInformation.user_account.billing_info)) {
        payloadForCompanyInformation.billing_info = getInformation.user_account.billing_info;
      }
      console.log("getInformation=======>>>>>",getInformation);
      log("payloadForCompanyInformation", JSON.stringify(payloadForCompanyInformation));
      console.log("payloadForCompanyInformation=======>>>>>",payloadForCompanyInformation);

      // Update company information
      const updateData = await finerworksService.UPDATE_INFO(payloadForCompanyInformation);
      console.log("updateData=============>>>>>>>>>>>",updateData);
      log("check if data updates", JSON.stringify(updateData));
      log("Customer Id update in the api:", JSON.stringify(payloadForCompanyInformation));

      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'braintree',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'createCustomer',
        operation: 'Braintree customer created successfully',
        account_key: req.body?.account_key || 'unknown',
        result: { customerId: result.customer.id },
        timestamp: new Date().toISOString()
      });
      console.log(successLog);
      log('Success in createCustomer: %s', successLog);
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
    const isFinerworksError = error?.response?.config?.url?.includes('finerworks.com') || error?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'braintree',
      source: isFinerworksError ? 'finerworks_api' : 'braintree_api',
      function: 'createCustomer',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: error?.response?.status || null,
      message: `Failed to create Braintree customer: ${error?.message || 'Unknown error'}`,
      detail: error?.response?.data?.message || error?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in createCustomer: %s', errorJson);
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
          const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'braintree',
            source: 'braintree_api',
            function: 'addPaymentCard',
            account_key: req.body?.account_key || 'unknown',
            httpStatus: null,
            message: `Failed to add payment card: ${err?.message || 'Unknown error'}`,
            detail: null,
            timestamp: new Date().toISOString()
          });
          console.error(errorJson);
          log('Formatted error in addPaymentCard: %s', errorJson);
          res.status(400).json({
            statusCode: 400,
            status: true,
            message: err,
          });
        } else if (result.success) {
          log("result success", JSON.stringify(result));
          const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'braintree',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'addPaymentCard',
            operation: 'Payment card added successfully',
            account_key: req.body?.account_key || 'unknown',
            result: { added: true },
            timestamp: new Date().toISOString()
          });
          console.log(successLog);
          log('Success in addPaymentCard: %s', successLog);
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
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'braintree',
      source: 'braintree_api',
      function: 'addPaymentCard',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: error?.response?.status || null,
      message: `Failed to add payment card: ${error?.message || 'Unknown error'}`,
      detail: null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in addPaymentCard: %s', errorJson);
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
        const successLog = JSON.stringify({
          level: 'INFO',
          platform: 'braintree',
          method: req.method,
          api: req.originalUrl || req.url,
          function: 'getFullCustomerDetails',
          operation: 'Braintree customer details fetched successfully',
          account_key: req.body?.account_key || req.query?.account_key || 'unknown',
          result: { customerId: req.query.customerId },
          timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in getFullCustomerDetails: %s', successLog);
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
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'braintree',
      source: 'braintree_api',
      function: 'getFullCustomerDetails',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: error?.response?.status || null,
      message: `Failed to fetch customer details: ${error?.message || 'Unknown error'}`,
      detail: null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getFullCustomerDetails: %s', errorJson);
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
    await gateway.paymentMethod.delete(paymentMethodToken);
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'braintree',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'removePaymentCard',
      operation: 'Payment card removed successfully',
      account_key: req.body?.account_key || 'unknown',
      result: { removed: true },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in removePaymentCard: %s', successLog);
    return  res.status(200).json({
      status: true,
      message: "Successfully Removed Payment Method",
    });

  } catch (error) {
    log("error is", error);
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'braintree',
      source: 'braintree_api',
      function: 'removePaymentCard',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: error?.response?.status || null,
      message: `Failed to remove payment card: ${error?.message || 'Unknown error'}`,
      detail: null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in removePaymentCard: %s', errorJson);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};


const hasAnyValue = (obj) => {
  return obj && Object.values(obj).some(
    (value) => value !== null && value !== undefined && value !== ''
  );
};