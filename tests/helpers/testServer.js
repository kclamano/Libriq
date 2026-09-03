import http from 'node:http';
import { handleApiRequest } from '../../api/app.js';
import { CatalogStore } from '../../api/catalog.js';

/**
 * Creates an isolated test server instance with its own catalog store.
 * @returns {Promise<{ server: http.Server, url: string, catalog: CatalogStore, close: () => Promise<void> }>}
 */
export async function createTestServer() {
  const catalog = new CatalogStore();
  const server = http.createServer(async (req, res) => {
    const handled = await handleApiRequest(req, res, catalog);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Not Found' } }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    server,
    url,
    catalog,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Clean HTTP request helper for tests.
 * @param {string} baseUrl
 * @param {string} path
 * @param {Object} options
 * @returns {Promise<{ status: number, headers: Headers, body: string, data: any }>}
 */
export async function apiRequest(baseUrl, path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = { ...options.headers };
  let body = options.body;

  if (body && typeof body === 'object' && !(body instanceof Buffer)) {
    headers['content-type'] = headers['content-type'] || 'application/json';
    body = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body,
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    status: response.status,
    headers: response.headers,
    body: text,
    data,
  };
}
