/**
 * Environment configuration and startup validation module.
 * Provides schema validation, fail-fast sanity checks, and type coercion.
 */

export const CONFIG_SCHEMA = {
  PORT: {
    type: 'number',
    default: 4173,
    validate: (val) => Number.isInteger(val) && val > 0 && val <= 65535,
    message: 'PORT must be an integer between 1 and 65535.',
  },
  NODE_ENV: {
    type: 'string',
    default: 'development',
    validate: (val) => ['development', 'production', 'test'].includes(val),
    message: 'NODE_ENV must be one of: development, production, test.',
  },
  AUTH_SECRET: {
    type: 'string',
    default: 'libriq-insecure-dev-secret-key-32-chars-min!!',
    validate: (val, env) => {
      if (env.NODE_ENV === 'production') {
        return typeof val === 'string' && val.length >= 32 && !val.includes('insecure');
      }
      return typeof val === 'string' && val.length >= 16;
    },
    message: 'AUTH_SECRET must be at least 16 characters (32 in production, non-default).',
  },
  MAX_PAYLOAD_BYTES: {
    type: 'number',
    default: 102400, // 100 KB
    validate: (val) => Number.isInteger(val) && val > 0 && val <= 10485760, // up to 10MB max
    message: 'MAX_PAYLOAD_BYTES must be a positive integer <= 10MB.',
  },
  GOOGLE_BOOKS_API_KEY: {
    type: 'string',
    default: '',
    required: false,
    validate: (val) => typeof val === 'string',
    message: 'GOOGLE_BOOKS_API_KEY must be a string.',
  },
};

export function validateConfig(rawEnv = process.env) {
  const errors = [];
  const config = {};

  const currentEnv = rawEnv.NODE_ENV || 'development';

  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const rawVal = rawEnv[key];
    let parsedVal = rawVal;

    if (rawVal === undefined || rawVal === '') {
      if (schema.required) {
        errors.push(`Missing required environment variable: ${key}`);
        continue;
      }
      parsedVal = schema.default;
    } else if (schema.type === 'number') {
      const num = Number(rawVal);
      if (Number.isNaN(num)) {
        errors.push(`Invalid number for ${key}: received "${rawVal}".`);
        continue;
      }
      parsedVal = num;
    }

    if (schema.validate) {
      const isValid = schema.validate(parsedVal, { ...rawEnv, NODE_ENV: currentEnv });
      if (!isValid) {
        errors.push(schema.message || `Validation failed for ${key}.`);
      }
    }

    config[key] = parsedVal;
  }

  return {
    valid: errors.length === 0,
    config,
    errors,
  };
}

export function loadConfig(rawEnv = process.env, failFast = true) {
  const result = validateConfig(rawEnv);
  if (!result.valid && failFast) {
    const message = `Configuration validation failed:\n  - ${result.errors.join('\n  - ')}`;
    const err = new Error(message);
    err.name = 'ConfigValidationError';
    err.errors = result.errors;
    throw err;
  }
  return result.config;
}
