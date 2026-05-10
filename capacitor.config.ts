import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the Sidekick native shell.
 *
 * Loading model (changed 2026-05-10):
 *   The Cap WebView no longer loads a fixed `server.url`. Instead the
 *   app boots from the bundled `mobile/webdir/index.html` (a tiny
 *   self-contained "Server URL" landing page) which prompts the user
 *   for their proxy host on first launch and remembers it in
 *   localStorage. On subsequent launches the bootstrap auto-redirects
 *   to the saved URL via `location.href = url`.
 *
 *   This makes the same .ipa installable by anyone — they enter their
 *   own backend URL (the one they got from `hermes-agent-workflow`
 *   bringup) without rebuilding. The dev-iteration workflow is
 *   preserved: any URL the user picks fetches its JS over the network,
 *   so updates ship via `git push` + sidekick.service restart on the
 *   proxy host + dev-reload in the app, exactly as before.
 *
 *   To re-pick the URL later, navigate the WebView to
 *   `capacitor://localhost/?config=1` (the `?config=1` query forces
 *   the bootstrap to show the form even when a URL is saved). A
 *   settings-side affordance is on the way.
 *
 * `allowNavigation: ['*']` permits the bootstrap-initiated redirect
 * to whatever HTTPS host the user picks. The user's URL choice is
 * the security gate; we don't whitelist a fixed host any more.
 *
 * Layout:
 *   mobile/ios/      — Xcode project
 *   mobile/android/  — Gradle project
 *   mobile/webdir/   — bundled bootstrap (loaded on launch)
 * The capacitor.config.ts itself stays at repo root because the
 * Capacitor CLI looks for it there with no override.
 */

const config: CapacitorConfig = {
  appId: 'com.reimaginerobotics.sidekick',
  appName: 'Sidekick',
  webDir: 'mobile/webdir',
  ios: { path: 'mobile/ios' },
  android: { path: 'mobile/android' },
  server: {
    cleartext: false,
    allowNavigation: ['*'],
  },
};

export default config;
