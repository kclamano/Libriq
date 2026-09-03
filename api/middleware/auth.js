import { verifyToken } from '../auth.js';
import { sendError } from '../response.js';

/**
 * Extracts Bearer token from the Authorization header.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function extractBearerToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Middleware enforcing valid authentication.
 * Attaches decoded user claims to req.user.
 * Returns explicit 401 if unauthenticated, expired, or tampered.
 */
export function requireAuth() {
  return async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
      sendError(res, 'UNAUTHORIZED', 'Authentication token required.', 401);
      return false;
    }

    const verification = verifyToken(token);
    if (!verification.valid) {
      const statusCode = 401;
      sendError(res, verification.error || 'UNAUTHORIZED', verification.message || 'Invalid authentication token.', statusCode);
      return false;
    }

    req.user = verification.payload;
    if (next) await next();
    return true;
  };
}

/**
 * Middleware enforcing user role authorization (e.g., 'admin').
 * Requires requireAuth to have run first or runs it automatically.
 * Returns explicit 403 if unauthorized.
 */
export function requireRole(allowedRoles = []) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return async (req, res, next) => {
    if (!req.user) {
      const authMiddleware = requireAuth();
      const authenticated = await authMiddleware(req, res);
      if (!authenticated) return false;
    }

    if (!roles.includes(req.user.role)) {
      sendError(res, 'FORBIDDEN', `Forbidden: requires one of [${roles.join(', ')}] role.`, 403);
      return false;
    }

    if (next) await next();
    return true;
  };
}

/**
 * Middleware enforcing specific permission.
 */
export function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user) {
      const authMiddleware = requireAuth();
      const authenticated = await authMiddleware(req, res);
      if (!authenticated) return false;
    }

    const userPermissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (!userPermissions.includes(permission) && req.user.role !== 'admin') {
      sendError(res, 'FORBIDDEN', `Forbidden: requires "${permission}" permission.`, 403);
      return false;
    }

    if (next) await next();
    return true;
  };
}
