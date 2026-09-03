import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { handleApiRequest } from '../api/app.js';

const root = path.resolve(process.cwd(), 'frontend');
const port = Number(process.env.LIBRIQ_E2E_PORT || 4173);
const store = new Map();
const subscribers = new Map();
const sockets = new Set();

function sendJson(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function collectionKey(pathValue) {
  return String(pathValue || '');
}

function getCollection(pathValue) {
  return store.get(collectionKey(pathValue)) || new Map();
}

function publish(pathValue) {
  const payload = [...getCollection(pathValue).values()];
  for (const res of subscribers.get(collectionKey(pathValue)) || []) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (pathname.startsWith('/api/')) {
    const handled = await handleApiRequest(req, res);
    if (handled) return;
  }

  if (pathname.startsWith('/__libriq_test_api')) {
    if (pathname === '/__libriq_test_api/reset' && req.method === 'POST') {
      store.clear();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/__libriq_test_api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/__libriq_test_api/doc') {
      const pathValue = parsed.query.path;
      const segments = String(pathValue || '').split('/');
      const id = segments.pop();
      const collectionPath = segments.join('/');
      const collection = getCollection(collectionPath);

      if (req.method === 'GET') {
        sendJson(res, 200, collection.get(id) || null);
        return;
      }
      if (req.method === 'DELETE') {
        collection.delete(id);
        store.set(collectionPath, collection);
        publish(collectionPath);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'PUT') {
        let body;
        try {
          body = await new Promise((resolve, reject) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
              try {
                resolve(JSON.parse(raw || '{}'));
              } catch (parseErr) {
                reject(parseErr);
              }
            });
            req.on('error', reject);
          });
        } catch (parseErr) {
          sendJson(res, 400, { error: 'Invalid JSON payload', details: parseErr.message });
          return;
        }
        collection.set(id, body.data);
        store.set(collectionPath, collection);
        publish(collectionPath);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (pathname === '/__libriq_test_api/collection' && req.method === 'GET') {
      sendJson(res, 200, [...getCollection(parsed.query.path).values()]);
      return;
    }

    if (pathname === '/__libriq_test_api/subscribe' && req.method === 'GET') {
      const key = collectionKey(parsed.query.path);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const list = subscribers.get(key) || new Set();
      list.add(res);
      subscribers.set(key, list);
      res.write(`data: ${JSON.stringify([...getCollection(key).values()])}\n\n`);
      req.on('close', () => {
        list.delete(res);
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
    return;
  }

  let filePath = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, filePath);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`LibriQ E2E server running at http://127.0.0.1:${port}`);
});

server.on('connection', socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const responses of subscribers.values()) {
    for (const response of responses) response.end();
  }
  subscribers.clear();
  server.close(() => process.exit(0));
  setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    process.exit(0);
  }, 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
