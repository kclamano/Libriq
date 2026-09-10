import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const frontendRoot = path.join(repoRoot, 'frontend');
const docsScreenshotsDir = path.join(repoRoot, 'docs', 'screenshots');

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
      const filePath = urlPath === '/' ? path.join(frontendRoot, 'index.html') : path.join(frontendRoot, urlPath);
      const normalized = path.normalize(filePath);
      if (!normalized.startsWith(frontendRoot)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const stat = await fs.stat(normalized);
      if (stat.isDirectory()) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const ext = path.extname(normalized).toLowerCase();
      const contentType = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.json': 'application/json',
      }[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      const data = await fs.readFile(normalized);
      res.end(data);
    } catch (err) {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function saveScreenshot(page, filename, options = {}) {
  const docsPath = path.join(docsScreenshotsDir, filename);
  await page.screenshot({ path: docsPath, ...options });
  console.log(`Saved screenshot: ${filename}`);
}

async function main() {
  await fs.mkdir(docsScreenshotsDir, { recursive: true });

  const { server, url } = await startServer();
  console.log(`Server started at ${url}`);

  const browser = await chromium.launch({ headless: true });

  try {
    // 1. Pre-Auth Landing Page with Live Book Search Demo (Desktop)
    console.log('Capturing 1: Landing Page Desktop with Live Demo...');
    const desktopContext = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      colorScheme: 'dark',
    });
    const landingPage = await desktopContext.newPage();
    await landingPage.goto(url, { waitUntil: 'networkidle' });

    // Click "Dune" demo tag to trigger live search
    const duneTag = landingPage.locator('.session-demo-tag[data-query="Dune"]');
    if (await duneTag.isVisible()) {
      await duneTag.click();
      try {
        await landingPage.waitForSelector('#sessionDemoResults:not([hidden]) .session-demo-book-card', { timeout: 6000 });
      } catch (e) {
        console.log('Demo results wait completed');
      }
    }
    await landingPage.waitForTimeout(600);
    await saveScreenshot(landingPage, 'landing-desktop-demo.png');
    await desktopContext.close();

    // 2. In-App Social Browser Landing Page (Mobile)
    console.log('Capturing 2: In-App Browser Mobile Notice...');
    const inAppContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 289.0.0.24.59',
      colorScheme: 'dark',
    });
    const inAppPage = await inAppContext.newPage();
    await inAppPage.goto(url, { waitUntil: 'networkidle' });
    await inAppPage.waitForTimeout(600);
    await saveScreenshot(inAppPage, 'landing-inapp-mobile.png');
    await inAppContext.close();

    // 3. New User Onboarding Checklist (Desktop Dashboard)
    console.log('Capturing 3: Onboarding Checklist Desktop Dashboard...');
    const newReaderContext = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      colorScheme: 'dark',
    });
    await newReaderContext.addInitScript(() => {
      localStorage.setItem('libriq_installed', '2026-07-02T00:00:00.000Z');
      localStorage.setItem('libriq_session_pref', 'offline');
      sessionStorage.setItem('libriq_session_mode', 'offline');
      localStorage.setItem('libriq_preferred_session_mode', 'offline');
      localStorage.setItem('libriq_books', '[]');
      localStorage.setItem('libriq_seen_version', '4.7.0');
      localStorage.removeItem('libriq_onboarding_dismissed');
    });
    const onboardingPage = await newReaderContext.newPage();
    await onboardingPage.goto(url, { waitUntil: 'networkidle' });
    await onboardingPage.evaluate(() => Navigation.goTo('dashboard'));
    await onboardingPage.waitForSelector('.onboarding-checklist', { timeout: 8000 });
    await onboardingPage.waitForTimeout(600);
    await saveScreenshot(onboardingPage, 'onboarding-checklist-desktop.png');
    await newReaderContext.close();

    // 3b. Dashboard with 3D Reading Hero & Ambient Glow
    console.log('Capturing 3b: Dashboard with 3D Reading Hero...');
    const activeReaderContext = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      colorScheme: 'dark',
    });
    await activeReaderContext.addInitScript(() => {
      localStorage.setItem('libriq_installed', '2026-07-02T00:00:00.000Z');
      localStorage.setItem('libriq_session_pref', 'offline');
      sessionStorage.setItem('libriq_session_mode', 'offline');
      localStorage.setItem('libriq_preferred_session_mode', 'offline');
      localStorage.setItem('libriq_seen_version', '4.7.0');
      localStorage.setItem('libriq_streak', JSON.stringify({ current: 14, longest: 21, lastRead: new Date().toISOString() }));
      localStorage.setItem('libriq_books', JSON.stringify([
        {
          id: 'reading-dune',
          title: 'Dune',
          author: 'Frank Herbert',
          coverUrl: 'https://covers.openlibrary.org/b/id/8231432-L.jpg',
          pageCount: 688,
          currentPage: 342,
          status: 'reading',
          genre: 'Science Fiction',
          quote: 'I must not fear. Fear is the mind-killer. Fear is the little-death that brings total obliteration.',
          dateStarted: '2026-06-01T08:00:00.000Z',
          dateAdded: '2026-05-28T08:00:00.000Z',
          isFavorite: true,
        },
        {
          id: 'finished-hail-mary',
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          coverUrl: 'https://covers.openlibrary.org/b/id/10522431-L.jpg',
          pageCount: 496,
          currentPage: 496,
          status: 'finished',
          genre: 'Sci-Fi',
          rating: 5,
          dateFinished: '2026-05-20T08:00:00.000Z',
        },
      ]));
    });
    const activeDashboardPage = await activeReaderContext.newPage();
    await activeDashboardPage.goto(url, { waitUntil: 'networkidle' });
    await activeDashboardPage.evaluate(() => Navigation.goTo('dashboard'));
    await activeDashboardPage.waitForSelector('.dashboard-hero-card', { timeout: 8000 });
    await activeDashboardPage.waitForTimeout(600);
    await saveScreenshot(activeDashboardPage, 'dashboard-with-book-3d.png');

    // 3c. Library Grid with 3D Hardcover perspective
    console.log('Capturing 3c: Library Grid with 3D Hardcover Treatment...');
    await activeDashboardPage.evaluate(() => Navigation.goTo('library'));
    await activeDashboardPage.waitForSelector('#libraryPage .book-card', { timeout: 8000 });
    await activeDashboardPage.waitForTimeout(600);
    await saveScreenshot(activeDashboardPage, 'library-shelves-3d.png');
    await activeReaderContext.close();

    // 4. Mobile Bottom Navigation Bar (Mobile Dashboard)
    console.log('Capturing 4: Mobile Bottom Navigation Bar...');
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
      isMobile: true,
      hasTouch: true,
    });
    await mobileContext.addInitScript(() => {
      localStorage.setItem('libriq_installed', '2026-07-02T00:00:00.000Z');
      localStorage.setItem('libriq_session_pref', 'offline');
      sessionStorage.setItem('libriq_session_mode', 'offline');
      localStorage.setItem('libriq_preferred_session_mode', 'offline');
      localStorage.setItem('libriq_books', '[]');
      localStorage.setItem('libriq_seen_version', '4.7.0');
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(url, { waitUntil: 'networkidle' });
    await mobilePage.evaluate(() => Navigation.goTo('dashboard'));
    await mobilePage.waitForSelector('#mobileBottomNav');
    await mobilePage.waitForTimeout(600);
    await saveScreenshot(mobilePage, 'mobile-bottom-nav.png');
    await mobileContext.close();

    // 5. Test User Login Account Authentication
    console.log('Capturing 5: Account Login Verification...');
    const authContext = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      colorScheme: 'dark',
    });
    const authPage = await authContext.newPage();
    await authPage.goto(url, { waitUntil: 'networkidle' });

    const emailInput = authPage.locator('#sessionEmailInput');
    const passwordInput = authPage.locator('#sessionPasswordInput');
    const submitBtn = authPage.locator('#emailAuthSubmit');

    const testEmail = process.env.LIBRIQ_TEST_EMAIL || 'test@example.com';
    const testPassword = process.env.LIBRIQ_TEST_PASSWORD || 'samplepass123';

    if (await emailInput.isVisible() && await passwordInput.isVisible()) {
      await emailInput.fill(testEmail);
      await passwordInput.fill(testPassword);
      await authPage.waitForTimeout(300);
      await saveScreenshot(authPage, 'auth-form-filled.png');

      await submitBtn.click();
      console.log('Submitted login credentials, waiting for navigation or auth result...');
      try {
        await authPage.waitForFunction(() => {
          return !document.body.classList.contains('session-choice-active') || !!document.getElementById('sessionAuthError:not([hidden])');
        }, { timeout: 8000 });
      } catch (e) {
        console.log('Login wait finished:', e.message);
      }
      await authPage.waitForTimeout(1500);
      await saveScreenshot(authPage, 'auth-result-dashboard.png');
    }
    await authContext.close();

    console.log('All screenshots successfully captured!');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  console.error('Screenshot script error:', err);
  process.exitCode = 1;
});
