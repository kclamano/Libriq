# LibriQ Agent Guidelines & Product Invariants

## 1. Authentication Invariants
- **Mandatory Authentication**: LibriQ requires user accounts. Never implement or propose "guest mode", "try without account", or anonymous access that bypasses account creation.
- **Conversion Strategy**: To demonstrate product value prior to signup, use pre-auth interactive discovery showcases (e.g., live book search queryable without auth) with contextual CTAs to save to an account.
- **In-App Social Webviews**: Embedded browsers (Instagram, TikTok, Reddit) block Google OAuth. Always detect `sessionContext.isInAppBrowser` and default to email sign-up while providing an "Open in Safari / Chrome" escape hatch.

## 2. UI / UX Standards
- **Contrast Ratios**: Maintain WCAG AA compliance (minimum 4.5:1 for normal text).
- **Navigation Ergonomics**: Keep sidebar items organized by logical hubs (Library, Insights, Discover, Account). On mobile devices (`<768px`), utilize the sticky bottom navigation bar with thumb-friendly touch targets.
- **Visual Verification**: For any UI or responsive layout changes, capture headless browser screenshots and embed them in `walkthrough.md`.

## 3. Automated Testing & Regressions
- Before completing frontend tasks, run `npm test` and all modular scripts (`scripts/test-*-modules.mjs`).
- Preserve badge element IDs (`badge-library`, `badge-reading`, etc.) to maintain contract compatibility with test suites.
- Never commit user credentials or personal credentials in test scripts or artifacts.
