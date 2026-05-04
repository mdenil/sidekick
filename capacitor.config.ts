import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the Sidekick native shell.
 *
 * The PWA is served by the Node `server.ts` from the repo root over Tailscale.
 * Rather than bundling the web assets into the native app, we point Capacitor's
 * WKWebView / Android WebView at the live URL via `server.url`. This keeps the
 * native shell's update story identical to the PWA: bump the SW version + refresh.
 *
 * Layout (v0.421 — relocated under mobile/):
 *   mobile/ios/      — Xcode project (was top-level ios/)
 *   mobile/android/  — Gradle project (was top-level android/)
 *   mobile/webdir/   — placeholder bundled webDir (was top-level capacitor-webdir/)
 * The capacitor.config.ts itself stays at repo root because the Capacitor
 * CLI looks for it there with no override.
 *
 * `webDir` has to point at *something* on disk for `cap sync` and the initial
 * offline fallback; the whole repo root (node_modules, server source, etc.) into
 * the iOS/Android bundle is wasteful and would defeat the live-reload setup.
 */
const config: CapacitorConfig = {
  appId: 'com.reimaginerobotics.sidekick',
  appName: 'Sidekick',
  webDir: 'mobile/webdir',
  ios: { path: 'mobile/ios' },
  android: { path: 'mobile/android' },
  server: {
    url: 'https://blueberry.REDACTED-TAILNET.ts.net:3001',
    cleartext: false,
    allowNavigation: ['blueberry.REDACTED-TAILNET.ts.net'],
  },
};

export default config;
