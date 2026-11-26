'use strict';
// An error that carries an HTTP status code; the API turns it into the response status.
class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

module.exports = { ApiError };
