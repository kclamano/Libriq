import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig } from '../api/config.js';

const rootDir = process.cwd();
const configPath = path.join(rootDir, 'frontend', 'js', 'config.js');
const localConfigPath = path.join(rootDir, 'frontend', 'js', 'config.local.js');
const vendorDir = path.join(rootDir, 'frontend', 'vendor');
const packageJson = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
const appVersion = String(packageJson.version || '').trim();
if (!appVersion) throw new Error('package.json version is required.');
await writeFile(
  path.join(rootDir, 'frontend', 'js', 'version.js'),
  `export const APP_VERSION = ${JSON.stringify(appVersion)};\n`,
  'utf8',
);
await writeFile(
  path.join(rootDir, 'frontend', 'js', 'version-classic.js'),
  `self.LIBRIQ_APP_VERSION = ${JSON.stringify(appVersion)};\n`,
  'utf8',
);

await loadLocalEnvFile(path.join(rootDir, '.env'));

const envValidation = validateConfig(process.env);
if (!envValidation.valid) {
  console.warn(`[Libriq] Environment validation warnings:\n  - ${envValidation.errors.join('\n  - ')}`);
}

const envKey = String(process.env.GOOGLE_BOOKS_API_KEY || '').trim();
const firebaseConfig = {
  apiKey: String(process.env.FIREBASE_API_KEY || '').trim(),
  authDomain: String(process.env.FIREBASE_AUTH_DOMAIN || '').trim(),
  projectId: String(process.env.FIREBASE_PROJECT_ID || '').trim(),
  storageBucket: String(process.env.FIREBASE_STORAGE_BUCKET || '').trim(),
  messagingSenderId: String(process.env.FIREBASE_MESSAGING_SENDER_ID || '').trim(),
  appId: String(process.env.FIREBASE_APP_ID || '').trim(),
};

const hasFirebaseConfig = Object.values(firebaseConfig).every(Boolean);
const isVercelBuild = Boolean(String(process.env.VERCEL || process.env.VERCEL_ENV || '').trim());

const configLines = [];
if (envKey) configLines.push(`  googleBooksApiKey: ${JSON.stringify(envKey)}`);
if (hasFirebaseConfig) configLines.push(`  firebase: ${JSON.stringify(firebaseConfig, null, 2).replace(/\n/g, '\n  ')}`);
const contents = `window.LibriqConfig = {\n${configLines.join(',\n')}${configLines.length ? '\n' : ''}};\n`;

await mkdir(vendorDir, { recursive: true });
await copyFile(path.join(rootDir, 'node_modules', 'firebase', 'firebase-app.js'), path.join(vendorDir, 'firebase-app.js'));
const authSource = await readFile(path.join(rootDir, 'node_modules', 'firebase', 'firebase-auth.js'), 'utf8');
await writeFile(path.join(vendorDir, 'firebase-auth.js'), authSource.replace('from"https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js"', 'from"./firebase-app.js"'), 'utf8');
const firestoreSource = await readFile(path.join(rootDir, 'node_modules', 'firebase', 'firebase-firestore.js'), 'utf8');
await writeFile(path.join(vendorDir, 'firebase-firestore.js'), firestoreSource
  .replace('from"https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js"', 'from"./firebase-app.js"')
  .replace('from"https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js"', 'from"./firebase-auth.js"'), 'utf8');

if (isVercelBuild) {
  await writeFile(configPath, contents, 'utf8');
} else {
  await writeFile(localConfigPath, contents, 'utf8');
  if (!await fileExists(configPath)) {
    await writeFile(configPath, 'window.LibriqConfig = {};\n', 'utf8');
  }
}

try {
  const written = await readFile(configPath, 'utf8');
  if (!written.includes('window.LibriqConfig')) {
    throw new Error('Generated config missing LibriqConfig assignment.');
  }
} catch (err) {
  console.error('[Libriq] Failed to verify generated config:', err.message);
  process.exitCode = 1;
  throw err;
}

console.log(`[Libriq] Wrote ${isVercelBuild ? path.relative(rootDir, configPath) : path.relative(rootDir, localConfigPath)}${envKey ? ' with Google Books key' : ' with empty config'}.`);

async function loadLocalEnvFile(envPath) {
  try {
    const raw = await readFile(envPath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) return;

      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) return;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith('\'') && value.endsWith('\''))
      ) {
        value = value.slice(1, -1);
      }

      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r');
      process.env[key] = value;
    });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function fileExists(filePath) {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}
