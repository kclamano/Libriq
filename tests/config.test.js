import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, loadConfig } from '../api/config.js';

describe('Environment Variable Validation & Startup Configuration', () => {
  it('validates a clean, valid environment configuration', () => {
    const validEnv = {
      PORT: '5000',
      NODE_ENV: 'test',
      AUTH_SECRET: 'a-very-long-secret-with-more-than-32-chars!!',
      MAX_PAYLOAD_BYTES: '204800',
      GOOGLE_BOOKS_API_KEY: 'test-api-key',
    };

    const result = validateConfig(validEnv);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.config.PORT, 5000);
    assert.equal(result.config.NODE_ENV, 'test');
    assert.equal(result.config.MAX_PAYLOAD_BYTES, 204800);
    assert.equal(result.config.GOOGLE_BOOKS_API_KEY, 'test-api-key');
  });

  it('supplies safe defaults when optional variables are omitted', () => {
    const minimalEnv = {};
    const result = validateConfig(minimalEnv);

    assert.equal(result.valid, true);
    assert.equal(result.config.PORT, 4173);
    assert.equal(result.config.NODE_ENV, 'development');
    assert.equal(result.config.MAX_PAYLOAD_BYTES, 102400);
    assert.ok(result.config.AUTH_SECRET);
  });

  it('rejects invalid PORT configuration', () => {
    const invalidPortEnv = { PORT: 'not-a-port' };
    const result = validateConfig(invalidPortEnv);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('PORT')));
  });

  it('rejects invalid NODE_ENV values', () => {
    const invalidEnv = { NODE_ENV: 'staging-unknown' };
    const result = validateConfig(invalidEnv);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('NODE_ENV')));
  });

  it('rejects insecure/short AUTH_SECRET in production mode', () => {
    const productionWithWeakSecret = {
      NODE_ENV: 'production',
      AUTH_SECRET: 'libriq-insecure-dev-secret-key-32-chars-min!!', // contains 'insecure'
    };
    const result = validateConfig(productionWithWeakSecret);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('AUTH_SECRET')));
  });

  it('loadConfig throws ConfigValidationError in fail-fast mode when invalid', () => {
    const invalidEnv = { PORT: '-10' };
    assert.throws(() => {
      loadConfig(invalidEnv, true);
    }, (err) => {
      return err.name === 'ConfigValidationError' && err.errors.length > 0;
    });
  });
});
