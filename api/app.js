import url from 'node:url';
import { issueToken, verifyToken } from './auth.js';
import { defaultCatalog, CatalogError } from './catalog.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { parseJsonBody, validatePayload } from './middleware/validate.js';
import { handleError } from './middleware/errorHandler.js';
import { sendSuccess, sendError } from './response.js';

/**
 * Dispatches API requests with standardized responses, validation, and auth.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./catalog.js').CatalogStore} [catalog]
 * @returns {Promise<boolean>} True if route was handled, false if not an API route
 */
export async function handleApiRequest(req, res, catalog = defaultCatalog) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (!pathname.startsWith('/api/')) {
    return false;
  }

  try {
    // --- Auth Routes ---
    if (pathname === '/api/auth/token' && req.method === 'POST') {
      const parsedBody = await parseJsonBody(req, res);
      if (parsedBody === false) return true;

      const body = parsedBody.body;
      const validation = validatePayload(body, {
        userId: { type: 'string', required: true },
      });
      if (!validation.valid) {
        sendError(res, 'VALIDATION_ERROR', 'Validation failed.', 400, validation.errors);
        return true;
      }

      const token = issueToken({
        userId: body.userId,
        role: body.role || 'user',
        permissions: body.permissions || [],
      }, {
        expiresIn: body.expiresIn,
      });

      sendSuccess(res, { token, expiresIn: body.expiresIn || 3600 });
      return true;
    }

    if (pathname === '/api/auth/verify' && req.method === 'POST') {
      const parsedBody = await parseJsonBody(req, res);
      if (parsedBody === false) return true;

      const { token } = parsedBody.body;
      if (!token) {
        sendError(res, 'TOKEN_MISSING', 'Token is required for verification.', 400);
        return true;
      }

      const result = verifyToken(token);
      if (!result.valid) {
        sendError(res, result.error, result.message, 401);
        return true;
      }

      sendSuccess(res, { valid: true, payload: result.payload });
      return true;
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const authPassed = await requireAuth()(req, res);
      if (!authPassed) return true;

      sendSuccess(res, { user: req.user });
      return true;
    }

    // --- Catalog Routes ---
    // POST /api/catalog/resources (Create)
    if (pathname === '/api/catalog/resources' && req.method === 'POST') {
      const authPassed = await requireAuth()(req, res);
      if (!authPassed) return true;

      const rolePassed = await requireRole(['admin', 'librarian'])(req, res);
      if (!rolePassed) return true;

      const parsedBody = await parseJsonBody(req, res);
      if (parsedBody === false) return true;

      const validation = validatePayload(parsedBody.body, {
        title: { type: 'string', required: true },
        author: { type: 'string', required: true },
        totalCopies: { type: 'number', required: false, min: 1 },
      });
      if (!validation.valid) {
        sendError(res, 'VALIDATION_ERROR', 'Validation failed.', 400, validation.errors);
        return true;
      }

      const resource = catalog.createResource(parsedBody.body);
      sendSuccess(res, resource, 201);
      return true;
    }

    // GET /api/catalog/resources (List)
    if (pathname === '/api/catalog/resources' && req.method === 'GET') {
      const includeDeleted = parsed.query.includeDeleted === 'true';
      const status = parsed.query.status || null;
      const search = parsed.query.search || '';
      const list = catalog.listResources({ includeDeleted, status, search });
      sendSuccess(res, list);
      return true;
    }

    // Single resource operations
    const resourceMatch = pathname.match(/^\/api\/catalog\/resources\/([^/]+)(\/(reserve|checkout|return|reconcile))?$/);
    if (resourceMatch) {
      const resourceId = resourceMatch[1];
      const action = resourceMatch[3];

      // GET /api/catalog/resources/:id
      if (!action && req.method === 'GET') {
        const includeDeleted = parsed.query.includeDeleted === 'true';
        const resource = catalog.getResource(resourceId, { includeDeleted });
        if (!resource) {
          sendError(res, 'NOT_FOUND', `Resource ${resourceId} not found.`, 404);
          return true;
        }
        sendSuccess(res, resource);
        return true;
      }

      // PATCH /api/catalog/resources/:id
      if (!action && req.method === 'PATCH') {
        const authPassed = await requireAuth()(req, res);
        if (!authPassed) return true;

        const rolePassed = await requireRole(['admin', 'librarian'])(req, res);
        if (!rolePassed) return true;

        const parsedBody = await parseJsonBody(req, res);
        if (parsedBody === false) return true;

        const updated = catalog.updateResource(resourceId, parsedBody.body);
        sendSuccess(res, updated);
        return true;
      }

      // DELETE /api/catalog/resources/:id
      if (!action && req.method === 'DELETE') {
        const authPassed = await requireAuth()(req, res);
        if (!authPassed) return true;

        const rolePassed = await requireRole(['admin'])(req, res);
        if (!rolePassed) return true;

        const isHard = parsed.query.hard === 'true';
        if (isHard) {
          catalog.hardDeleteResource(resourceId);
          sendSuccess(res, { id: resourceId, deleted: true, hard: true });
        } else {
          const softDeleted = catalog.softDeleteResource(resourceId);
          sendSuccess(res, softDeleted);
        }
        return true;
      }

      // POST /api/catalog/resources/:id/reserve
      if (action === 'reserve' && req.method === 'POST') {
        const authPassed = await requireAuth()(req, res);
        if (!authPassed) return true;

        const userId = req.user.sub || req.user.userId;
        const resource = catalog.reserveResource(resourceId, userId);
        sendSuccess(res, resource);
        return true;
      }

      // POST /api/catalog/resources/:id/checkout
      if (action === 'checkout' && req.method === 'POST') {
        const authPassed = await requireAuth()(req, res);
        if (!authPassed) return true;

        const userId = req.user.sub || req.user.userId;
        const resource = catalog.checkoutResource(resourceId, userId);
        sendSuccess(res, resource);
        return true;
      }

      // POST /api/catalog/resources/:id/return
      if (action === 'return' && req.method === 'POST') {
        const authPassed = await requireAuth()(req, res);
        if (!authPassed) return true;

        const userId = req.user.sub || req.user.userId;
        const resource = catalog.returnResource(resourceId, userId);
        sendSuccess(res, resource);
        return true;
      }

      // GET /api/catalog/resources/:id/reconcile
      if (action === 'reconcile' && req.method === 'GET') {
        const reconciliation = catalog.reconcileInventory(resourceId);
        sendSuccess(res, reconciliation);
        return true;
      }
    }

    sendError(res, 'NOT_FOUND', `Route ${req.method} ${pathname} not found.`, 404);
    return true;
  } catch (err) {
    if (err instanceof CatalogError) {
      sendError(res, err.code, err.message, err.statusCode, err.details);
      return true;
    }
    handleError(err, res);
    return true;
  }
}
