// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import { generateUuid } from "./util/utils";
import { Serializer, Mapper } from "./serializer";
import { OperationSpec } from "./msRest";
export type HttpMethods = "GET" | "PUT" | "POST" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "TRACE";

export interface CancellationTokenLike {
  setCancellationListener(listener: () => void): void;
  cancel(): void;
}

/**
 * Creates a new WebResource object.
 *
 * This class provides an abstraction over a REST call by being library / implementation agnostic and wrapping the necessary
 * properties to initiate a request.
 *
 * @constructor
 */
export class WebResource {
  url: string;
  method: HttpMethods;
  body?: any;
  headers: { [key: string]: any; } = {};
  rawResponse?: boolean;
  formData?: any;
  query?: { [key: string]: any; };
  operationSpec?: OperationSpec;

  cancellationToken?: CancellationTokenLike;

  constructor(url?: string, method?: HttpMethods, body?: any, query?: { [key: string]: any; }, headers: { [key: string]: any; } = {}, rawResponse = false, cancellationToken?: CancellationTokenLike) {
    this.rawResponse = rawResponse;
    this.url = url || "";
    this.method = method || "GET";
    this.headers = headers || {};
    this.body = body;
    this.query = query;
    this.formData = undefined;
    this.cancellationToken = cancellationToken;
  }

  /**
   * Validates that the required properties such as method, url, headers["Content-Type"],
   * headers["accept-language"] are defined. It will throw an error if one of the above
   * mentioned properties are not defined.
   */
  validateRequestProperties(): void {
    if (!this.method) {
      throw new Error("method is a required property for making a request.");
    }
    if (!this.url) {
      throw new Error("url is a required property for making a request.");
    }
    if (!this.headers["Content-Type"]) {
      throw new Error("'Content-Type' is a required header for making a request.");
    }
    // if (!this.headers["accept-language"]) {
    //   throw new Error("'accept-language' is a required header for making a request.");
    // }
  }

  /**
   * Prepares the request.
   * @param {RequestPrepareOptions} options - Options to provide for preparing the request.
   * @returns {object} WebResource Returns the prepared WebResource (HTTP Request) object that needs to be given to the request pipeline.
   */
  prepare(options: RequestPrepareOptions) {
    if (options === null || options === undefined || typeof options !== "object") {
      throw new Error("options cannot be null or undefined and must be of type object");
    }

    if (options.method === null || options.method === undefined || typeof options.method.valueOf() !== "string") {
      throw new Error("options.method cannot be null or undefined and it must be of type string.");
    }

    if (options.url && options.pathTemplate) {
      throw new Error("options.url and options.pathTemplate are mutually exclusive. Please provide either of them.");
    }


    if ((options.pathTemplate === null || options.pathTemplate === undefined || typeof options.pathTemplate.valueOf() !== "string") && (options.url === null || options.url === undefined || typeof options.url.valueOf() !== "string")) {
      throw new Error("Please provide either options.pathTemplate or options.url. Currently none of them were provided.");
    }

    // set the url if it is provided.
    if (options.url) {
      if (typeof options.url !== "string") {
        throw new Error("options.url must be of type \"string\".");
      }
      this.url = options.url;
    }

    // set the method
    if (options.method) {
      const validMethods = ["GET", "PUT", "HEAD", "DELETE", "OPTIONS", "POST", "PATCH", "TRACE"];
      if (validMethods.indexOf(options.method.toUpperCase()) === -1) {
        throw new Error("The provided method \"" + options.method + "\" is invalid. Supported HTTP methods are: " + JSON.stringify(validMethods));
      }
    }
    this.method = (options.method.toUpperCase() as HttpMethods);

    // construct the url if path template is provided
    if (options.pathTemplate) {
      if (typeof options.pathTemplate !== "string") {
        throw new Error("options.pathTemplate must be of type \"string\".");
      }
      if (!options.baseUrl) {
        options.baseUrl = "https://management.azure.com";
      }
      const baseUrl = options.baseUrl;
      let url = baseUrl + (baseUrl.endsWith("/") ? "" : "/") + (options.pathTemplate.startsWith("/") ? options.pathTemplate.slice(1) : options.pathTemplate);
      const segments = url.match(/({\w*\s*\w*})/ig);
      if (segments && segments.length) {
        if (options.pathParameters === null || options.pathParameters === undefined || typeof options.pathParameters !== "object") {
          throw new Error(`pathTemplate: ${options.pathTemplate} has been provided. Hence, options.pathParameters ` +
            `cannot be null or undefined and must be of type "object".`);
        }
        segments.forEach(function (item) {
          const pathParamName = item.slice(1, -1);
          const pathParam = (options.pathParameters as { [key: string]: any })[pathParamName];
          if (pathParam === null || pathParam === undefined || !(typeof pathParam === "string" || typeof pathParam === "object")) {
            throw new Error(`pathTemplate: ${options.pathTemplate} contains the path parameter ${pathParamName}` +
              ` however, it is not present in ${options.pathParameters} - ${JSON.stringify(options.pathParameters, undefined, 2)}.` +
              `The value of the path parameter can either be a "string" of the form { ${pathParamName}: "some sample value" } or ` +
              `it can be an "object" of the form { "${pathParamName}": { value: "some sample value", skipUrlEncoding: true } }.`);
          }

          if (typeof pathParam.valueOf() === "string") {
            url = url.replace(item, encodeURIComponent(pathParam));
          }

          if (typeof pathParam.valueOf() === "object") {
            if (!pathParam.value) {
              throw new Error(`options.pathParameters[${pathParamName}] is of type "object" but it does not contain a "value" property.`);
            }
            if (pathParam.skipUrlEncoding) {
              url = url.replace(item, pathParam.value);
            } else {
              url = url.replace(item, encodeURIComponent(pathParam.value));
            }
          }
        });
      }
      this.url = url;
    }

    // append query parameters to the url if they are provided. They can be provided with pathTemplate or url option.
    if (options.queryParameters) {
      if (typeof options.queryParameters !== "object") {
        throw new Error(`options.queryParameters must be of type object. It should be a JSON object ` +
          `of "query-parameter-name" as the key and the "query-parameter-value" as the value. ` +
          `The "query-parameter-value" may be fo type "string" or an "object" of the form { value: "query-parameter-value", skipUrlEncoding: true }.`);
      }
      // append question mark if it is not present in the url
      if (this.url && this.url.indexOf("?") === -1) {
        this.url += "?";
      }
      // construct queryString
      const queryParams = [];
      const queryParameters = options.queryParameters;
      // We need to populate this.query as a dictionary if the request is being used for Sway's validateRequest().
      this.query = {};
      for (const queryParamName in queryParameters) {
        const queryParam: any = queryParameters[queryParamName];
        if (queryParam) {
          if (typeof queryParam === "string") {
            queryParams.push(queryParamName + "=" + encodeURIComponent(queryParam));
            this.query[queryParamName] = encodeURIComponent(queryParam);
          }
          else if (typeof queryParam === "object") {
            if (!queryParam.value) {
              throw new Error(`options.queryParameters[${queryParamName}] is of type "object" but it does not contain a "value" property.`);
            }
            if (queryParam.skipUrlEncoding) {
              queryParams.push(queryParamName + "=" + queryParam.value);
              this.query[queryParamName] = queryParam.value;
            } else {
              queryParams.push(queryParamName + "=" + encodeURIComponent(queryParam.value));
              this.query[queryParamName] = encodeURIComponent(queryParam.value);
            }
          }
        }
      }// end-of-for
      // append the queryString
      this.url += queryParams.join("&");
    }

    // add headers to the request if they are provided
    if (options.headers) {
      const headers = options.headers;
      for (const headerName in headers) {
        if (headers.hasOwnProperty(headerName)) {
          this.headers[headerName] = headers[headerName];
        }
      }
    }
    // ensure accept-language is set correctly
    if (!this.headers["accept-language"]) {
      this.headers["accept-language"] = "en-US";
    }
    // ensure the request-id is set correctly
    if (!this.headers["x-ms-client-request-id"] && !options.disableClientRequestId) {
      this.headers["x-ms-client-request-id"] = generateUuid();
    }

    // default
    if (!this.headers["Content-Type"]) {
      this.headers["Content-Type"] = "application/json; charset=utf-8";
    }

    // set the request body. request.js automatically sets the Content-Length request header, so we need not set it explicilty
    this.body = options.body;
    if (options.body != undefined) {
      // body as a stream special case. set the body as-is and check for some special request headers specific to sending a stream.
      if (options.bodyIsStream) {
        if (!this.headers["Transfer-Encoding"]) {
          this.headers["Transfer-Encoding"] = "chunked";
        }
        if (this.headers["Content-Type"] !== "application/octet-stream") {
          this.headers["Content-Type"] = "application/octet-stream";
        }
      } else {
        if (options.serializationMapper) {
          this.body = new Serializer(options.mappers).serialize(options.serializationMapper, options.body, "requestBody");
        }
        if (!options.disableJsonStringifyOnBody) {
          this.body = JSON.stringify(options.body);
        }
      }
    }

    this.cancellationToken = options.cancellationToken;

    return this;
  }
}

/**
 * Prepares the request.
 * @param {object} options The request options that should be provided to send a request successfully
 * @param {string} options.method The HTTP request method. Valid values are "GET", "PUT", "HEAD", "DELETE", "OPTIONS", "POST", "PATCH".
 * @param {string} [options.url] The request url. It may or may not have query parameters in it.
 * Either provide the "url" or provide the "pathTemplate" in the options object. Both the options are mutually exclusive.
 * @param {object} [options.queryParameters] A dictionary of query parameters to be appended to the url, where
 * the "key" is the "query-parameter-name" and the "value" is the "query-parameter-value".
 * The "query-parameter-value" can be of type "string" or it can be of type "object".
 * The "object" format should be used when you want to skip url encoding. While using the object format,
 * the object must have a property named value which provides the "query-parameter-value".
 * Example:
 *    - query-parameter-value in "object" format: { "query-parameter-name": { value: "query-parameter-value", skipUrlEncoding: true } }
 *    - query-parameter-value in "string" format: { "query-parameter-name": "query-parameter-value"}.
 * Note: "If options.url already has some query parameters, then the value provided in options.queryParameters will be appended to the url.
 * @param {string} [options.pathTemplate] The path template of the request url. Either provide the "url" or provide the "pathTemplate"
 * in the options object. Both the options are mutually exclusive.
 * Example: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{accountName}"
 * @param {string} [options.baseUrl] The base url of the request. Default value is: "https://management.azure.com". This is applicable only with
 * options.pathTemplate. If you are providing options.url then it is expected that you provide the complete url.
 * @param {object} [options.pathParameters] A dictionary of path parameters that need to be replaced with actual values in the pathTemplate.
 * Here the key is the "path-parameter-name" and the value is the "path-parameter-value".
 * The "path-parameter-value" can be of type "string"  or it can be of type "object".
 * The "object" format should be used when you want to skip url encoding. While using the object format,
 * the object must have a property named value which provides the "path-parameter-value".
 * Example:
 *    - path-parameter-value in "object" format: { "path-parameter-name": { value: "path-parameter-value", skipUrlEncoding: true } }
 *    - path-parameter-value in "string" format: { "path-parameter-name": "path-parameter-value" }.
 * @param {object} [options.headers] A dictionary of request headers that need to be applied to the request.
 * Here the key is the "header-name" and the value is the "header-value". The header-value MUST be of type string.
 *  - ContentType must be provided with the key name as "Content-Type". Default value "application/json; charset=utf-8".
 *  - "Transfer-Encoding" is set to "chunked" by default if "options.bodyIsStream" is set to true.
 *  - "Content-Type" is set to "application/octet-stream" by default if "options.bodyIsStream" is set to true.
 *  - "accept-language" by default is set to "en-US"
 *  - "x-ms-client-request-id" by default is set to a new Guid. To not generate a guid for the request, please set options.disableClientRequestId to true
 * @param {boolean} [options.disableClientRequestId] When set to true, instructs the client to not set "x-ms-client-request-id" header to a new Guid().
 * @param {object|string|boolean|array|number|null|undefined} [options.body] - The request body. It can be of any type. This method will JSON.stringify() the request body.
 * @param {object} [options.serializationMapper] - Provides information on how to serialize the request body.
 * @param {object} [options.mappers] - A dictionary of mappers that may be used while [de]serialization.
 * @param {object} [options.deserializationMapper] - Provides information on how to deserialize the response body.
 * @param {boolean} [options.disableJsonStringifyOnBody] - Indicates whether this method should JSON.stringify() the request body. Default value: false.
 * @param {boolean} [options.bodyIsStream] - Indicates whether the request body is a stream (useful for file upload scenarios).
 * @returns {object} WebResource Returns the prepared WebResource (HTTP Request) object that needs to be given to the request pipeline.
 */
export interface RequestPrepareOptions {
  method: HttpMethods;
  url?: string;
  queryParameters?: { [key: string]: any | ParameterValue };
  pathTemplate?: string;
  baseUrl?: string;
  pathParameters?: { [key: string]: any | ParameterValue };
  formData?: { [key: string]: any };
  headers?: { [key: string]: any };
  disableClientRequestId?: boolean;
  body?: any;
  serializationMapper?: Mapper;
  mappers?: { [x: string]: any };
  deserializationMapper?: object;
  disableJsonStringifyOnBody?: boolean;
  bodyIsStream?: boolean;
  cancellationToken: CancellationTokenLike;
}

/**
 * The Parameter value provided for path or query parameters in RequestPrepareOptions
 */
export interface ParameterValue {
  value: any;
  skipUrlEncoding: boolean;
  [key: string]: any;
}

/**
 * Describes the base structure of the options object that will be used in every operation.
 */
export interface RequestOptionsBase {
  /**
   * @property {object} [customHeaders] - User defined custom request headers that
   * will be applied before the request is sent.
   */
  customHeaders?: { [key: string]: string };
  [key: string]: any;
}