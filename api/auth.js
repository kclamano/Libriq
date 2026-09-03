import crypto from 'node:crypto';
import { loadConfig } from './config.js';

let defaultSecret = null;
function getSecret() {
  if (!defaultSecret) {
    try {
      const cfg = loadConfig(process.env, false);
      defaultSecret = cfg.AUTH_SECRET;
    } catch {
      defaultSecret = 'libriq-insecure-dev-secret-key-32-chars-min!!';
    }
  }
  return defaultSecret;
}

function base64UrlEncode(str) {
  return Buffer.from(str).toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function sign(content, secret) {
  return crypto.createHmac('sha256', secret).update(content).digest('base64url');
}

/**
 * Issues a signed JWT-like token.
 * @param {Object} claims User claims (sub, role, permissions, etc.)
 * @param {Object} options Options like expiresIn (seconds), secret
 * @returns {string} Signed token
 */
export function issueToken(claims = {}, options = {}) {
  const secret = options.secret || getSecret();
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresIn ?? 3600; // default 1 hour in seconds

  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const payload = {
    sub: String(claims.sub || claims.userId || 'anonymous'),
    role: claims.role || 'user',
    permissions: Array.isArray(claims.permissions) ? claims.permissions : [],
    iat: now,
    exp: now + expiresIn,
    ...claims,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(`${encodedHeader}.${encodedPayload}`, secret);

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verifies and decodes a signed token.
 * @param {string} token
 * @param {string} [secret]
 * @returns {{ valid: boolean, payload?: Object, error?: string, message?: string }}
 */
export function verifyToken(token, secret = getSecret()) {
  if (typeof token !== 'string' || !token.trim()) {
    return { valid: false, error: 'TOKEN_MISSING', message: 'Token is missing or not a string.' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'TOKEN_MALFORMED', message: 'Token format is invalid.' };
  }

  const [encodedHeader, encodedPayload, receivedSignature] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return { valid: false, error: 'TOKEN_MALFORMED', message: 'Token encoding or JSON is invalid.' };
  }

  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    return { valid: false, error: 'TOKEN_INVALID_HEADER', message: 'Unsupported algorithm or token type.' };
  }

  const expectedSignature = sign(`${encodedHeader}.${encodedPayload}`, secret);
  const receivedSigBuf = Buffer.from(receivedSignature);
  const expectedSigBuf = Buffer.from(expectedSignature);

  if (receivedSigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(receivedSigBuf, expectedSigBuf)) {
    return { valid: false, error: 'TOKEN_TAMPERED', message: 'Token signature verification failed (tampered).' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && typeof payload.exp === 'number' && payload.exp < now) {
    return { valid: false, error: 'TOKEN_EXPIRED', message: 'Token has expired.' };
  }

  return {
    valid: true,
    payload,
  };
}
