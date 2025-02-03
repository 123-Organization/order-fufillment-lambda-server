const debug = require("debug");
const Joi = require("joi");
const log = debug("app:virtualInventory");
const finerworksService = require("../helpers/finerworks-service");
log("Products");
// # region Add Product
// Define the validation schema
const imageSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().required(),
  file_name: Joi.string().required(),
  file_size: Joi.number().required(),
  thumbnail_file_name: Joi.string().required(),
  preview_file_name: Joi.string().required(),
  hires_file_name: Joi.string().required(),
  public_thumbnail_uri: Joi.string().uri().required(),
  public_preview_uri: Joi.string().uri().required(),
  private_hires_uri: Joi.string().uri().required(),
  pix_w: Joi.number().integer().positive().required(),
  pix_h: Joi.number().integer().positive().required(),
});

const librarySchema = Joi.object({
  name: Joi.string().required(),
  session_id: Joi.string().required(),
  account_key: Joi.string().allow(""),
  site_id: Joi.number().integer().min(0).required(),
});

const requestBodySchema = Joi.object({
  images: Joi.array().items(imageSchema).min(1).required(),
  library: librarySchema.required(),
});
// Middleware for validation
exports.validateAddProduct = async (req, res, next) => {
  const { error, value } = requestBodySchema.validate(req.body);
  if (error) {
    return res.status(400).json({
      statusCode: 400,
      status: false,
      message: error.details[0].message,
    });
  }
  req.body = value;
  next();
};

exports.addProduct = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    const getInformation = await finerworksService.ADD_PRODUCT(reqBody);
    if (
      getInformation &&
      getInformation.status &&
      getInformation.status.success
    ) {
      res.status(200).json({
        statusCode: 200,
        status: true,
        data: getInformation?.images,
      });
    } else {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Something went wrong",
      });
    }
  } catch (error) {
    log("Error while adding a new product : ", error);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};

// # endregion

// # region Get Product Details
exports.getProductDetails = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request",
      });
    } else {
      const getProductDetails = await finerworksService.GET_PRODUCTS_DETAILS(
        reqBody
      );
      if (!getProductDetails?.status) {
        res.status(404).json({
          statusCode: 404,
          status: false,
          message: "Product Details Not Found",
        });
      }
      let totalPrice = 0;
      if (getProductDetails) {
        if (getProductDetails.product_list) {
          getProductDetails.product_list.forEach((product) => {
            totalPrice += product.total_price;
          });
        }
      }
      if (getProductDetails) {
        res.status(200).json({
          statusCode: 200,
          status: true,
          message: "Product Details Found",
          data: getProductDetails,
          totalPrice,
        });
      } else {
        res.status(404).json({
          statusCode: 404,
          status: false,
          message: "Product Details Not Found",
        });
      }
    }
  } catch (err) {
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: err?.response?.data,
    });
  }
};
// # endregion
