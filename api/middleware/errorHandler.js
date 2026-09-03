import { sendError } from '../response.js';

/**
 * Centralized error handler.
 * @param {Error} err
 * @param {import('node:http').ServerResponse} res
 */
export function handleError(err, res) {
  if (res.headersSent) return;

  const status = err.statusCode || err.status || 500;
  const code = err.code || (status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT' : 'INTERNAL_SERVER_ERROR');
  const message = err.message || 'An internal server error occurred.';
  const details = err.details || null;

  sendError(res, code, message, status, details);
}
