import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the Sidekick native shell.
 *
 * The PWA is served by the Node `server.ts` over the network (e.g. Tailscale,
 * tunnel, LAN). Rather than bundling the web assets into the native app, we
 * point Capacitor's WKWebView / Android WebView at the live URL via
 * `server.url`. The native shell's update story stays identical to the PWA:
 * bump the SW version + refresh.
 *
 * SET YOUR SERVER URL: export `SIDEKICK_NATIVE_URL` to the HTTPS URL where
 * `server.ts` is reachable from the device, then run `npx cap sync`. Example:
 *   export SIDEKICK_NATIVE_URL=https://my-pi.tailnet.ts.net:3001
 * Without it, the native shell falls back to localhost (works for the iOS
 * simulator on the same machine but not for a phone).
 *
 * Layout (v0.421 — relocated under mobile/):
 *   mobile/ios/      — Xcode project
 *   mobile/android/  — Gradle project
 *   mobile/webdir/   — placeholder bundled webDir
 * The capacitor.config.ts itself stays at repo root because the Capacitor
 * CLI looks for it there with no override.
 */
const NATIVE_URL = process.env.SIDEKICK_NATIVE_URL || 'https://localhost:3001';
const NATIVE_HOST = new URL(NATIVE_URL).hostname;

const config: CapacitorConfig = {
  appId: 'com.reimaginerobotics.sidekick',
  appName: 'Sidekick',
  webDir: 'mobile/webdir',
  ios: { path: 'mobile/ios' },
  android: { path: 'mobile/android' },
  server: {
    url: NATIVE_URL,
    cleartext: false,
    allowNavigation: [NATIVE_HOST],
  },
};

export default config;
