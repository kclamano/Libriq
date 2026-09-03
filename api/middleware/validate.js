import { sendError } from '../response.js';
import { loadConfig } from '../config.js';

const config = loadConfig(process.env, false);
const DEFAULT_MAX_BYTES = config.MAX_PAYLOAD_BYTES || 102400;

// Patterns indicating potential SQL injection
const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|UNION|TRUNCATE)\b)/i,
  /(\bOR\b\s+['"\d\w]+\s*=\s*['"\d\w]+)/i,
  /(\bAND\b\s+['"\d\w]+\s*=\s*['"\d\w]+)/i,
  /(--|#|\/\*|\*\/)/,
  /(;\s*(DROP|ALTER|DELETE|UPDATE|INSERT)\b)/i,
];

// Patterns indicating potential NoSQL injection
const NOSQL_INJECTION_PATTERNS = [
  /(\$where|\$regex|\$ne|\$gt|\$gte|\$lt|\$lte|\$in|\$nin|\$expr)/i,
  /(\{\s*"\$(?:where|gt|gte|lt|lte|ne|in|nin|regex)")/i,
];

// Script injection patterns
const SCRIPT_INJECTION_PATTERNS = [
  /<script\b[^>]*>([\s\S]*?)<\/script>/i,
  /javascript:[^"']*/i,
  /on\w+\s*=\s*["'][^"']*["']/i,
];

/**
 * Recursively scans an object, array, or string for injection attacks.
 * @param {any} value
 * @returns {{ detected: boolean, type?: string, pattern?: string }}
 */
export function detectInjection(value) {
  if (value === null || value === undefined) return { detected: false };

  if (typeof value === 'string') {
    // Check SQL injection
    for (const pattern of SQL_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        return { detected: true, type: 'SQL_INJECTION', match: pattern.toString() };
      }
    }
    // Check NoSQL injection
    for (const pattern of NOSQL_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        return { detected: true, type: 'NOSQL_INJECTION', match: pattern.toString() };
      }
    }
    // Check script injection
    for (const pattern of SCRIPT_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        return { detected: true, type: 'SCRIPT_INJECTION', match: pattern.toString() };
      }
    }
    return { detected: false };
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const res = detectInjection(item);
      if (res.detected) return res;
    }
    return { detected: false };
  }

  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // Check for $-prefixed keys (NoSQL operator injection)
      if (k.startsWith('$')) {
        return { detected: true, type: 'NOSQL_KEY_INJECTION', match: k };
      }
      const keyCheck = detectInjection(k);
      if (keyCheck.detected) return keyCheck;

      const valCheck = detectInjection(v);
      if (valCheck.detected) return valCheck;
    }
    return { detected: false };
  }

  return { detected: false };
}

/**
 * Reads and parses request JSON body safely, enforcing size limits and injection prevention.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Object} options
 * @returns {Promise<{ body: any } | false>} Parsed body or false if response sent
 */
export async function parseJsonBody(req, res, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const allowInjections = options.allowInjections || false;

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > maxBytes) {
    sendError(res, 'PAYLOAD_TOO_LARGE', `Payload size exceeds limit of ${maxBytes} bytes.`, 413);
    return false;
  }

  return new Promise((resolve) => {
    let raw = '';
    let bytesReceived = 0;
    let sizeExceeded = false;

    req.on('data', (chunk) => {
      if (sizeExceeded) return;
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        sizeExceeded = true;
        sendError(res, 'PAYLOAD_TOO_LARGE', `Payload size exceeds limit of ${maxBytes} bytes.`, 413);
        resolve(false);
        return;
      }
      raw += chunk;
    });

    req.on('end', () => {
      if (sizeExceeded) return;
      if (!raw.trim()) {
        resolve({ body: {} });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        sendError(res, 'MALFORMED_PAYLOAD', 'Malformed JSON payload: syntax error in request body.', 400, {
          error: err.message,
        });
        resolve(false);
        return;
      }

      if (!allowInjections) {
        const injection = detectInjection(parsed);
        if (injection.detected) {
          sendError(res, 'INJECTION_DETECTED', `Request payload contains potential ${injection.type} patterns.`, 400, {
            type: injection.type,
          });
          resolve(false);
          return;
        }
      }

      resolve({ body: parsed });
    });

    req.on('error', (err) => {
      sendError(res, 'STREAM_ERROR', err.message, 400);
      resolve(false);
    });
  });
}

/**
 * Validates object data against a field specification.
 * @param {Object} data
 * @param {Object} schema Example: { title: { type: 'string', required: true } }
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePayload(data, schema) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Payload must be a non-null JSON object.'] };
  }

  for (const [field, rule] of Object.entries(schema)) {
    const val = data[field];
    if (rule.required && (val === undefined || val === null || val === '')) {
      errors.push(`Field "${field}" is required.`);
      continue;
    }

    if (val !== undefined && val !== null) {
      if (rule.type === 'array') {
        if (!Array.isArray(val)) {
          errors.push(`Field "${field}" must be an array, got ${typeof val}.`);
        }
      } else if (rule.type === 'number') {
        if (typeof val !== 'number' || Number.isNaN(val)) {
          errors.push(`Field "${field}" must be a valid number, got ${typeof val}.`);
        } else if (rule.min !== undefined && val < rule.min) {
          errors.push(`Field "${field}" must be >= ${rule.min}.`);
        }
      } else if (typeof val !== rule.type) {
        errors.push(`Field "${field}" must be of type ${rule.type}, got ${typeof val}.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
