/**
 * Standardized HTTP response helper module.
 * Guarantees uniform response schemas across all endpoints:
 *   Success: { success: true, data: any }
 *   Error:   { success: false, error: { code: string, message: string, details?: any } }
 */

export function createSuccessResponse(data = null) {
  return {
    success: true,
    data,
  };
}

export function createErrorResponse(code, message, details = null) {
  const payload = {
    code: String(code || 'INTERNAL_ERROR'),
    message: String(message || 'An unexpected error occurred.'),
  };
  if (details !== null && details !== undefined) {
    payload.details = details;
  }
  return {
    success: false,
    error: payload,
  };
}

export function sendSuccess(res, data = null, statusCode = 200) {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(createSuccessResponse(data)));
}

export function sendError(res, code, message, statusCode = 400, details = null) {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(createErrorResponse(code, message, details)));
}
