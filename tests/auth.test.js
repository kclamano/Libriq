import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, verifyToken } from '../api/auth.js';
import { createTestServer, apiRequest } from './helpers/testServer.js';

describe('Authentication & Authorization', () => {
  let testEnv;

  before(async () => {
    testEnv = await createTestServer();
  });

  after(async () => {
    await testEnv.close();
  });

  describe('Token Issuance & Claims', () => {
    it('issues a valid signed token containing expected claims', () => {
      const token = issueToken({
        userId: 'user-123',
        role: 'member',
        permissions: ['read', 'reserve'],
      });

      assert.equal(typeof token, 'string');
      const parts = token.split('.');
      assert.equal(parts.length, 3);

      const verification = verifyToken(token);
      assert.equal(verification.valid, true);
      assert.equal(verification.payload.sub, 'user-123');
      assert.equal(verification.payload.role, 'member');
      assert.deepEqual(verification.payload.permissions, ['read', 'reserve']);
      assert.ok(verification.payload.exp > verification.payload.iat);
    });

    it('issues tokens via the /api/auth/token endpoint', async () => {
      const res = await apiRequest(testEnv.url, '/api/auth/token', {
        method: 'POST',
        body: { userId: 'api-user', role: 'admin' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.token);

      const verified = verifyToken(res.data.data.token);
      assert.equal(verified.valid, true);
      assert.equal(verified.payload.sub, 'api-user');
      assert.equal(verified.payload.role, 'admin');
    });

    it('rejects token issuance without userId', async () => {
      const res = await apiRequest(testEnv.url, '/api/auth/token', {
        method: 'POST',
        body: { role: 'admin' },
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('Token Verification, Expiration & Tamper Resistance', () => {
    it('verifies a valid token via the /api/auth/verify endpoint', async () => {
      const token = issueToken({ userId: 'verify-user' });
      const res = await apiRequest(testEnv.url, '/api/auth/verify', {
        method: 'POST',
        body: { token },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.valid, true);
      assert.equal(res.data.data.payload.sub, 'verify-user');
    });

    it('rejects an expired token with explicit 401', async () => {
      // Token expired 10 seconds ago
      const expiredToken = issueToken({ userId: 'expired-user' }, { expiresIn: -10 });
      const verification = verifyToken(expiredToken);
      assert.equal(verification.valid, false);
      assert.equal(verification.error, 'TOKEN_EXPIRED');

      const res = await apiRequest(testEnv.url, '/api/auth/verify', {
        method: 'POST',
        body: { token: expiredToken },
      });

      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'TOKEN_EXPIRED');
    });

    it('rejects a tampered token payload with explicit 401', async () => {
      const token = issueToken({ userId: 'normal-user', role: 'user' });
      const parts = token.split('.');

      // Tamper with payload: elevate role to 'admin'
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      payload.role = 'admin';
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const verification = verifyToken(tamperedToken);
      assert.equal(verification.valid, false);
      assert.equal(verification.error, 'TOKEN_TAMPERED');

      const res = await apiRequest(testEnv.url, '/api/auth/verify', {
        method: 'POST',
        body: { token: tamperedToken },
      });

      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'TOKEN_TAMPERED');
    });

    it('rejects tokens signed with an invalid secret', () => {
      const wrongSecretToken = issueToken({ userId: 'attacker' }, { secret: 'unauthorized-signing-secret-value!!' });
      const verification = verifyToken(wrongSecretToken);
      assert.equal(verification.valid, false);
      assert.equal(verification.error, 'TOKEN_TAMPERED');
    });
  });

  describe('Route Protection (401 / 403 Response Standards)', () => {
    it('returns explicit 401 when accessing protected route without token', async () => {
      const res = await apiRequest(testEnv.url, '/api/auth/me');

      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'UNAUTHORIZED');
      assert.match(res.data.error.message, /token required/i);
    });

    it('returns explicit 401 when accessing protected route with expired token', async () => {
      const expiredToken = issueToken({ userId: 'user-expired' }, { expiresIn: -30 });
      const res = await apiRequest(testEnv.url, '/api/auth/me', {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });

      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'TOKEN_EXPIRED');
    });

    it('returns explicit 401 when accessing protected route with tampered token', async () => {
      const validToken = issueToken({ userId: 'user-tampered' });
      const tamperedToken = validToken.slice(0, -4) + 'abcd';
      const res = await apiRequest(testEnv.url, '/api/auth/me', {
        headers: { Authorization: `Bearer ${tamperedToken}` },
      });

      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'TOKEN_TAMPERED');
    });

    it('returns explicit 403 when user has insufficient role for privileged route', async () => {
      // Regular user token attempting to create a resource (requires admin or librarian)
      const userToken = issueToken({ userId: 'regular-user', role: 'user' });
      const res = await apiRequest(testEnv.url, '/api/catalog/resources', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
        body: { title: 'Test Book', author: 'Author' },
      });

      assert.equal(res.status, 403);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'FORBIDDEN');
    });

    it('allows access to privileged route when token has admin role', async () => {
      const adminToken = issueToken({ userId: 'admin-user', role: 'admin' });
      const res = await apiRequest(testEnv.url, '/api/catalog/resources', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { title: 'Admin Book', author: 'Authorized Author' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.title, 'Admin Book');
    });
  });
});
