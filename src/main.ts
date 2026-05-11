/**
 * @fileoverview SideKick — main entry point. Wires all modules together.
 * No logic lives here — just imports + initialization + cross-module callbacks.
 */

import { loadConfig, getConfig, gwWsUrl, getAgentLabel, getAppName, applySkinning } from './config.ts';
import { log, diag, setDebugElement } from './util/log.ts';
import { mountDevPill, isDevMode } from './util/devMode.ts';
import {
  waitForSwActivation,
  initPassiveUpdateDetector,
  installForceUpdateConsoleHook,
} from './swLifecycle.ts';
import { handleNotification, handleUserMessage } from './backendEvents.ts';
import { fetchWithTimeout, TimeoutError } from './util/fetchWithTimeout.ts';
import * as status from './status.ts';
import * as settings from './settings.ts';
import * as headphones from './audio/shared/headphones.ts';
import * as vadRouting from './audio/shared/vadRouting.ts';
import * as theme from './theme.ts';
import * as wakeLock from './wakeLock.ts';
import * as chat from './chat.ts';
import * as renderedMessages from './renderedMessages.ts';
import * as backend from './backend.ts';
import * as conversations from './conversations.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as cmdkPalette from './cmdkPalette.ts';
import { attachSliderTouchAll } from './sliderTouch.ts';
import * as sidebarResize from './sidebarResize.ts';
import * as sidebarSwipe from './sidebarSwipe.ts';
import * as clickFreezeDiag from './clickFreezeDiag.ts';
import * as remoteControl from './remoteControl.ts';
import * as multiSelect from './multiSelect.ts';
import * as agentSettingsMod from './agentSettings.ts';
import { primeAudio, getSharedAudioCtx } from './audio/shared/platform.ts';
import { playReplyTts, cancelReplyTts } from './audio/turn-based/tts.ts';
import * as ttsModule from './audio/turn-based/tts.ts';
import * as replyNavigator from './audio/turn-based/replyNavigator.ts';
import * as replyPlayer from './audio/turn-based/replyPlayer.ts';
import * as audioSession from './audio/shared/session.ts';
import * as capture from './audio/shared/capture.ts';
import * as fakeLock from './ios/fakeLock.ts';
import { setMicPeakListener } from './audio/shared/micMeter.ts';
import { attachCard } from './cards/attach.ts';
import { registerCard } from './cards/registry.ts';
import { parseCardsFromText, extractImageBlocks } from './cards/fallback.ts';
import { miniMarkdown } from './util/markdown.ts';
import * as ambient from './ambient.ts';
import { playFeedback } from './audio/shared/feedback.ts';
import * as memo from './audio/shared/memo.ts';
import * as turnbased from './audio/turn-based/turnbased.ts';
import * as handsfree from './audio/shared/handsfree.ts';
import * as queue from './queue.ts';
import * as voiceMemos from './voiceMemos.ts';
import * as memoCard from './memoCard.ts';
import * as attachments from './attachments.ts';
import * as draft from './draft.ts';
import * as composer from './composer.ts';
import * as slashCommands from './slashCommands.ts';
import * as webrtcControls from './audio/realtime/controls.ts';
import * as webrtcConnection from './audio/realtime/realtime.ts';
import * as webrtcDictation from './audio/realtime/dictation.ts';
import * as webrtcDictate from './audio/realtime/dictate.ts';
import * as browserDictate from './audio/streaming/browserDictate.ts';
import * as webrtcSuppress from './audio/realtime/suppress.ts';
import * as bgTrace from './bgTrace.ts';
import * as activityRow from './activityRow.ts';

// Card kind modules
import imageCard from './cards/kinds/image.ts';
import youtubeCard from './cards/kinds/youtube.ts';
import spotifyCard from './cards/kinds/spotify.ts';
import linksCard from './cards/kinds/links.ts';
import markdownCard from './cards/kinds/markdown.ts';
import loadingCard from './cards/kinds/loading.ts';

// ─── State ──────────────────────────────────────────────────────────────────

/** Matches NO_REPLY and variants the agent sometimes emits when deciding not to reply. */
const NO_REPLY_RE = /^\s*NO[-_]?(?:REPL(?:Y)?)?\.?\s*$/i;

/** Re-render memo cards from IndexedDB into the transcript. Idempotent — render skips existing. */
async function restoreMemoCards() {
  try {
    const transcriptEl = document.getElementById('transcript');
    if (!transcriptEl) return;
    const memos = await voiceMemos.getAll();
    for (const rec of memos) memoCard.render(transcriptEl, rec);
    if (memos.length) {
      log('restored', memos.length, 'memo card(s) from IndexedDB');
      chat.forceScrollToBottom();
    }
  } catch (e) { log('memo restore failed:', e.message); }
}

let memoActive = false;  // true while voice-memo recording bar is shown

// releaseCaptureIfActive is defined as a closure inside boot() so it can
// close the WebRTC peer connection cleanly when slash-commands or other
// reset paths fire.
let releaseCaptureIfActive: () => void = () => {};

/** Remove DOM elements whose `data-platform` attribute doesn't
 *  match the current runtime. Single source of truth for platform-
 *  specific UI gating. Replaces ad-hoc CSS class gates that
 *  specificity wars could leak through.
 *
 *  Supported values (single-value only for now — multi-value
 *  semantics deferred until a real second case justifies the
 *  parser; see the design discussion 2026-05-10 for context):
 *    - 'cap'      → only when running inside Cap WKWebView
 *    - 'pwa'      → only when NOT in Cap (Safari standalone, Chrome, …)
 *    - 'desktop'  → hover + fine pointer (mouse-having devices)
 *    - 'mobile'   → not-desktop
 *
 *  Removed via el.remove() rather than display:none so they can't
 *  tab-focus, fire events, or be announced by AT. Platform is
 *  fixed at boot — no toggle needed. */
function applyPlatformGates(): void {
  const isCap = document.documentElement.classList.contains('capacitor-app');
  const isDesktop = typeof window !== 'undefined'
    && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;
  document.querySelectorAll<HTMLElement>('[data-platform]').forEach(el => {
    const want = el.dataset.platform || '';
    let visible = true;
    if (want === 'cap')          visible = isCap;
    else if (want === 'pwa')     visible = !isCap;
    else if (want === 'desktop') visible = isDesktop;
    else if (want === 'mobile')  visible = !isDesktop;
    if (!visible) el.remove();
  });
}

/** Format a hotkey combo string ("Cmd+Shift+C") for tooltip display
 *  ("⌘⇧C"). Same convention used in the static HTML title attributes
 *  in index.html (e.g. `Send · ⏎`). Lower-cases input first so user-
 *  entered casing variations ("CMD+SHIFT+c", "cmd+Shift+C") all
 *  normalize the same way. Single-character keys uppercased; named
 *  keys (Enter, Escape, etc) left as-is. */
function formatHotkey(combo: string): string {
  if (!combo) return '';
  const parts = combo.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  let out = '';
  let key = '';
  for (const p of parts) {
    if (p === 'cmd' || p === 'meta') out += '⌘';
    else if (p === 'ctrl') out += '⌃';
    else if (p === 'alt' || p === 'option') out += '⌥';
    else if (p === 'shift') out += '⇧';
    else key = p;
  }
  if (!key) return out;
  if (key === 'enter') return out + '⏎';
  if (key === 'escape' || key === 'esc') return out + '⎋';
  if (key === 'space') return out + '␣';
  if (key === 'tab') return out + '⇥';
  // Single-character keys: uppercase. Multi-char (F1, ArrowUp): leave as-is.
  return out + (key.length === 1 ? key.toUpperCase() : key);
}

/** True when any call mode is active. Wake-lock + a few other
 *  decisions key off this. Predicate centralised so adding new call
 *  modes (e.g. handsfree) doesn't require auditing every site that
 *  asks "are we in a call?" */
function isInCall(): boolean {
  return turnbased.getState() !== 'idle' || webrtcControls.isOpen();
}

/** Acquire/release the 'setting'-keyed wake-lock based on whether a
 *  call is active AND the user's wakeLock toggle. Idempotent: the
 *  ref-counted holders set in wakeLock.ts no-ops when state matches.
 *
 *  Field bug 2026-05-10 (Jonathan): pre-fix the lock acquired on boot
 *  if settings.wakeLock=true, then never released. Phone stayed awake
 *  outside calls — battery drain. Now the lock is gated on isInCall(),
 *  so toggling the setting outside a call is a no-op until the next
 *  call starts.
 *
 *  Called from:
 *    - boot (settings.wakeLock=true + already in call after reload)
 *    - settings onWakeLockChange (user toggles)
 *    - webrtcControls onCallStateChange (open/close, mode change)
 *    - turnbased onState (idle ↔ armed/committing/playing/cooldown)
 *
 *  The 'memo' / 'streaming' keys are managed independently in capture.ts. */
function evaluateWakeLock(): void {
  if (settings.get().wakeLock && isInCall()) {
    void wakeLock.acquire('setting');
  } else {
    void wakeLock.release('setting');
  }
}

/** Toggle the composer send button between idle (grey) and active (green).
 *  Sendable = memo recording in progress, typed text, draft content, or
 *  a pending voice transcript ready to send. */
function updateSendButtonState() {
  const send = document.getElementById('composer-send') as HTMLButtonElement | null;
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (!send) return;
  const sendable = !readOnlyComposer
    && (memoActive
      || (input?.value?.trim().length ?? 0) > 0
      || draft.hasContent()
      || attachments.hasPending());
  send.classList.toggle('active', sendable);
  send.disabled = !sendable;
}

/** Whether the composer is currently in read-only mode — set true
 *  when the user is viewing a non-sidekick chat (telegram/slack/etc).
 *  Cross-platform send isn't supported (the gateway's sidekick adapter
 *  always builds SessionSource(platform=SIDEKICK), so a send to a
 *  telegram chat_id would create a duplicate sidekick session rather
 *  than reaching telegram). Disabling input + send button is the
 *  honest affordance. */
let readOnlyComposer = false;

function setComposerReadOnly(readOnly: boolean, source: string = 'sidekick') {
  readOnlyComposer = readOnly;
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (input) {
    input.disabled = readOnly;
    if (readOnly) {
      input.placeholder = `View only — sent via ${source}`;
      input.classList.add('readonly');
    } else {
      input.placeholder = 'Ask anything';
      input.classList.remove('readonly');
    }
  }
  updateSendButtonState();
}

// ─── Mic device picker ─────────────────────────────────────────────────────

/** Populate the mic <select> with available audio input devices.
 *  Must be called after getUserMedia grants permission (labels are hidden until then). */
async function populateMicPicker() {
  const select = document.getElementById('set-mic') as HTMLSelectElement | null;
  if (!select) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    select.innerHTML = '<option value="">Default</option>';
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}…`;
      select.appendChild(opt);
    }
    select.value = settings.get().micDevice;
  } catch (e) {
    log('enumerateDevices error:', e.message);
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  // Platform gating runs FIRST so settings.load() and downstream
  // wiring see the post-gate DOM. Otherwise settings.ts's
  // `document.getElementById('set-reset-server')` returns the
  // about-to-be-removed button and attaches a click handler to a
  // dead reference — works (because removal detaches listeners
  // automatically) but the order is confusing to read.
  applyPlatformGates();

  // Hydrate settings BEFORE any UI wiring reads them. Earlier
  // settings.load() lived ~300 lines down in boot, after toolbar wiring,
  // which made btn-transport's sync() read DEFAULTS instead of the stored
  // value — the toggle would flip in storage but the highlight wouldn't
  // reflect it. Generally: any boot code that calls settings.get() before
  // this line was reading uninitialised defaults.
  // Async now: yaml-backed settings come from /api/sidekick/config; the
  // remaining per-device keys are read from localStorage in the same
  // call. Built-in DEFAULTS are the offline / proxy-down fallback.
  await settings.load();

  // Load config from server (keys, gateway info)
  await loadConfig();
  const cfg = getConfig();
  // Apply per-install skinning (app name, subtitle, theme color) before the
  // rest of the UI renders so branding is consistent from boot.
  applySkinning();

  // Debug panel — Ctrl+Shift+D on desktop, triple-tap header on mobile
  setDebugElement(document.getElementById('debug'));
  // Dev-mode pill + long-press toggle on the version label. Renders
  // a "DEV" badge next to "v0.473" when localStorage.dev_mode='1'.
  // See src/util/devMode.ts for the rationale (Jonathan's on-the-go
  // phone-bug-report workflow needs unmissable transparency).
  mountDevPill();
  // Fallback version label for runtimes where the service worker
  // can't deliver a version string — Capacitor's WKWebView blocks SW
  // registration, so #app-version stays at the "—" default forever
  // and the long-press surface is a tiny invisible target. Also a
  // back-stop for browsers where SW takes a long time to respond.
  // Wait briefly, then if still empty, write a generic label so the
  // long-press hit area is visibly a real button.
  setTimeout(() => {
    const vEl = document.getElementById('app-version');
    if (vEl && (vEl.textContent === '—' || vEl.textContent?.trim() === '')) {
      vEl.textContent = (window as any).Capacitor ? 'cap' : 'live';
    }
  }, 2500);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      document.getElementById('debug').classList.toggle('on');
    }
  });
  // Triple-tap on header toggles debug (mobile)
  let headerTaps = 0, headerTapTimer = null;
  document.querySelector('.header').addEventListener('click', () => {
    headerTaps++;
    clearTimeout(headerTapTimer);
    if (headerTaps >= 3) {
      document.getElementById('debug').classList.toggle('on');
      headerTaps = 0;
    } else {
      headerTapTimer = setTimeout(() => { headerTaps = 0; }, 500);
    }
  });

  // Status indicator
  status.init({
    status: document.getElementById('status'),
    statusText: document.getElementById('status-text'),
  });

  // Background-lifecycle diagnostic tracer — opt-in via ?bg_trace=1 or
  // localStorage.sidekick_bg_trace=1. Noop when not enabled. Install
  // before audioSession/capture touch anything so we catch the first
  // transitions. Getters are lazy — each poll reads live state, no
  // eager construction.
  bgTrace.install({
    getStream: () => capture.getActiveStream(),
    getAudioCtx: () => getSharedAudioCtx(),
    getKeepaliveEl: () => audioSession.getKeepaliveEl(),
  });
  // Expose dump() globally when tracing is enabled so the bench-test
  // protocol can grab the buffer from devtools with `sidekickBgTrace()`
  // and paste it into a bug report.
  if (bgTrace.isEnabled()) {
    (window as any).sidekickBgTrace = () => bgTrace.dump();
  }

  // Background audio session — Media Session (lock-screen + BT headset tap)
  // + silent keepalive. BT taps map to play/pause handlers; in WebRTC mode
  // these toggle the active call (mic stream / talk) on or off.
  audioSession.init({
    onPlay: () => {
      // BT play priority order:
      //   1. If a TTS reply is paused mid-stream, resume it (per-reply
      //      replay nav — pairs with onPause below).
      //   2. Otherwise, if a WebRTC call isn't open, open one via the
      //      mic button (respects user's call/PTT/auto-send toggles).
      if (ttsModule.isPaused()) {
        void ttsModule.resumeReplyTts();
        return;
      }
      if (webrtcControls.isOpen()) return;
      const btnMicEl = document.getElementById('btn-mic');
      if (btnMicEl) btnMicEl.click();
    },
    onPause: () => {
      // BT pause priority order:
      //   1. If a TTS reply is currently playing, pause it (per-reply
      //      replay nav — "truck driving by, lemme pause" UX).
      //   2. Otherwise close any open WebRTC call.
      if (ttsModule.getActiveReplyId() && !ttsModule.isPaused()) {
        ttsModule.pauseReplyTts();
        return;
      }
      if (webrtcControls.isOpen()) {
        void webrtcControls.closeIfOpen();
      }
    },
    onStop: () => {
      // BT explicit stop: same as pause for now — close the call.
      if (webrtcControls.isOpen()) {
        void webrtcControls.closeIfOpen();
      }
    },
    onForeground: () => {
      // No-op: WebRTC peer connection auto-recovers via ICE; classic-mode's
      // SR-recovery hop isn't needed.
    },
    // BT track-skip / lock-screen skip → per-reply replay within the
    // current chat. Skip-forward = next agent reply (re-synth via /tts
    // if not cached); skip-back = previous agent reply (cache hit on
    // anything already played this session). Replaces the earlier
    // chat-navigation wiring per Jonathan's classic-pipeline design:
    // "move a pointer back and forward over agent replies, generating
    // them if needed."
    onNextTrack: () => { void replyNavigator.playNext(); },
    onPrevTrack: () => { void replyNavigator.playPrev(); },
    // seekto: reserved for a future "seek inside the current TTS reply"
    // feature (skip 30s into a long answer). Not wired today.
    onSeekTo: (_seconds: number) => { /* reserved */ },
  });
  if (!audioSession.isStandalone()) {
    log('NOTE: not running as installed PWA — background audio will be limited');
  }

  // Pocket lock — full-screen overlay with swipe-to-unlock. Keeps tab
  // foreground so mic/TTS/barge-in keep working (no iOS suspension).
  // Prev/next callbacks share the same transcript-walking logic as the
  // Media Session handlers below.
  fakeLock.init({
    statusFn: () => ({
      listening: webrtcControls.isOpen() && webrtcControls.currentMode() === 'stream',
      speaking: webrtcControls.isOpen() && webrtcControls.currentMode() === 'talk',
      modelLabel: (() => {
        const e = settings.getCurrentModelEntry?.();
        if (!e) return '';
        return (e.name || e.id).replace(/^openrouter\//, '').split('/').slice(-1)[0];
      })(),
    }),
    // Pocket-lock prev/next: no-ops with the per-turn replay machinery
    // gutted. Wired to () => {} so fakeLock.ts's button handlers don't
    // crash on undefined callbacks; CSS hides the buttons in the
    // post-replay world but the call sites still fire.
    onPrev: () => {},
    onNext: () => {},
  });
  const btnLock = document.getElementById('btn-lock');
  if (btnLock) btnLock.onclick = () => {
    // Pocket-lock only makes sense when audio is actually live —
    // otherwise the user is staring at a locked screen with nothing
    // happening, and the unlock-swipe affordance is just confusing.
    // Gate on voiceActive() (memo || dictate || webrtc || listen);
    // surface a status hint so the button doesn't feel broken.
    if (!voiceActive()) {
      try { status.setStatus('Start a call or recording first', 'err'); } catch {}
      return;
    }
    // iOS pocketlock waveform fix (2026-05-01): force the audio prime
    // INSIDE the lock-button click gesture so the shared AudioContext
    // is created + resumed while the gesture is still live. fakeLock's
    // mic-meter wiring (attachMicAnalyserWhenReady → getMicAnalyser)
    // needs getSharedAudioCtx() to be non-null — without primeAudio
    // here, the shared context stays null on iOS until some other
    // gesture (memo/send) touches audio. Idempotent: primeAudio no-ops
    // if already primed + route is fresh.
    try { primeAudio(player); } catch { /* defensive */ }
    fakeLock.show();
  };

  // Sidebar — always visible (48px rail), expands on hamburger. Holds
  // new-chat, sessions list (if backend supports it), and info/settings
  // at the bottom. Desktop: expand state persists across reload and shifts
  // body content right (Gemini-style). Mobile: overlay-style, never
  // persisted (taps outside collapse it so the chat reclaims focus).
  const sidebar = document.getElementById('sidebar');
  const sbToggle = document.getElementById('sb-toggle');
  const sbToggleMobile = document.getElementById('sb-toggle-mobile');
  const SIDEBAR_PREF_KEY = 'sidekick.sidebar.expanded';
  if (sidebar && sbToggle) {
    const setExpanded = (exp: boolean) => {
      sidebar.classList.toggle('expanded', exp);
      sidebar.classList.toggle('collapsed', !exp);
      sidebar.setAttribute('aria-expanded', exp ? 'true' : 'false');
      // Body class drives mobile-only CSS: hide the toolbar hamburger when
      // the sidebar is open so the user taps outside to close (no competing
      // toggle on top of the overlay). On desktop, the same class shifts
      // body.padding-left to 260px so the main content slides right.
      document.body.classList.toggle('sidebar-expanded', exp);
      if (exp) sessionDrawer.refresh();  // fresh data each time we open
      // Persist only on desktop — a mobile toggle is a transient navigation
      // action, not a global preference, and we don't want it forcing the
      // drawer open on the next desktop load (or vice versa).
      if (window.innerWidth >= 700) {
        try { localStorage.setItem(SIDEBAR_PREF_KEY, exp ? '1' : '0'); } catch {}
      }
    };
    // Restore persisted state on desktop only. Mobile always starts collapsed.
    if (window.innerWidth >= 700) {
      try {
        if (localStorage.getItem(SIDEBAR_PREF_KEY) === '1') setExpanded(true);
      } catch {}
    }
    const toggle = (e?: Event) => {
      if (e) e.stopPropagation();  // don't let the same click count as "outside"
      setExpanded(!sidebar.classList.contains('expanded'));
    };
    sbToggle.onclick = toggle;
    if (sbToggleMobile) sbToggleMobile.onclick = toggle;
    // Tap outside sidebar closes it ON MOBILE ONLY. Desktop keeps it open
    // until manual hamburger toggle. Capture phase (third arg `true`) is
    // important: chat-bubble interactive controls (play, copy, scrubber)
    // call e.stopPropagation() to avoid side-effects in the transcript,
    // which was killing this listener during the bubble phase. Capture
    // fires on the way DOWN to the target, before any child handler runs,
    // so the collapse happens regardless. The button's own onclick still
    // fires normally afterwards.
    document.addEventListener('click', (e) => {
      if (!sidebar.classList.contains('expanded')) return;
      if (sidebar.contains(e.target as Node)) return;
      if (window.innerWidth >= 700) return;   // desktop: no-op
      setExpanded(false);
    }, true);

    // Edge-swipe to open / drawer-swipe to close (mobile only). Shares
    // the same setExpanded closure so persistence + body class flips
    // route through one path; the swipe module owns the visual drag +
    // snap animation and calls setExpanded() at the end of each gesture.
    sidebarSwipe.init({
      setExpanded,
      isExpanded: () => sidebar.classList.contains('expanded'),
    });
  }

  // Capture-phase pointerdown logger for click-freeze diagnosis. Pure
  // observation — no behavior change. Diag-level only (off in prod).
  clickFreezeDiag.init();

  // Lockscreen + BT-headset remote-control receiver. Cap forwards
  // MPRemoteCommandCenter callbacks via custom events; PWA uses the
  // Media Session API. Both feed the same dispatcher (stop = end call,
  // play/pause = TTS reply pause/resume).
  remoteControl.init();

  // Drop a chat we're navigating AWAY from if it's an empty placeholder
  // — 0 messages on the backend AND no unsent draft text AND no
  // pending attachments. Mirrors the new-chat rotation cleanup below
  // (search "Background cleanup: drop any OTHER stale 0-msg") but
  // triggered on navigation rather than rotation. Fire-and-forget so
  // the chat-switch UX doesn't wait on the IDB write or the proxy
  // round-trip; refresh paints the drawer once the deletes settle.
  // Drafts + attachments are intentional user investment — those rows
  // survive even with 0 backend messages.
  function cleanupAbandonedChat(leavingId: string | null): void {
    if (!leavingId) return;
    if (draft.hasContent() || attachments.hasPending()) return;
    // In-flight skip: if the user just sent a message and hermes hasn't
    // yet persisted (post-turn append_to_transcript), `cached.messageCount`
    // is still 0 — the cleanup heuristic below would treat this as an
    // unsent orphan and wipe the local IDB row. On switch-back,
    // resumeSession.hydrate(id) recreates the row with default 'New chat',
    // erasing the snippet we stamped on send AND (post-reply, after
    // inflight cache drops) leaving the transcript empty. Field bug
    // 2026-05-11 — TEST #1 + TEST #4 in /tmp/real-timer-flow.mjs.
    //
    // Signal: proxyClient.sendMessage stamps the IDB title with the
    // user's first message snippet. If the title is anything other than
    // the 'New chat' placeholder, the user sent SOMETHING — never
    // auto-clean. Async IDB read, fire-and-forget the rest of the work
    // so the switch UI isn't blocked.
    void (async () => {
      const local = await conversations.get(leavingId).catch(() => null);
      if (local && local.title && local.title !== 'New chat') {
        diag(`navigate-away: skipping cleanup of ${leavingId} — IDB title=${JSON.stringify(local.title)} indicates user content`);
        return;
      }
      cleanupAbandonedChatInner(leavingId);
    })();
  }

  function cleanupAbandonedChatInner(leavingId: string): void {
    // CONTRACT (post-v0.383 unification, 2026-05-03):
    // Auto-cleanup is LOCAL-IDB-ONLY. backend.deleteSession is reserved
    // for explicit user actions (menu delete, multi-select bulk).
    //
    // Replaces the pre-unification rule "refuse if id contains ':'":
    // post-IDB-schema-v2 EVERY id is prefixed (mintChatId stamps
    // `sidekick:`; cross-device hydrate carries the gateway prefix),
    // so the old gate would refuse every cleanup. The new rule keys
    // off whether the SERVER knows about the row, not the id shape:
    //   - cached row not in sessions list  → server never registered;
    //                                        local-only orphan, drop it.
    //   - cached row found, messageCount=0 → real-but-empty (e.g. a
    //                                        send aborted before any
    //                                        message landed); also a
    //                                        local-only orphan from
    //                                        the user's perspective.
    //   - otherwise                        → server owns the lifecycle,
    //                                        refuse to auto-clean.
    //
    // Pre-fix this called backend.deleteSession on bare ids; the
    // plugin's un-prefixed DELETE fallback wiped real sessions whose
    // chat_id matched a bare local-IDB orphan (Jonathan's morning
    // audio-test session, 2026-05-03 01:29). This path now NEVER
    // touches the backend.
    const cached = sessionDrawer.getCachedSessions().find(s => s.id === leavingId);
    const serverKnowsRow = !!cached && cached.messageCount > 0;
    if (serverKnowsRow) return;
    diag(`navigate-away: dropping local-only orphan ${leavingId}`);
    void conversations.remove(leavingId)
      .catch((e: any) => diag(`navigate-away cleanup failed: ${e?.message}`))
      .then(() => sessionDrawer.scheduleRefresh());
  }

  // Drag handle on the sidebar's right edge. Restores the persisted
  // width on boot + wires the pointer drag → CSS `--sidebar-width`
  // pipeline. No-op on mobile (overlay sidebar) and on the rail.
  sidebarResize.init();

  // Bulk-select panel — appears when the user shift-clicks 2+ drawer
  // rows. Reads stats from the cached session list (no extra fetch);
  // delete fires the same `backend.deleteSession` cascade individual
  // row deletes do.
  multiSelect.init({
    getSessions: () => sessionDrawer.getCachedSessions() as any,
    // Route bulk delete through sessionDrawer's atomic path so it picks
    // up recentlyDeleted, resumeGen bump, optimistic/viewed clears, and
    // IDB cache patch — same race protections as the row-menu delete.
    // Pre-refactor this called backend.deleteSession directly and missed
    // every one of those surfaces (latent bug; tests didn't exercise the
    // race for bulk).
    deleteOne: (id: string) => sessionDrawer.deleteSessionFromUI(id),
    onClear: () => sessionDrawer.clearMultiSelect(),
  });

  // Session list inside the sidebar — renders when backend supports browsing.
  sessionDrawer.init({
    // sessionDrawer's onResumeCb shape passes inflight as the 4th arg
    // (no targetMessageId concept here); replaySessionMessages's slot
    // for targetMessageId is between pagination and inflight, so adapt.
    onResume: (id: string, messages: any[], pagination?: any, inflight?: any[]) =>
      replaySessionMessages(id, messages, pagination, undefined, inflight),
    onBeforeSwitch: cleanupAbandonedChat,
    onMultiSelectChange: (ids: string[]) => multiSelect.update(ids),
    // Stale-foreground recovery: if the session the user is currently
    // viewing gets deleted out from under them (menu delete, bulk wipe,
    // backend nuke), drop the ghost transcript and rotate to a fresh
    // chat surface so they can keep going.
    onSessionGone: () => {
      diag('reset history: viewed session disappeared from server');
      renderedMessages.clear();
      activityRow.clearAll();
      draft.dismiss();
      voiceMemos.clearAll().catch(() => {});
      historyLoaded = false;
      backend.newSession?.();
      chat.addSystemLine('The session you were viewing was deleted. Started a fresh chat.');
    },
  });
  // Cmd+K palette — instant session filter + debounced messages_fts
  // search. Resume hits funnel through replaySessionMessages so behavior
  // matches a normal drawer tap.
  cmdkPalette.init({
    onResume: replaySessionMessages,
    onBeforeSwitch: cleanupAbandonedChat,
  });
  // Sidebar-top search button → opens the cmd+K palette. Lives next to
  // the hamburger as the rightmost icon in .sidebar-top-row (Gemini-style
  // header). Replaces the old inline magnifier that used to sit beside
  // the filter input.
  const sbSearch = document.getElementById('sb-search');
  if (sbSearch) sbSearch.onclick = (e) => { e.preventDefault(); cmdkPalette.open(); };

  // Range-slider drag-from-track behavior (iOS thumb hit-test fix).
  // Wires every <input type=range> currently in the DOM. Settings panel
  // sliders are static; the call-mode menu's barge slider is also static
  // by build time. Re-call after dynamic DOM additions if any new
  // sliders show up later.
  attachSliderTouchAll(document);
  // Re-wire after agent-declared rows render (model picker, future
  // schema-driven sliders). attachSliderTouchAll is idempotent.
  window.addEventListener('agent-schema-loaded', () => attachSliderTouchAll(document));

  // Info popup — triggered from the sidebar-bottom button.
  const btnInfo = document.getElementById('sb-info');
  const infoPanel = document.getElementById('info-panel');
  const infoClose = document.getElementById('info-close');
  if (btnInfo && infoPanel) {
    btnInfo.onclick = () => { infoPanel.classList.remove('hidden'); infoPanel.setAttribute('aria-hidden', 'false'); };
    const closeInfo = (e?: Event) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      infoPanel.classList.add('hidden');
      infoPanel.setAttribute('aria-hidden', 'true');
    };
    if (infoClose) {
      // pointerup + click for iOS-quirky cases — same pattern as
      // settings-close. Without pointerup, the close on iPhone could
      // register :active but fail to fire click (observed in BUG 5).
      infoClose.addEventListener('pointerup', closeInfo);
      infoClose.addEventListener('click', closeInfo);
    }
    infoPanel.addEventListener('click', (e) => {
      if (e.target === infoPanel) closeInfo();
    });
  }

  // Settings — first load() ran above in boot(); this is a redundant
  // resync left for safety in case anything mutated `current` between
  // boot's load and now (e.g. a backend.connect() that called
  // settings.set()).
  await settings.load();
  settings.applyVisuals();
  settings.hydrate({
    onThemeChange: () => theme.applyTheme(settings.get().theme),
    onVoiceChange: () => {
      // Voice change: takes effect on the next WebRTC talk-mode call
      // (server-side TTS provider reads its config). No client-side cache
      // to invalidate now that per-turn replay is gone.
    },
    onMicChange: () => {
      // If a WebRTC call is open, close it so the new device picks up on
      // the next open. (Live device-swap on a peer connection is finicky;
      // simpler to bounce.)
      if (webrtcControls.isOpen()) void webrtcControls.closeIfOpen();
    },
    onStreamingEngineChange: () => {
      // Engine flip — re-evaluate UI affordances. Local engine hides
      // btn-call (realtime+speak mode disappears); server restores it.
      // The actual engine selection happens at dictate.start() time
      // via browserDictate.pickStreamingProvider() — no in-flight state
      // to migrate here, just the UI. The applyMicModeUi function is
      // declared inside setupComposerActions further below; defer the
      // call to the rebroadcast event so wiring order doesn't matter.
      window.dispatchEvent(new CustomEvent('sidekick:engine-changed'));
    },
    onWakeLockChange: () => {
      // Wake-lock is scoped to active calls — see evaluateWakeLock()
      // for the model. Toggling the setting outside a call is a no-op
      // (stays released); inside a call the toggle takes effect
      // immediately. Field bug 2026-05-10 (Jonathan): pre-fix the lock
      // engaged on boot regardless of call state, draining battery
      // outside calls.
      evaluateWakeLock();
    },
    onAutoSendChange: () => {},
    onModelChange: (ref: string, catalog: any[], opts: { silent?: boolean } = {}) => {
      const entry = catalog.find((e: any) => e.id === ref);
      const label = entry ? (entry.name || entry.id).replace(/^openrouter\//, '') : ref;
      if (!opts.silent) chat.addSystemLine(`Model: ${label}`);
      attachments.updateModelGate();
    },
  });

  // Theme
  theme.applyTheme(settings.get().theme);
  theme.watchSystem(() => settings.get().theme);

  // Wake lock — the ref-counted holders set in wakeLock.ts is authoritative;
  // watchVisibility re-acquires the OS sentinel on visibility→visible / focus
  // / resume whenever any key is held. The 'setting' key is acquired only
  // during active calls (see evaluateWakeLock); on boot we evaluate once
  // so a call-in-progress reload re-acquires correctly. The 'memo' and
  // 'streaming' keys are owned by capture.ts and acquire/release per
  // capture session independently.
  wakeLock.watchVisibility();
  evaluateWakeLock();

  // Chat
  const transcriptEl = document.getElementById('transcript');
  const chatRestored = await chat.init(transcriptEl);
  chat.onLoadEarlier(loadEarlierHistory);
  // Backfill ALWAYS runs on connect — dedup by text handles duplicates.
  // The snapshot lives in IndexedDB (survives tab close, PWA kills, and
  // cross-SW-version reloads); backfill plugs any residual gap on connect.
  if (chatRestored) log('chat: restored from snapshot');

  // Attachments + draft — composer wiring that isn't tied to a specific button
  attachments.init({ onChange: updateSendButtonState });

  // Global hotkeys. Alt+M toggles the WebRTC stream call; Alt+T toggles
  // talk mode. Esc closes an open settings or info panel.
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const tag = t?.tagName;
    const inText = tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable;

    // Esc: close whichever overlay panel is open (settings panel is
    // always eligible; info panel only when not hidden).
    if (e.key === 'Escape') {
      const settingsPanel = document.getElementById('settings');
      if (settingsPanel?.classList.contains('on')) {
        settingsPanel.classList.remove('on');
        e.preventDefault();
        return;
      }
      const infoPanel = document.getElementById('info-panel');
      if (infoPanel && !infoPanel.classList.contains('hidden')) {
        infoPanel.classList.add('hidden');
        infoPanel.setAttribute('aria-hidden', 'true');
        e.preventDefault();
        return;
      }
    }

    // `/`: focus the inline session filter. Skip when an input/textarea
    // is already focused so it doesn't hijack a literal slash typed into
    // the composer or the cmd+K palette. (cmdkPalette.init wires its
    // own cmd+K handler at document level.)
    if (e.key === '/' && !inText) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('expanded')) {
        // Make sure the sidebar is open so the input is visible/clickable.
        sidebar.classList.add('expanded');
      }
      sessionDrawer.focusFilter();
      e.preventDefault();
      return;
    }

    // Alt+M: toggle the unified composer mic. `e.code` survives Mac's
    // Alt+key → µ remapping. Fires even from within text inputs — the
    // intent to start voice input is explicit enough that composer
    // focus shouldn't eat it.
    if (e.altKey && e.code === 'KeyM') {
      e.preventDefault();
      document.getElementById('btn-mic')?.click();
      return;
    }

    // Alt+T: toggle TTS-replies preference (talk vs stream mode). Routes
    // through flipMicSetting so the menu UI + connection-cycling logic
    // stays the single source of truth (see flipMicSetting in this file).
    if (e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      flipMicSetting('tts');
      return;
    }
  });
  // Per-bubble TTS playback UX (loading bar, played-ratio bar,
  // play/pause/replay button, scrub). Subscribes to tts.ts events
  // and updates DOM by replyId. Delegated click + pointerdown live
  // here too — chat.ts:addLine just emits the DOM, replyPlayer owns
  // all interaction.
  if (transcriptEl) {
    replyPlayer.init({
      transcriptEl,
      resolveVoice: () => settings.get().voice,
    });
  }

  // Bridge tts state → Listen state via the typed events, in ONE place.
  // Replaces ad-hoc notifyReplyPlayback() calls scattered across
  // handleReplyFinal + onBarge. SSOT: the audio's state machine is
  // authoritative; Listen observes it. Resume after barge now Just
  // Works because pause+resume go through the same play/pause events.
  ttsModule.on('play-start', () => { try { turnbased.notifyReplyPlayback(true);  } catch {} });
  ttsModule.on('resumed',    () => { try { turnbased.notifyReplyPlayback(true);  } catch {} });
  ttsModule.on('paused',     () => { try { turnbased.notifyReplyPlayback(false); } catch {} });
  ttsModule.on('ended',      () => { try { turnbased.notifyReplyPlayback(false); } catch {} });
  ttsModule.on('stopped',    () => { try { turnbased.notifyReplyPlayback(false); } catch {} });
  draft.init({
    transcriptEl,
    onChange: updateSendButtonState,
    onScroll: chat.autoScroll,
    onFlush: (text) => {
      // User bubble FIRST, then send. Pre-mint userMessageId + use
      // renderedMessages so the server's user_message envelope echo
      // dedups idempotently (the SSOT contract every user-bubble
      // path follows post-2026-05-04).
      const userMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      renderedMessages.upsert(userMessageId, {
        role: 'user',
        text,
        status: 'finalized',
        speaker: 'You',
        cls: 's0',
        source: 'voice',
      });
      backend.sendMessage(text, { voice: true, userMessageId });
      playFeedback('send');
    },
  });
  // composer.init is called later (after sendTypedMessage is defined)
  // so onSubmit can be wired — see the call next to composerSend.onclick.

  // Clear previously-sent memos (reload = clean slate). Pending/queued
  // memos are preserved so the offline outbox survives phone lock/reboot.
  // Defensive: clearSent was added after voiceMemos shipped — if a stale
  // cached voiceMemos.ts is paired with a fresh main.ts (SW cache race),
  // skip rather than crash boot.
  if (typeof voiceMemos.clearSent === 'function') {
    await voiceMemos.clearSent().catch(() => {});
  }
  // Restore memo cards from IndexedDB (only pending now)
  await restoreMemoCards();

  // The legacy <audio id="player"> element survives in the DOM as a
  // generic media-source anchor for the audio session; classic-mode TTS
  // playback was wired into it but is gone now. WebRTC creates its own
  // <audio> element on pc.ontrack inside connection.ts.
  const player = document.getElementById('player') as HTMLAudioElement;

  // Register card kinds — inline attachments on agent bubbles.
  [imageCard, youtubeCard, spotifyCard, linksCard, markdownCard, loadingCard]
    .forEach(registerCard);

  // Ambient clock + weather — floating pill in lower-right on desktop,
  // hidden via CSS on mobile (single media query).
  ambient.init();

  // Fast tooltips: native HTML `title` triggers a slow ~1.5-3s browser
  // tooltip. We render our own tooltip element directly under <body>
  // (NOT as a pseudo-element of the target) so it can't be clipped by
  // any ancestor stacking-context, transform, overflow:hidden, or
  // z-index ceiling. Position is computed from getBoundingClientRect
  // each time, with auto-flip above/below based on viewport edges.
  //
  // closest('[title]') matters: hovering over an SVG / path child of
  // a button lands the event on the child, which has no `title`.
  // Without the walk-up, those buttons fall back to the native
  // ~1.5s tooltip. closest() finds the button up the tree.
  const TOOLTIP_DELAY_MS = 300;
  let tipEl: HTMLDivElement | null = null;
  let tipTarget: HTMLElement | null = null;
  let tipShowTimer: number | null = null;
  function clearShowTimer() {
    if (tipShowTimer != null) {
      clearTimeout(tipShowTimer);
      tipShowTimer = null;
    }
  }
  function hideTip() {
    clearShowTimer();
    if (tipEl) { tipEl.remove(); tipEl = null; }
    tipTarget = null;
  }
  function showTip(target: HTMLElement, text: string) {
    if (tipEl) tipEl.remove();
    const el = document.createElement('div');
    el.className = 'app-tooltip';
    el.textContent = text;
    document.body.appendChild(el);
    const r = target.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    let top = r.top - er.height - 6;
    if (top < 4) {
      el.classList.add('below');
      top = r.bottom + 6;
    }
    let left = r.left + r.width / 2 - er.width / 2;
    if (left < 4) left = 4;
    if (left + er.width > window.innerWidth - 4) {
      left = window.innerWidth - 4 - er.width;
    }
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    tipEl = el;
    tipTarget = target;
  }
  document.body.addEventListener('mouseover', (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.('[title]') as HTMLElement | null;
    if (!t) return;
    if (t === tipTarget) return;  // already scheduled / shown
    const v = t.getAttribute('title');
    if (!v) return;
    // Suppress native tooltip while ours pends.
    t.setAttribute('data-tip', v);
    t.removeAttribute('title');
    clearShowTimer();
    tipShowTimer = window.setTimeout(() => {
      tipShowTimer = null;
      showTip(t, v);
    }, TOOLTIP_DELAY_MS) as unknown as number;
  }, true);
  document.body.addEventListener('mouseout', (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (!t) return;
    const related = (e as MouseEvent).relatedTarget as Node | null;
    if (related && t.contains(related)) return;  // moving within the same tipped element
    const v = t.getAttribute('data-tip');
    if (v) { t.setAttribute('title', v); t.removeAttribute('data-tip'); }
    if (tipTarget === t || tipShowTimer != null) hideTip();
  }, true);
  // Hide tip on scroll/resize since the bounding rect we computed is stale.
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
  // Hide tip on any pointerdown / touchstart — iOS synthesizes mouseover
  // from a tap, so a tap on (e.g.) the pocket-lock button schedules the
  // tooltip; by the time it fires 300ms later, the button's action has
  // launched (lockscreen overlay) and the tooltip ends up rendered on
  // top of it. Pointer / touch events fire BEFORE the synthesized mouse
  // events on tap, so killing the tooltip here lands ahead of any
  // schedule.
  window.addEventListener('pointerdown', hideTip, true);
  window.addEventListener('touchstart', hideTip, { capture: true, passive: true });

  // Drive the mic-button peak indicator on the composer mic (the
  // toolbar #btn-mic is gone; the composer mic is now the single
  // voice-input affordance). Smooth raw worklet peaks with a light
  // exponential filter so the CSS var eases between frames.
  const btnMicForPulse = document.getElementById('btn-mic');
  if (btnMicForPulse) {
    let smoothed = 0;
    setMicPeakListener((peak) => {
      // Attack fast, decay slow — matches perception of volume meters.
      smoothed = peak > smoothed
        ? peak
        : smoothed * 0.7 + peak * 0.3;
      btnMicForPulse.style.setProperty('--mic-peak', smoothed.toFixed(3));
    });
  }

  // ── Backend ────────────────────────────────────────────────────────────
  // Whichever adapter is configured (openclaw by default, openai-compat
  // for a minimal cloud-LLM deploy, future: geminilive) — same interface.
  // Tool events including canvas.show flow through the regular SSE
  // stream; the shell subscribes via onToolEvent below.
  await backend.connect({
    onStatus: async (connected) => {
      if (connected) {
        status.setStatus('Gateway: connected', 'ok');
        // For backends that browse sessions (hermes), resume the adapter's
        // default conversation on boot. If it's empty (fresh install),
        // replaySessionMessages is a no-op and the user gets the blank
        // welcome. For backends without session browsing (openclaw),
        // fall back to the existing history backfill path.
        if (backend.capabilities().sessionBrowsing) {
          // Prefer the session id persisted alongside the restored chat
          // snapshot — that's the session whose transcript is ACTUALLY on
          // screen after reload. Falls back to the adapter's
          // conversationName ('sidekick-main' default) for the fresh
          // install path where no snapshot existed.
          const restoredSid = chat.getRestoredViewedSessionId();
          const sid = restoredSid || backend.getCurrentSessionId?.();
          let bootRendered = false;
          if (sid) {
            // If we restored a session from snapshot, seed the drawer
            // highlight immediately — before resumeSession's network
            // fetch resolves — so it doesn't briefly flash the
            // placeholder row. If resumeSession succeeds it replays
            // freshly and re-sets viewed via replaySessionMessages
            // (idempotent).
            if (restoredSid) sessionDrawer.setViewed(restoredSid);
            try {
              const result: any = await backend.resumeSession(sid);
              const messages = result.messages || [];
              if (messages.length) {
                replaySessionMessages(sid, messages, undefined, undefined, result.inflight);
                bootRendered = true;
              }
            } catch (e: any) {
              diag(`boot: resume ${sid} failed: ${e.message}`);
            }
          }
          // Boot-UX (Jonathan 2026-04-29): if nothing got rendered above
          // (no snapshot, OR snapshot's session no longer exists, OR
          // adapter's activeChatId points to an unsent stub), pick the
          // most recent existing session and show it. Avoids the
          // "selected stub but body shows another chat" divergence and
          // gives the user a sane landing state on fresh installs that
          // already have history (cross-device, cross-platform).
          if (!bootRendered) {
            try {
              const sessions = await backend.listSessions(50);
              if (sessions.length > 0) {
                const mostRecent = sessions[0];
                diag(`boot: no rendered session, picking most recent: ${mostRecent.id}`);
                const result: any = await backend.resumeSession(mostRecent.id);
                replaySessionMessages(
                  mostRecent.id,
                  result.messages || [],
                  { firstId: result.firstId ?? null, hasMore: !!result.hasMore },
                  undefined,
                  result.inflight,
                );
              }
            } catch (e: any) {
              diag(`boot: most-recent fallback failed: ${e.message}`);
            }
          }
        } else {
          await backfillHistory();
        }
        await flushOutbox();
        if (settings.refreshModels) settings.refreshModels().catch(() => {});
        // Eager schema fetch so consumers depending on agent settings
        // (currently the composer attach-button vision-gate) have data
        // from page load — without this, agentSettings.getCurrentValue
        // ('model') returns undefined until the user opens the Settings
        // panel, leaving image-upload UI greyed even on vision-capable
        // models. Fires the agent-schema-loaded event the gate listens
        // for. Errors silently — the existing on-panel-open path still
        // re-tries.
        agentSettingsMod.load().catch(() => {});
        // Refresh the slash-command catalog from the agent. Cheap
        // (one ~50-row JSON), fires on every (re)connect so plugin-
        // installed commands and registry updates land without a page
        // reload. No-op silently if the agent doesn't implement
        // /v1/commands.
        slashCommands.refresh().catch(() => {});
      } else {
        status.setStatus('Gateway: disconnected');
      }
    },
    onDelta: handleReplyDelta,
    onFinal: handleReplyFinal,
    onToolEvent: handleToolEvent,
    onActivity: handleActivity,
    onNotification: handleNotification,
    onUserMessage: handleUserMessage,
    onSessionChanged: () => {
      // Adapter has already updated its local state (IDB title etc).
      // Re-render the drawer so the new title surfaces immediately
      // — without this the user only sees it on next list poll.
      // Coalesced: a turn can fire multiple session_changed envelopes
      // and each individually-rendered drawer is wasted work + flicker.
      sessionDrawer.scheduleRefresh();
    },
    // Phase 3 — surface tool calls / results as inline activity rows.
    // Renderer reads settings.agentActivity per call, so toggling at
    // runtime takes effect on the next event without re-wiring.
    onToolCall: (e) => activityRow.appendToolCall(e.conversation, e),
    onToolResult: (e) => activityRow.appendToolResult(e.conversation, e),
    // Adapter-driven reconcile: hermes-gateway fires this when its
    // persistent SSE channel has been down long enough that the
    // server's replay ring may have rolled over. Re-render the active
    // chat from the freshly-fetched transcript via the same path the
    // drawer-click resume uses (clear + replay) — clearing also
    // sidesteps live-vs-history dedupe, since any half-rendered bubble
    // is wiped before the new transcript paints.
    onResume: (e: any) => {
      if (!e?.conversation) return;
      const messages = Array.isArray(e.messages) ? e.messages : [];
      const pagination = {
        firstId: e.firstId ?? null,
        hasMore: !!e.hasMore,
      };
      replaySessionMessages(e.conversation, messages, pagination);
    },
    // Adapter-relayed new-session announcement. The legacy hermes adapter
    // surfaces these from the proxy's drawer-events SSE; other adapters
    // leave the callback unfired and the drawer waits for the next list
    // poll to pick up new sessions. The drawer paints a synthetic
    // "pending" row so the just-created chat is visible in the list
    // before listSessions catches up.
    onSessionStarted: (e: any) => sessionDrawer.handleSessionAnnounced(e),
  });
  // Show/hide the sessions section inside the sidebar based on the
  // active backend's capabilities (sidebar itself is always visible).
  sessionDrawer.applyCapabilities();

  // Any user-initiated send shows the thinking indicator immediately —
  // doesn't wait for the first delta. Critical for the case where the
  // agent jumps straight to tool calls (calendar, email, web fetch) with
  // no text deltas for seconds; without this the chat looks dead.
  backend.onSend(() => showThinking());

  // Freeze the previous turn's activity row on every new user-initiated
  // send so the next tool-event lands in a fresh row (per-turn grouping).
  // The viewed chat is the only one whose row exists in DOM right now;
  // background-chat rows are dropped at render time.
  backend.onSend(() => {
    const viewed = sessionDrawer.getViewed();
    if (viewed) activityRow.freezeOnUserMessage(viewed);
  });

  // Any user-initiated send is also a signal that the network is
  // responsive — take that opportunity to retry queued audio blobs
  // stuck in the outbox. Triggered the right fix for the case where
  // /transcribe fails on mobile mid-memo, gateway stays connected, and
  // without this the queue just sits (reconnect-only retries don't
  // fire when the WS never dropped). Mutex in queue.flush keeps this
  // idempotent if two triggers overlap.
  backend.onSend(() => { flushOutbox().catch(() => {}); });

  // Hide settings rows whose feature isn't supported by the active backend.
  // E.g. openai-compat doesn't expose a model catalog → hide the model row.
  const caps = backend.capabilities();
  if (!caps.models) {
    const rowModel = document.getElementById('row-model');
    if (rowModel) rowModel.style.display = 'none';
  }

  // ── WebRTC controls ───────────────────────────────────────────────────
  // The TTS-reply preference (settings.tts) lives as a toggle in the
  // mic-mode menu — see flipMicSetting('tts') below. The unified
  // composer mic owns the call open/close lifecycle; controls.ts
  // exports toggleCall / openCall / closeIfOpen for the dispatcher
  // to invoke.
  webrtcControls.init({
    getSessionId: () => sessionDrawer.getViewed() || backend.getCurrentSessionId?.() || null,
    onStatus: (msg, kind) => status.setStatus(msg, kind ?? null),
    // Wake-lock follows call lifecycle — connected/closing/failed/idle
    // transitions all need re-evaluation. evaluateWakeLock is idempotent.
    onCallStateChange: () => evaluateWakeLock(),
  });

  // WebRTC data-channel events: parallel text path that surfaces
  // user-speech transcripts and assistant reply deltas as the call
  // proceeds.
  //
  // User finals are NOT immediately rendered as bubbles any more — the
  // bridge sends every is_final, but the PWA owns the dispatch trigger
  // (silence timer + commit-phrase) via webrtcDictation. The user
  // bubble renders once per dispatch (one utterance = one bubble), set
  // up below via setUserBubbleHandler.

  // Streaming user bubble for live dictation. Created on first interim
  // of a new utterance; updated as interims/finals arrive; finalized
  // on dispatch. Lives in `renderedMessages` keyed by a pre-minted
  // `userMessageId` so the server's `user_message` envelope echo
  // collapses idempotently into the same bubble (no dupe).
  //
  // The id rides through the data-channel `dispatch` envelope →
  // bridge → `/v1/responses` `metadata.user_message_id` → plugin
  // emits user_message envelope with the same id → handleUserMessage
  // upserts under same key → no-op for the originator.
  let dcUserMessageId: string | null = null;
  let dcUserBufferedFinals = '';
  function userBubbleEl(): HTMLElement | null {
    if (!dcUserMessageId) return null;
    return document.querySelector(
      `.line[data-message-id="${CSS.escape(dcUserMessageId)}"]`,
    ) as HTMLElement | null;
  }
  function ensureUserBubble(initial: string): HTMLElement | null {
    if (!dcUserMessageId) {
      dcUserMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      renderedMessages.upsert(dcUserMessageId, {
        role: 'user',
        text: initial,
        status: 'streaming',
        speaker: 'You',
        cls: 's0 streaming',
        source: 'voice',
      });
    }
    return userBubbleEl();
  }
  function setUserBubbleText(text: string): void {
    if (!dcUserMessageId) return;
    renderedMessages.upsert(dcUserMessageId, {
      role: 'user',
      text,
      status: 'streaming',
      speaker: 'You',
      cls: 's0 streaming',
    });
  }
  /** Pulled by webrtcDictation when it dispatches — pre-mints a bubble
   *  id if one isn't already alive (e.g. dispatch fired before any
   *  interim was rendered). The id ships in the dispatch envelope so
   *  the server's user_message echo dedups against the same key. */
  function getOrMintUserMessageId(): string {
    if (!dcUserMessageId) {
      dcUserMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
    return dcUserMessageId;
  }
  webrtcDictation.setOnResetHandler(() => {
    // Call closed (or reopened) — drop any in-flight streaming state.
    // Orphan streaming bubble (dispatch never fired) gets removed.
    if (dcUserMessageId) {
      const el = userBubbleEl();
      if (el) el.remove();
      renderedMessages.remove(dcUserMessageId);
    }
    dcUserMessageId = null;
    dcUserBufferedFinals = '';
  });
  webrtcDictation.setUserBubbleHandler((text) => {
    // Dispatch fired — finalize the bubble. If we never rendered an
    // interim (e.g. silence-commit on empty utterance), mint an id now.
    const id = getOrMintUserMessageId();
    renderedMessages.upsert(id, {
      role: 'user',
      text,
      status: 'finalized',
      speaker: 'You',
      cls: 's0',
      source: 'voice',
    });
    dcUserMessageId = null;  // next utterance mints a fresh id
    dcUserBufferedFinals = '';
  });
  webrtcDictation.setUserMessageIdProvider(getOrMintUserMessageId);
  webrtcConnection.setDataChannelListener((ev) => {
    if (ev.type === 'barge') {
      // Server-side VAD detected user voice during TTS. Cancel local
      // playback and clear the user-transcript suppression so the
      // user's words flow through the rest of the data-channel
      // pipeline. See docs/SIDEKICK_AUDIO_PROTOCOL.md.
      log('[webrtc] server-side barge fired — cancelling TTS playback');
      webrtcConnection.cancelRemotePlayback();
      webrtcSuppress.onBarge();
      return;
    }
    if (ev.type === 'listening') {
      // Bridge announced "STT pipe is hot" — fires at call-start AND
      // after every TTS-end transition (i.e. it's the user's turn
      // again in a multi-turn call). Plays the soft two-tone "your
      // turn" cue. Single source of truth: don't fire this anywhere
      // else on the client.
      log('[bubble-diag] listening envelope received from bridge');
      try { playFeedback('listening'); } catch { /* ignore */ }
      // Authoritative "TTS audio done" signal — flips the realtime
      // BargeWindow's playback gate off. Without this the gate was
      // tied to suppress.isSuppressing() (a SHORT transcript-grace
      // window) and the detector stopped running while TTS was still
      // playing through the speaker — barge couldn't fire past the
      // first 1.2s of any reply (v0.381 field-test regression).
      webrtcSuppress.onListening();
      // Visual pulse — adds the .listening class to the mic button so
      // the user can distinguish "we got your touch" (red filled, no
      // pulse) from "actually listening" (red filled + pulse). The
      // class clears with .active on stopVoice.
      const btn = document.getElementById('btn-mic');
      if (btn) btn.classList.add('listening');
      return;
    }
    if (ev.type !== 'transcript' || typeof ev.text !== 'string') return;
    if (ev.role === 'user') {
      // Half-duplex: while the agent is speaking, the speaker-to-mic
      // path re-captures TTS output as STT input. Drop user transcripts
      // for the entire TTS audio playback window — `isTtsPlaying()`
      // is the authoritative "TTS audio not yet done" signal (set on
      // assistant_delta, cleared on bridge `listening` envelope).
      // `isSuppressing()` was the old gate but only covered the
      // text-final + 1.2s grace window — TTS audio plays for many
      // more seconds, so the post-grace window leaked TTS bleed-through
      // back as fake user transcripts (the "1 2 3 4 5 6 7 8 9 zero"
      // feedback loop Jonathan saw 2026-05-03 09:18). Use ttsPlaying
      // for full playback coverage; client-side BargeWindow handles
      // the legitimate barge case independently.
      if (webrtcSuppress.isTtsPlaying()) return;
      if (!ev.is_final) {
        // Interim: upsert the streaming user bubble. Display = previously
        // is_finalized segments for this utterance + current interim.
        const display = (dcUserBufferedFinals + ' ' + ev.text).trim();
        if (!display) return;
        ensureUserBubble(display);
        setUserBubbleText(display);
        return;
      }
      // Final segment: append to our buffered-finals copy, update the
      // bubble to reflect the locked-in text, then feed the dictation
      // state machine so it can buffer for dispatch (silence/commit).
      dcUserBufferedFinals = (dcUserBufferedFinals + ' ' + ev.text).trim();
      ensureUserBubble(dcUserBufferedFinals);
      setUserBubbleText(dcUserBufferedFinals);
      webrtcDictation.handleUserFinal(ev.text);
      return;
    }
    // Assistant transcripts arrive on the SSE handleReplyDelta /
    // handleReplyFinal path (single render origin); the bridge's
    // ev.role === 'assistant' duplicates are intentionally ignored.
  });

  // Populate the mic picker once on boot. It needs prior getUserMedia
  // permission for labels to surface — until permission is granted, the
  // dropdown shows generic "Mic <id>" entries. Subsequent WebRTC calls
  // will get full labels on the next render.
  populateMicPicker().catch(() => {});

  // Release-all coordinator. Closes the active WebRTC call + tears down
  // any in-progress voice memo. External call sites assign through this
  // module-level handle so the closure references the right state.
  releaseCaptureIfActive = () => {
    if (webrtcControls.isOpen()) void webrtcControls.closeIfOpen();
    if (webrtcDictate.isActive()) void webrtcDictate.stop();
    if (memoActive) {
      memo.cancel();
      const bar = document.querySelector('.memo-bar');
      if (bar) bar.remove();
      memoActive = false;
      log('[mic-diag] memoActive=false (releaseCaptureIfActive)');
      // Textarea + btnMic stay visible during memo (bottom-row-only
      // memo bar UX), so no display:'' to reset here. Restore the
      // composer-actions row in case it was hidden during memo.
      const composerEl3 = document.querySelector('.composer') as HTMLElement | null;
      const actionsEl = composerEl3?.querySelector('.composer-actions') as HTMLElement | null;
      if (actionsEl) actionsEl.style.display = '';
    }
    if (capture.hasActive()) capture.release();
  };

  // ── Composer ────────────────────────────────────────────────────────────
  const composerInput = document.getElementById('composer-input') as HTMLTextAreaElement;
  const composerSend = document.getElementById('composer-send') as HTMLButtonElement;

  /** Shared mount-site for the recorder bar (memo + turn-based both
   *  hide the composer-actions row and drop a recorder bar into the
   *  same physical spot). Returns the args every recorderBar.mount
   *  caller needs, plus a `restore()` that the caller invokes from
   *  every teardown path so the actions row reappears.
   *
   *  Returns null if the composer DOM isn't present (defensive — the
   *  caller can fall back to no-bar mode). */
  function enterComposerBarMount(): {
    container: HTMLElement;
    insertBefore: HTMLElement | null;
    hide: () => void;
    restore: () => void;
  } | null {
    const composerEl = composerInput?.parentElement as HTMLElement | null;
    if (!composerEl) return null;
    const actionsEl = composerEl.querySelector('.composer-actions') as HTMLElement | null;
    // 2026-05-05: actions row no longer hidden synchronously here.
    // Caller invokes hide() AFTER the audio path has actually opened
    // (turnbased.start / memo.start succeeded). Reason: cold-start
    // capture.acquire awaits the iOS audio-session prime which can take
    // ~2s on first call. Hiding actions before the recorder bar mounts
    // left an empty composer for the duration — app looked stuck. Now
    // the actions row stays visible during the wait; the recorder bar
    // takes over once it mounts (briefly both are visible, acceptable).
    return {
      container: composerEl,
      insertBefore: actionsEl || composerSend,
      hide: () => { if (actionsEl) actionsEl.style.display = 'none'; },
      restore: () => { if (actionsEl) actionsEl.style.display = ''; },
    };
  }

  /** Auto-grow the composer textarea with content, capped at the CSS
   *  max-height (currently 40vh desktop / 30vh mobile — see app.css).
   *  Past the cap the textarea scrolls internally.
   *
   *  We read max-height from getComputedStyle each call so the JS cap
   *  stays in sync with CSS (no duplication of the 40vh/30vh constants).
   *  If max-height is `none` or unparseable we fall back to 40% of
   *  innerHeight, matching the desktop default.
   *
   *  Resize side-effect: growing the textarea shrinks transcript
   *  clientHeight. If the user was pinned to the live edge before the
   *  resize, re-pin afterwards so streaming content doesn't slide out of
   *  view as they type. */
  function autoResize() {
    const cs = window.getComputedStyle(composerInput);
    const parsed = parseFloat(cs.maxHeight);
    const cap = Number.isFinite(parsed) && parsed > 0
      ? parsed
      : Math.round(window.innerHeight * 0.4);
    const transcriptEl = document.getElementById('transcript');
    const wasPinned = transcriptEl
      ? (transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight) <= 80
      : false;
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, cap) + 'px';
    // Update --composer-height so the scroll-to-bottom button (which
    // anchors `bottom: calc(var(--composer-height) + 64px)`) tracks
    // the composer as it grows. Without this the button stays at the
    // 64px default and ends up overlapping the wrapped textarea text.
    const composerEl = composerInput.closest('.composer') as HTMLElement | null;
    if (composerEl) {
      const h = Math.round(composerEl.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--composer-height', `${h}px`);
    }
    if (wasPinned && transcriptEl) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
  }
  composerInput.addEventListener('input', () => { autoResize(); updateSendButtonState(); });

  // Paste image support — if the clipboard has an image (e.g. screenshot
  // copied via cmd+shift+4 then cmd+C, or any tool that puts an image
  // on the clipboard), add it to the pending attachments via the same
  // path as the attach/camera buttons. Text paste falls through to the
  // default textarea behavior.
  composerInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items as DataTransferItemList | undefined;
    if (!items) return;
    const mediaFiles = [];
    for (const item of items) {
      if (item.type?.startsWith('image/') || item.type?.startsWith('video/')) {
        const f = item.getAsFile();
        if (f) mediaFiles.push(f);
      }
    }
    if (mediaFiles.length === 0) return;
    e.preventDefault();  // suppress paste-as-text of binary gunk
    for (const f of mediaFiles) await attachments.add(f);
  });

  function sendTypedMessage() {
    const text = composerInput.value.trim();
    const hasAttachments = attachments.hasPending();

    if (text || hasAttachments) {
      if (!backend.isConnected()) {
        status.setStatus('Gateway offline', 'err');
        // Don't leave the mic hot after a blocked send — user expects
        // the UI to reset to a clean state when the gateway is down.
        releaseCaptureIfActive();
        return;
      }
      // Slash commands: route through slashCommands so the popover's
      // dispatch path AND the manually-typed-then-Enter path share one
      // codepath. slashCommands.dispatch fires onResetSignal (if the
      // command is /new, /reset, /clear) and then calls onDispatch
      // — which here is the bare-bones backend.sendMessage (no
      // optimistic bubble; the agent's reply IS the response).
      if (slashCommands.isCommand(text)) {
        slashCommands.dispatch(text);
        return;
      }
      // Atomic-bubble path (Q1): bubble starts `.pending`. On agent's
      // first reply_delta / typing the bubble flips to a normal user
      // line. On send-failure it flips to `.failed` with a Retry button
      // that restores the composer text and re-fires sendTypedMessage.
      //
      // Cross-device dedup: pre-mint a userMessageId and key the
      // optimistic bubble in renderedMessages with it. The same id
      // ships in the POST body → the upstream's user_message broadcast
      // carries it back → handleUserMessage upserts under the same key
      // and the renderedMessages map's idempotency gives us free dedup
      // on the originating device. Other devices see the id for the
      // first time and render fresh.
      const userMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const bubble = renderedMessages.upsert(userMessageId, {
        role: 'user',
        text: text || '',
        status: 'finalized',
        speaker: 'You',
        cls: 's0',
        source: 'text',
        attachments: hasAttachments ? attachments.toChatEcho() : undefined,
        pending: true,
      });
      const sendChatId = backend.getCurrentSessionId?.() ?? null;
      if (bubble && sendChatId) {
        const list = pendingBubblesByChat.get(sendChatId) || [];
        list.push(bubble);
        pendingBubblesByChat.set(sendChatId, list);
      }
      // Optimistic sidebar entry — show this chat in the drawer with
      // the user's text as the snippet IMMEDIATELY, before the agent
      // replies. Without this, the user fires off a message and the
      // drawer shows "New chat" with 0 msgs until the server-side turn
      // completes (which can be 30s+ on long tool-using turns). With
      // it, multiple back-to-back new chats stack as the user expects.
      // handleSessionAnnounced is idempotent: if the chat already has
      // a cached row OR a pending row, it no-ops. The server-side
      // session_changed envelope replaces the pending entry with the
      // canonical title later.
      if (sendChatId && text) {
        const snippet = text.slice(0, 80);
        sessionDrawer.handleSessionAnnounced({
          id: sendChatId,
          snippet,
          source: 'sidekick',
          started_at: new Date().toISOString(),
        });
      }
      const sendOpts: Record<string, any> = { userMessageId };
      if (hasAttachments) sendOpts.attachments = attachments.toSendPayload();
      // sendMessage is async (POST + await !res.ok rejection), so a
      // sync try/catch only catches the !connected synchronous throw.
      // Capture both via the promise's .catch — flips bubble → failed
      // and offers Retry, which restores `text` to the composer.
      const failBubble = (msg: string) => {
        diag(`sendMessage failed: ${msg}`);
        status.setStatus(`Send failed: ${msg}`, 'err');
        if (bubble) {
          chat.markBubbleFailed(bubble, {
            onRetry: () => {
              composerInput.value = text;
              autoResize();
              updateSendButtonState();
              composerInput.focus();
            },
          });
          if (sendChatId) {
            const list = pendingBubblesByChat.get(sendChatId);
            if (list) {
              const idx = list.indexOf(bubble);
              if (idx >= 0) list.splice(idx, 1);
            }
          }
        }
      };
      try {
        const sendPromise = backend.sendMessage(text, sendOpts);
        if (sendPromise && typeof (sendPromise as any).catch === 'function') {
          (sendPromise as Promise<unknown>).catch((e) => {
            const msg = (e as Error)?.message || String(e);
            failBubble(msg);
          });
        }
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        releaseCaptureIfActive();
        failBubble(msg);
        return;
      }
      // Tear down any in-progress capture (dictation, memo, call) BEFORE
      // we clear the textarea. Otherwise an in-flight STT final lands
      // into the cleared composer and pastes the user's just-sent
      // utterance back in. dictate.stop() marks the in-flight interim as
      // abandoned synchronously so the late-event filter catches anything
      // arriving during the provider-stop await.
      releaseCaptureIfActive();
      attachments.clear();
      playFeedback('send');
      composerInput.value = '';
      autoResize();
      updateSendButtonState();
    } else if (draft.hasContent()) {
      if (!backend.isConnected()) {
        status.setStatus('Gateway offline', 'err');
        releaseCaptureIfActive();
        return;
      }
      draft.flush();
    }
  }

  composerSend.onclick = sendTypedMessage;
  // Wire composer.submit() → same path as clicking send. Used by the
  // voice pipeline's auto-submit-on-silence loop (voice.ts).
  composer.init({
    input: composerInput,
    interim: document.getElementById('composer-interim'),
    onChange: updateSendButtonState,
    onSubmit: sendTypedMessage,
  });
  // Slash-command popover. Backend-declared registry, frontend-rendered
  // — see src/slashCommands.ts. The onResetSignal callback is the only
  // sidekick-side state callback (per design): main.ts owns the local
  // wipe, slashCommands owns the dispatch + popover. onDispatch here
  // is the bare-bones backend send (no optimistic bubble — the agent's
  // reply IS the response).
  slashCommands.init({
    input: composerInput,
    onDispatch: (cmdText) => {
      const hasAtt = attachments.hasPending();
      const opts = hasAtt ? { attachments: attachments.toSendPayload() } : {};
      try { backend.sendMessage(cmdText, opts); }
      catch (e: any) {
        const msg = e?.message || String(e);
        diag(`slash sendMessage failed: ${msg}`);
        status.setStatus(`Send failed: ${msg}`, 'err');
        releaseCaptureIfActive();
        return;
      }
      attachments.clear();
      playFeedback('send');
      composerInput.value = '';
      autoResize();
      updateSendButtonState();
    },
    onResetSignal: () => {
      // /new (and /reset, /clear aliases) trigger a SERVER-SIDE
      // session_reset: hermes mints a fresh session_id (agent forgets
      // prior context) but keeps the SAME chat_id (visible thread +
      // history preserved). The PWA used to wipe renderedMessages on
      // the slash, making history LOOK gone for the brief window
      // before the server fetch refilled the DOM (Jonathan, 2026-05-04
      // panicked "lost history!" then it reappeared).
      //
      // Right behavior: leave the rendered scroll alone. Drop a system
      // marker line that visually delimits the boundary between
      // "agent saw this above" and "agent forgot, fresh context below."
      // History scroll-back stays useful; user gets clear UX signal.
      diag('reset history: slash command');
      releaseCaptureIfActive();
      // NOT clearing renderedMessages / activityRow / historyLoaded —
      // those are about transcript identity, which doesn't change on
      // session_reset (chat_id stays the same).
      draft.dismiss();
      voiceMemos.clearAll().catch(() => {});
      chat.addLine(
        '',
        '— context reset, agent forgot prior turns —',
        'system',
        { source: 'sent' },
      );
    },
  });
  // Enter-key handling. Desktop: Enter sends, Shift+Enter newline (chat
  // convention). iOS (PWA + Cap): Enter inserts newline like a normal
  // textarea — soft keyboards don't have shift+enter, so binding Enter
  // to send leaves no easy way to add a line break. Send button is the
  // unambiguous send affordance on touch. Matches Gemini / ChatGPT iOS.
  // iPad with hardware keyboard is still iOS by UA — power users get
  // Cmd+Enter via the global handler below.
  const isIosComposer = /iPad|iPhone|iPod/.test(navigator.userAgent);
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isIosComposer) return;        // default = newline; tap send
      e.preventDefault();
      sendTypedMessage();
    }
  });

  // Global Cmd/Ctrl+Enter → send composer, UNLESS focus is in the draft
  // (draft has its own Cmd+Enter binding that flushes the draft). Matches
  // user's mental model: "Enter-family" always means send; which field
  // depends on where your focus is.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const target = document.activeElement as HTMLElement | null;
    // Draft textEl has its own handler (flushes the draft) — don't double-fire.
    if (target?.classList?.contains('draft-text')) return;
    // Avoid double-firing when focus is already in the composer — the
    // composer's own handler above catches plain Enter AND Cmd+Enter.
    if (target === composerInput) return;
    e.preventDefault();
    sendTypedMessage();
  });

  // Camera + attach — each triggers a hidden <input type=file>. On change,
  // attachments.add() reads the file + renders the chip. Send happens via
  // the existing composer-send path.
  const cameraInput = document.getElementById('camera-input') as HTMLInputElement | null;
  const attachInput = document.getElementById('attach-input') as HTMLInputElement | null;
  const btnCamera = document.getElementById('btn-camera') as HTMLButtonElement | null;
  const btnAttach = document.getElementById('btn-attach') as HTMLButtonElement | null;
  if (btnCamera && cameraInput) {
    btnCamera.onclick = () => {
      if (btnCamera.disabled) return;
      cameraInput.value = '';  // allow re-picking the same file
      cameraInput.click();
    };
    cameraInput.onchange = async () => {
      for (const f of Array.from(cameraInput.files || [])) await attachments.add(f);
    };
  }
  if (btnAttach && attachInput) {
    btnAttach.onclick = () => {
      if (btnAttach.disabled) return;
      attachInput.value = '';
      attachInput.click();
    };
    attachInput.onchange = async () => {
      for (const f of Array.from(attachInput.files || [])) await attachments.add(f);
    };
  }

  // Drag-and-drop attach on the whole main app area (everything to
  // the right of the drawer — transcript, the dark side gutters, and
  // the composer). Same gate as the + button: only accept when the
  // model (or its vision fallback) can process attachments.
  // attachments.add() validates each file's type + size internally
  // and surfaces errors via the status line.
  //
  // Counter pattern for dragenter/dragleave: bare booleans flicker
  // because dragleave fires every time the pointer crosses a child
  // boundary. Tracking depth keeps the highlight steady until the
  // pointer truly exits the area.
  const mainDropZone = document.querySelector('.main') as HTMLElement | null;
  if (mainDropZone) {
    let dragDepth = 0;
    const hasFiles = (e: DragEvent): boolean => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      // dataTransfer.types is a DOMStringList in older browsers; both
      // forms support `.includes`-style checks via Array conversion.
      for (const t of Array.from(types as any) as string[]) {
        if (t === 'Files') return true;
      }
      return false;
    };
    mainDropZone.addEventListener('dragenter', (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!hasFiles(dragEvent) || !canAttachFiles()) return;
      dragEvent.preventDefault();
      dragDepth += 1;
      mainDropZone.classList.add('drag-over');
    });
    mainDropZone.addEventListener('dragover', (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!hasFiles(dragEvent) || !canAttachFiles()) return;
      // preventDefault is required for `drop` to fire on this element.
      dragEvent.preventDefault();
      if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = 'copy';
    });
    mainDropZone.addEventListener('dragleave', (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!hasFiles(dragEvent)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) mainDropZone.classList.remove('drag-over');
    });
    mainDropZone.addEventListener('drop', async (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!hasFiles(dragEvent)) return;
      dragEvent.preventDefault();
      dragDepth = 0;
      mainDropZone.classList.remove('drag-over');
      if (!canAttachFiles()) {
        status.setStatus('Drop ignored — selected model does not support attachments', 'err');
        return;
      }
      const files = Array.from(dragEvent.dataTransfer?.files || []);
      for (const f of files) await attachments.add(f);
    });
  }

  // Image-upload UI is gated on the selected model's vision capability.
  // Ground truth is hermes's models.dev registry, surfaced via the
  // plugin endpoint `/v1/sidekick/model-capabilities`. The proxy at
  // `/api/sidekick/model-capabilities?model=<id>` is a thin pass-through
  // with a 60s memo. We fetch on demand per-model instead of holding a
  // bulk map; the result is cached in module memory keyed by model id.
  //
  // Hermes auto-routes media_urls through `_enrich_message_with_vision`
  // → `vision_analyze_tool` → `auxiliary.vision` (gateway/run.py:6051),
  // so even text-only primaries can accept attachments end-to-end. The
  // plugin's `/v1/sidekick/auxiliary-models` (proxied at
  // `/api/sidekick/auxiliary-models`) advertises the configured
  // fallback; null when none is set.
  type ModelCaps = {
    known: boolean;
    supports_vision: boolean;
    supports_tools: boolean;
    supports_reasoning: boolean;
    context_window: number;
    max_output_tokens: number;
    model_family: string;
  };
  const capsByModel = new Map<string, ModelCaps>();
  const capsInFlight = new Map<string, Promise<ModelCaps | null>>();
  let visionFallbackModel: string | null = null;
  let auxiliaryReady: Promise<void> | null = null;
  // Auxiliary vision advertisement — separate from per-model caps because
  // it's config-driven on the hermes side, not model-driven. Thin pass-
  // through to the plugin's /v1/sidekick/auxiliary-models via the proxy
  // at /api/sidekick/auxiliary-models.
  function ensureAuxiliaryFetched(): Promise<void> {
    if (auxiliaryReady && visionFallbackModel !== null) return auxiliaryReady;
    auxiliaryReady = (async () => {
      try {
        const res = await fetch('/api/sidekick/auxiliary-models', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json() as { vision?: string | null };
        if (typeof body?.vision === 'string' || body?.vision === null) {
          visionFallbackModel = body.vision ?? null;
        }
        updateAttachButtonsState();
      } catch {
        // Network blip — the gate stays disabled until the next retry.
      }
    })();
    return auxiliaryReady;
  }
  async function fetchModelCaps(modelId: string): Promise<ModelCaps | null> {
    if (!modelId) return null;
    const cached = capsByModel.get(modelId);
    if (cached) return cached;
    const inflight = capsInFlight.get(modelId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const res = await fetch(
          `/api/sidekick/model-capabilities?model=${encodeURIComponent(modelId)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return null;
        const body = await res.json() as Partial<ModelCaps> & { known?: boolean };
        const caps: ModelCaps = {
          known: !!body.known,
          supports_vision: !!body.supports_vision,
          supports_tools: !!body.supports_tools,
          supports_reasoning: !!body.supports_reasoning,
          context_window: typeof body.context_window === 'number' ? body.context_window : 0,
          max_output_tokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : 0,
          model_family: typeof body.model_family === 'string' ? body.model_family : '',
        };
        capsByModel.set(modelId, caps);
        return caps;
      } catch {
        return null;
      } finally {
        capsInFlight.delete(modelId);
      }
    })();
    capsInFlight.set(modelId, p);
    return p;
  }
  function primaryModelHasVision(modelId: string): boolean {
    if (!modelId) return false;
    const caps = capsByModel.get(modelId);
    // Conservative on cache miss: don't claim vision before we've heard
    // back. updateAttachButtonsState re-runs once the fetch resolves.
    return !!caps && caps.known && caps.supports_vision;
  }
  function isVisionCapableModel(modelId: string): boolean {
    return primaryModelHasVision(modelId) || !!visionFallbackModel;
  }
  // Single source of truth for "is the user allowed to attach files
  // right now?" — read by both the +button gate and the main-area
  // drag-drop handler. Future role checks / feature flags fold in here.
  function canAttachFiles(): boolean {
    const modelId = String(agentSettingsMod.getCurrentValue('model') ?? '');
    return isVisionCapableModel(modelId);
  }
  function updateAttachButtonsState(): void {
    const modelId = String(agentSettingsMod.getCurrentValue('model') ?? '');
    // Kick the per-model fetch (idempotent if already cached/in-flight);
    // when it lands the function re-runs to update the tooltip.
    if (modelId && !capsByModel.has(modelId)) {
      void fetchModelCaps(modelId).then(() => updateAttachButtonsState());
    }
    const primaryVision = primaryModelHasVision(modelId);
    const enabled = primaryVision || !!visionFallbackModel;
    // Tooltip distinguishes the three states so the user knows which
    // path their image is taking — direct multimodal vs. auxiliary
    // enrichment vs. unsupported. Hermes routes via auxiliary when the
    // primary doesn't support vision, see _enrich_message_with_vision.
    let attachTitle: string;
    let cameraTitle: string;
    if (primaryVision) {
      attachTitle = 'Attach image';
      cameraTitle = 'Take photo';
    } else if (visionFallbackModel) {
      attachTitle = `Attach image — will route through ${visionFallbackModel}`;
      cameraTitle = `Take photo — will route through ${visionFallbackModel}`;
    } else {
      attachTitle = `Image upload — selected model (${modelId || 'none'}) doesn't support vision and no auxiliary vision model is configured`;
      cameraTitle = `Camera — selected model (${modelId || 'none'}) doesn't support vision and no auxiliary vision model is configured`;
    }
    if (btnAttach) {
      btnAttach.disabled = !enabled;
      btnAttach.title = attachTitle;
    }
    if (btnCamera) {
      btnCamera.disabled = !enabled;
      btnCamera.title = cameraTitle;
    }
  }
  // Run once whenever the schema loads + on every setting change. The
  // schema-loaded event fires from agentSettings.load after a successful
  // /v1/settings/schema response; the setting-changed event fires after
  // a successful POST /v1/settings/{id} round-trip.
  window.addEventListener('agent-schema-loaded', () => {
    ensureAuxiliaryFetched();
    updateAttachButtonsState();
  });
  window.addEventListener('agent-setting-changed', () => {
    // Model may have changed — clear the cache so we re-fetch fresh
    // caps on the next gate evaluation.
    capsByModel.clear();
    updateAttachButtonsState();
  });
  // Tab-visibility return: re-fetch the auxiliary model advertisement
  // (user may have edited hermes config while the PWA was backgrounded).
  // Per-model caps invalidate via their 60s server-side memo.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      auxiliaryReady = null;
      visionFallbackModel = null;
      ensureAuxiliaryFetched();
    }
  });
  // Initial pass.
  updateAttachButtonsState();
  ensureAuxiliaryFetched();

  // Surface a system line in the live chat when the model changes via
  // the settings panel — same pattern as the cli's `/model` confirmation.
  // Lists declared input modalities so the user knows whether image /
  // pdf / audio inputs will work without trial-and-error.
  window.addEventListener('agent-setting-changed', (e: Event) => {
    const detail = (e as CustomEvent).detail || {};
    if (detail.id !== 'model') return;
    const modelId = String(detail.value || '');
    if (!modelId) return;
    // Resolve modalities from the live caps lookup. If models.dev knows
    // the model, label is "text" or "text, image" based on supports_vision;
    // otherwise fall back to "text" plus a note if vision_fallback_model
    // is configured (hermes will route via auxiliary).
    void fetchModelCaps(modelId).then(caps => {
      let inputs: string;
      if (caps && caps.known) {
        inputs = caps.supports_vision ? 'text, image' : 'text';
      } else if (visionFallbackModel) {
        inputs = `text  ·  images route via ${visionFallbackModel}`;
      } else {
        inputs = 'text  ·  capability unknown to models.dev';
      }
      chat.addSystemLine(`Model: ${modelId} — accepts ${inputs}`);
    });
  });

  // New-chat button — lives in the sidebar now (#sb-new-chat). Works for
  // every backend, regardless of whether it supports session browsing,
  // since newSession is just a conversation-name rotation. /new slash
  // command is a separate path handled by sendTypedMessage.
  const btnNewChat = document.getElementById('sb-new-chat');
  if (btnNewChat) {
    btnNewChat.onclick = async () => {
      if (!backend.isConnected()) { status.setStatus('Gateway offline', 'err'); return; }
      // No-op if there's already an active chat AND it's empty (no
      // real bubbles rendered). Without this guard, rapid new-chat
      // clicks accumulate empty 'New chat / 0 msgs' rows in the drawer
      // for every press. Skip the guard on first-ever click (no
      // active chat yet) so a fresh install still mints one.
      const transcriptEl = document.getElementById('transcript');
      const hasContent = transcriptEl
        ? transcriptEl.querySelectorAll('.line.s0, .line.agent').length > 0
        : false;
      const hasActiveChat = !!backend.getCurrentSessionId?.();
      if (hasActiveChat && !hasContent) {
        diag('new-chat: current chat empty, no-op');
        return;
      }
      diag('reset history: new-chat button');
      // Intentionally do NOT stop streaming or cancel memo — new-chat is a
      // conversation rotation, not a full reset. Users expect to stay in
      // whatever audio mode they were in (streaming stays green, memo bar
      // stays open if open). If memo has an in-flight blob queued in the
      // outbox, it'll send against the NEW session. That's a conscious
      // trade: user asked for a fresh thread, they get one.
      renderedMessages.clear();
      activityRow.clearAll();
      draft.dismiss();
      voiceMemos.clearAll().catch(() => {});
      // Clear remaining input surfaces atomically. Without this,
      // typed-but-unsent text survives the new-chat click and
      // prepends to the next typed message. Synthetic `input` event
      // re-runs autoResize + updateSendButtonState in one go.
      composerInput.value = '';
      composerInput.dispatchEvent(new Event('input'));
      attachments.clear();
      historyLoaded = false;
      // newSession is async — it mints a chat_id and awaits an IDB write.
      // Without awaiting, getCurrentSessionId() below returns the PRIOR
      // activeChatId (or null), setViewed pins to that, and the next
      // reply's chat_id mismatches the viewed gate → handleReplyDelta /
      // handleReplyFinal early-return → nothing renders. User sees
      // "sending…" forever despite the agent replying server-side.
      await backend.newSession?.();
      chat.addSystemLine('New chat started');
      // Pin the viewed-session to the freshly-rotated chat_id. Invariant:
      // getViewed() mirrors the session on screen so handleReplyDelta /
      // handleReplyFinal don't drop incoming envelopes for it.
      sessionDrawer.setViewed(backend.getCurrentSessionId?.() || null);
      // New chat is always sidekick-source; ensure composer is enabled
      // (in case user just rotated away from a non-sidekick chat).
      setComposerReadOnly(false);
      // Re-render the session list so the old session row loses its
      // active highlight (new one isn't in response_store.db yet —
      // the optimistic placeholder row covers it).
      sessionDrawer.refresh();
      // No auto-cleanup of empty drawer rows. Removed 2026-05-05 after
      // confirmed data loss: at least 2 sidekick sessions
      // (20260430_092241_ff0bada3 "Series A pitch deck init",
      // 20260501_062917_89254e19 "YouTube investment memo") were wiped
      // by this sweep when their messageCount transiently read 0 during
      // hermes session-rotation/compression. Reaches into server state
      // for "tidiness" — a backend-destructive optimization with no
      // user signal. Hard rule (Jonathan): sidekick never auto-deletes
      // server-side data. Stale empty rows live in the drawer until the
      // user removes them via the row menu (which has a confirm dialog).
      // On mobile, collapse the sidebar so the user sees the fresh chat —
      // otherwise the expanded drawer hides the transition and the action
      // feels like it didn't land. Desktop keeps the drawer open (session
      // browsing is a natural follow-up to starting a new chat on wider
      // screens).
      const sidebar = document.getElementById('sidebar');
      if (sidebar && window.innerWidth < 700) {
        sidebar.classList.remove('expanded');
        sidebar.classList.add('collapsed');
        sidebar.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('sidebar-expanded');
      }
    };
  }

  updateSendButtonState();  // initial state

  // ── Voice input — unified composer mic ────────────────────────────────
  // ONE button (#btn-mic) drives all four voice modes. The chevron menu
  // exposes three orthogonal toggles (PTT / call / auto-send) that
  // determine what happens when the user taps or holds the mic. See
  // the mic-mode dropdown wiring further down.
  const btnMic = document.getElementById('btn-mic');

  function exitMemoMode() {
    memoActive = false;
    log('[mic-diag] memoActive=false (exitMemoMode)');
    // Restore the composer-actions row + put the send button back in its
    // original DOM home (last child of .composer-actions-right). The bar
    // itself is removed by memo.cleanup(). Re-query each time since the
    // composer DOM is stable but the const lived in the onclick scope.
    // Note: textarea + btnMic stay visible during memo (bottom-row-only
    // memo bar UX), so no display:'' to reset here.
    const composerEl2 = composerInput.parentElement;
    const actionsEl = composerEl2?.querySelector('.composer-actions') as HTMLElement | null;
    const actionsRightEl = composerEl2?.querySelector('.composer-actions-right') as HTMLElement | null;
    if (actionsEl) actionsEl.style.display = '';
    // Only reparent if the send button got moved into the bar (it may
    // already be in its home if memo.start failed before renderBar).
    if (actionsRightEl && composerSend.parentElement !== actionsRightEl) {
      actionsRightEl.appendChild(composerSend);
    }
    composerSend.onclick = sendTypedMessage;
    // Clear voice-state classes on the mic button when memo dismisses.
    // .active is also flipped via voiceActive() polling indirectly, but
    // explicit removal here keeps the visual in sync without waiting.
    if (btnMic) {
      btnMic.classList.remove('active', 'listening');
    }
    updateSendButtonState();
  }

  // Tracks the in-flight /transcribe upload size (bytes) so the periodic
  // status refresher can surface "Uploading audio (NKB)…" while the
  // request is on the wire. Field bug 2026-05-02: 14-22s queue→flush
  // window was completely silent, leaving the user wondering if anything
  // was happening between "queued" and the eventual transcript landing
  // in the composer. null = no upload in flight; the refresher falls
  // back to its normal connected/stalled narrative.
  let uploadInFlightBytes: number | null = null;

  /** Flush queued audio items — update the corresponding memo cards with transcripts. */
  async function flushOutbox() {
    const result = await queue.flush(
      async (text) => { backend.sendMessage(text); },
      async (blob, mimeType, id, autoSend) => {
        // Timeout scales with blob size: small memos under 1MB ≈ minute or
        // less of audio (Deepgram batch returns in 1-3s) get the snappy
        // 15s budget. Larger blobs get 60s — the upload alone for a 5MB
        // webm over Tailscale can take 5-10s, plus Deepgram batch latency
        // grows roughly with audio length. Earlier 15s flat ceiling
        // wedged 3-minute memos in permanent-retry: each attempt timed
        // out before Deepgram could respond, queue never drained.
        const timeoutMs = blob.size > 1_000_000 ? 60_000 : 15_000;
        // Per-user keyterm biasing for batch transcribe. Same IDB list the
        // WebRTC offer ships; bridge accepts repeated `?keyterms=…&keyterms=…`
        // and merges into the Deepgram spec like the streaming path does.
        // Without this, memo-mode transcription runs un-biased even if the
        // user has chips configured (was the case for "clawdian" miss).
        let kt: string[] = [];
        try {
          const { readList } = await import('./keyterms.ts');
          kt = (await readList()) || [];
        } catch {}
        const url = kt.length
          ? `/transcribe?${kt.map(t => 'keyterms=' + encodeURIComponent(t)).join('&')}`
          : '/transcribe';
        let res;
        // Surface "Uploading audio (NKB)…" immediately + via the
        // periodic refresher (which prefers uploadInFlightBytes when
        // set). Cleared in finally so success/timeout/error all reset
        // the indicator. fetchWithTimeout doesn't expose progress
        // events, so this is indeterminate by design — just enough
        // to tell the user "stop tapping, it's working."
        uploadInFlightBytes = blob.size;
        const kb = Math.round(blob.size / 1024);
        status.setStatus(`Uploading audio (${kb} KB)…`, 'live');
        try {
          try {
            res = await fetchWithTimeout(url, {
              method: 'POST', headers: { 'Content-Type': mimeType }, body: blob,
              timeoutMs,
            });
          } catch (e) {
            if (e instanceof TimeoutError) {
              // Surface + chime; blob stays in queue for retry on next
              // reconnect. The card moves to queued(⏳) so the user sees
              // something is pending.
              log('transcribe timeout — blob stays queued for retry');
              const transcriptEl = document.getElementById('transcript');
              const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;
              if (card) memoCard.update(card, { status: 'queued' });
              playFeedback('error');
            }
            throw e;  // re-throw so queue.flush keeps the item
          }
        } finally {
          uploadInFlightBytes = null;
        }
        const data = await res.json();
        if (!data.ok) {
          // Distinguish PERMANENT failures (corrupt blob, unsupported
          // format, Deepgram 400) from TRANSIENT (network, 5xx, timeout).
          // Permanent: drop from queue so we don't retry forever.
          // Transient: throw, queue.flush keeps the item for next round.
          //
          // Symptom: queued audio memos all fail with "deepgram 400
          // corrupt or unsupported data" on each retry — typically
          // blobs recorded while the iOS mic-perm dialog was up
          // (silent / partial). Without this guard the outbox grows
          // unbounded.
          const err = String(data.error || 'transcription failed');
          const isPermanent = /\b4\d\d\b|corrupt|unsupported|empty body/i.test(err);
          if (isPermanent) {
            log('transcribe: permanent failure, dropping blob:', err);
            const transcriptEl = document.getElementById('transcript');
            const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;
            const note = '(audio unprocessable)';
            if (card) memoCard.update(card, { transcript: note, status: 'failed' });
            try { await voiceMemos.update(id, { transcript: note, status: 'failed' }); } catch {}
            playFeedback('error');
            return;  // don't throw — queue.flush will drop the item
          }
          throw new Error(err);  // transient → keep in queue
        }
        const text = (data.transcript || '').trim();
        const transcriptEl = document.getElementById('transcript');
        const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;

        // Empty transcript — /transcribe succeeded but heard nothing
        // (silent clip / inaudible). Surface that on the card so the user
        // isn't left staring at an orphan row. Persist the status so a
        // reload doesn't restore it as pending again.
        if (!text) {
          const note = '(no speech detected)';
          if (card) memoCard.update(card, { transcript: note, status: 'failed' });
          await voiceMemos.update(id, { transcript: note, status: 'failed' });
          return;
        }

        // Routing depends on the per-memo autoSend flag captured at
        // record time (settings.micAutoSend at the moment startMemo()
        // was called). autoSend=true → append to composer (so any
        // already-typed text is preserved) and immediately submit;
        // autoSend=false → just append, leaving the user to review +
        // send manually. Both paths converge through composer.appendText
        // → composer.submit, which is the same codepath as clicking Send.
        if (card) card.remove();
        await voiceMemos.remove(id);
        composer.appendText(text);
        if (autoSend) {
          composer.submit();
        }
      }
    );
    if (result.skipped) diag('outbox: flush skipped (already flushing)');
    else if (result.sent > 0) log('outbox: flushed', result.sent, 'queued messages');
    return result;
  }

  // Periodic background retry. Covers the scenario where /transcribe
  // fails mid-memo (blob queued) but the gateway WS stays connected —
  // no reconnect event fires, no user send happens. Without this, a
  // queued blob sits until the next reload or user action. Poll is
  // cheap (IDB read + early-out if empty); only flushes when there's
  // pending work AND the gateway is reachable.
  setInterval(async () => {
    try {
      const pending = await queue.pending();
      if (pending > 0 && backend.isConnected()) {
        diag(`outbox: periodic retry (${pending} pending)`);
        flushOutbox().catch(() => {});
      }
    } catch {}
  }, 30_000);

  // Periodic network-status refresh. Surfaces queued count + weak-signal
  // detection in the header. Only writes when there's no active WebRTC
  // call (controls.ts owns the call-status narrative).
  const WEAK_SIGNAL_MS = 8_000;
  setInterval(async () => {
    if (webrtcControls.isOpen()) return;
    try {
      const gwConnected = backend.isConnected();
      const summary = await queue.summary();
      // Idle cursor — wall-clock ms since /api/sidekick/stream last
      // delivered ANY envelope. EventSource can stay "connected" while
      // the underlying TCP connection is dead (cellular handoff,
      // suspended radio). Combined with queued outbound, a long idle
      // window is the signal that we're stalled. msSinceLastEnvelope()
      // returns 0 on fresh connect → treated as "no signal yet."
      //
      // The pre-refactor openclaw path also surfaced a `weakSignal`
      // state (idle stream, no queue, ambiguously-iffy network). We
      // intentionally don't recreate that here: the SSE channel is
      // sparse by design — an idle drawer browse can go minutes
      // without an envelope and that's normal — so a `weakSignal`
      // fire on idle would be a constant false positive. Stalled
      // (idle + queued outbound) IS unambiguous and stays.
      const msIdle = backend.msSinceLastEnvelope();
      // Upload-in-flight wins over the connectivity narrative — the
      // user wants to see "uploading" until the request lands, even
      // if the gateway briefly looks idle. Without this the 2s
      // refresher would clobber the "Uploading…" pill back to
      // "Connected" within a tick.
      if (uploadInFlightBytes != null) {
        const kb = Math.round(uploadInFlightBytes / 1024);
        status.setStatus(`Uploading audio (${kb} KB)…`, 'live');
      } else if (!gwConnected) {
        status.setState('reconnecting', { queuedCount: summary.count, queuedAudioMs: summary.totalAudioMs });
      } else if (msIdle > WEAK_SIGNAL_MS && summary.count > 0) {
        status.setState('stalled', { queuedCount: summary.count, queuedAudioMs: summary.totalAudioMs });
      } else {
        status.setState('connected', {
          queuedCount: summary.count,
          queuedAudioMs: summary.totalAudioMs,
        });
      }
    } catch {}
  }, 2_000);

  /** Save blob to IDB + enqueue for retry + render a placeholder memo card
   *  in chat. Always runs on record stop, regardless of online/offline —
   *  gives the user immediate visual feedback during the quiet
   *  transcription window. Returns {id, card, rec}. autoSend is stored
   *  on the queue item so flushOutbox can route correctly even when the
   *  flush happens minutes later (periodic retry / reconnect). */
  async function renderMemoCard(audioBlob, durationMs, autoSend = false) {
    // Hard ceiling: the bridge accepts up to 25MB at /v1/transcribe and
    // the proxy mirrors that. webm voice is ~30KB/s so 25MB ≈ 14 min.
    // Anything larger gets DROPPED here with a status warning rather
    // than queued — a too-big blob in the outbox just retries forever
    // and blocks the channel for smaller subsequent memos. User can
    // re-record in shorter chunks. Threshold is intentionally a few
    // hundred KB below the 25MB limit so an upload-time encoding bump
    // doesn't push a borderline blob over.
    const MEMO_MAX_BYTES = 24 * 1024 * 1024;
    if (audioBlob.size > MEMO_MAX_BYTES) {
      const mb = (audioBlob.size / (1024 * 1024)).toFixed(1);
      const mins = Math.round((durationMs ?? 0) / 60000);
      log(`memo: too big (${mb}MB ≈ ${mins}min) — dropped, would block the queue`);
      status.setStatus(
        `Memo too long (${mins}m) — dropped. Try shorter chunks.`,
        'err',
      );
      try { playFeedback('error'); } catch {}
      return { id: null, card: null, rec: null };
    }

    const id = crypto.randomUUID();
    const transcriptEl = document.getElementById('transcript');

    const rec = {
      id, blob: audioBlob, mimeType: audioBlob.type, durationMs,
      waveform: new Float32Array(40),
      transcript: null, status: 'pending', timestamp: Date.now(),
    };

    let card = null;
    if (transcriptEl) {
      card = memoCard.render(transcriptEl, rec);
      chat.autoScroll();
    }

    await voiceMemos.save(rec);
    await queue.enqueue({ id, type: 'audio', blob: audioBlob, mimeType: audioBlob.type, durationMs, autoSend });
    log('memo: queued audio blob (' + Math.round(audioBlob.size / 1024) + 'KB) autoSend=' + autoSend);

    // Background waveform extraction
    voiceMemos.extractWaveform(audioBlob).then(bars => {
      if (card) {
        const anyCard = card as any;
        if (anyCard._setWaveform) anyCard._setWaveform(bars);
      }
      voiceMemos.update(id, { waveform: Array.from(bars) }).catch(() => {});
    }).catch(e => log('memo: waveform extract failed:', e.message));

    return { id, card };
  }

  async function handleMemoResult(audioBlob: Blob, durationMs?: number, autoSend = false, path = 'unknown') {
    // Diagnostic for the iOS PTT auto-send bug — echoes the captured
    // autoSend flag + which release path triggered this finish, so
    // future regressions are debuggable from the JS console without
    // having to instrument startMemo from scratch.
    log(`memo finish: path=${path} autoSend=${autoSend} blob=${audioBlob ? Math.round(audioBlob.size/1024)+'KB' : 'null'}`);
    if (!audioBlob) return;
    // Always render the placeholder card + enqueue the blob, regardless
    // of connectivity. Matches the "user gets immediate visual feedback"
    // UX spec and keeps ONE processing path (flushOutbox) whether we're
    // online or offline.
    const { card } = await renderMemoCard(audioBlob, durationMs, autoSend);

    const offline = navigator.onLine === false || !backend.isConnected();
    if (offline) {
      if (card) memoCard.update(card, { status: 'queued' });
      status.setStatus('Audio queued — will transcribe when connected');
      return;
    }

    // Single transcribe path: flushOutbox iterates the queue serially
    // (for/await loop + isFlushing mutex), calls /transcribe per item,
    // routes to composer / chat based on autoSend setting, updates the
    // card. Rapid-fire memos all land here — mutex serializes them so
    // composer-append order matches record order, no duplicates.
    //
    // Earlier architecture had a second "live" transcribeChain that
    // raced with this: both paths fetched /transcribe for the same
    // blob, both appended, producing duplicates ("1 1 2 3 2 3" pattern
    // the user reported). Now there's only one path.
    flushOutbox().catch(() => {});
  }

  // ── Cursor-aware dictation (call=true, autoSend=false) ─────────────
  // webrtcDictate is the live-streaming + cursor-aware injection module.
  // init() binds the textarea + wires its user-input/cursor listeners.
  webrtcDictate.init(composerInput);
  let dictateActive = false;
  webrtcDictate.setStateListener((opening, error) => {
    dictateActive = opening;
    if (btnMic) {
      btnMic.classList.toggle('active', opening);
      // Clear the "actually listening" pulse on stop. It's added by the
      // bridge's {type: 'listening'} envelope when STT goes hot; we
      // proactively remove on stop so the close transition reads
      // cleanly instead of waiting for a final paint.
      if (!opening) btnMic.classList.remove('listening');
    }
    if (error) {
      status.setStatus(`Dictate error: ${error}`, 'err');
    } else if (opening) {
      status.setStatus('Listening — speak; tap mic / Send / Esc to stop', 'live');
      // Audible "your turn" cue — same chime call mode plays from the
      // bridge's listening envelope. Dictate doesn't go through the
      // bridge so we fire it directly when the provider reports
      // opening. Matches the chime vocabulary across modes (Jonathan,
      // 2026-05-04 UX nit: "no chime for dictate when listening").
      try { playFeedback('listening'); } catch { /* feedback is best-effort */ }
    } else {
      status.setStatus('');
    }
    updateSendButtonState();
  });

  // ── Composer voice dispatch ─────────────────────────────────────────
  //
  // Two-button split (2026-05): btn-mic owns memo + dictation, btn-call
  // owns calls. Each button has its own settings:
  //
  //   btn-mic:  settings.streaming    false=memo,           true=dictation
  //             settings.micAutoSend  false=land in composer, true=auto-send
  //
  //   btn-call: settings.realtime     false=turn-based,     true=WebRTC
  //             settings.tts          false=stream mode,    true=talk mode
  //                                                         (call-only)
  //
  // The four primitives below (startMemo, startDictate, startListen,
  // startCallStream) are mode-pure; the dispatch helpers (startMicMode,
  // startCallMode) read the relevant settings AT TAP TIME so flipping
  // the menu mid-session takes effect on the next tap without a
  // teardown. Each primitive is idempotent: starting a mode while the
  // mic is held by another mode tears that mode down first.

  /** Start memo mode (recording bar + MediaRecorder → blob).
   *  Returns false if mic acquisition fails. autoSend determines whether
   *  the resulting transcript routes via composer or auto-dispatches —
   *  threaded into handleMemoResult / flushOutbox.
   *
   *  UI shape: only the BOTTOM row of the composer swaps to the waveform
   *  bar. The textarea above stays visible (existing typed text remains
   *  in view; on memo completion the transcript appends at the cursor
   *  for autoSend=false, or appends + sends together for autoSend=true).
   *  The send button is moved into the memo bar so it stays right-anchored. */
  async function startMemo(autoSend: boolean): Promise<void> {
    if (memoActive) return;
    if (dictateActive) await webrtcDictate.stop();
    if (webrtcControls.isOpen()) await webrtcControls.closeIfOpen();
    // iOS AVAudioSession prep: prepareForCapture before getUserMedia.
    primeAudio(player);
    audioSession.prepareForCapture();
    memoActive = true;
    log('[mic-diag] memoActive=true (startMemo)');
    updateSendButtonState();
    composerSend.onclick = async () => {
      if (composerSend.disabled) return;
      composerSend.disabled = true;
      try {
        const { audioBlob, durationMs } = await memo.stop();
        exitMemoMode();
        await handleMemoResult(audioBlob, durationMs, autoSend, 'composerSend.click');
      } finally {
        composerSend.disabled = false;
      }
    };
    const mount = enterComposerBarMount();
    // Hide composer-actions synchronously alongside the bar mount so
    // there's no frame where both stack in the flex column (the brief
    // "extra row" composer jump). The bar itself mounts inside
    // memo.start() before any await — see memo.ts:67 — so the user
    // never sees an empty composer; the bar's empty-waveform shows
    // until the analyser attaches. (Reverts the deferred-hide rationale
    // from 2026-05-05.) exitMemoMode restores it on failure.
    mount?.hide();
    const ok = await memo.start({
      container: mount?.container,
      insertBefore: mount?.insertBefore || composerSend,
      sendBtn: composerSend,
      onDone: (audioBlob) => {
        exitMemoMode();
        handleMemoResult(audioBlob, undefined, autoSend, 'memo.onDone');
      },
      onCancel: () => {
        exitMemoMode();
      },
    });
    if (!ok) {
      exitMemoMode();
      status.setStatus('Mic not available', 'err');
      return;
    }
  }

  /** Start cursor-aware live dictation (call=true, autoSend=false).
   *
   *  `initialCursor` is the textarea selectionStart captured at the
   *  user's gesture site (mic-button pointerdown / hotkey handler)
   *  BEFORE focus shifted off the textarea. Without it, the first
   *  interim's anchor capture reads selectionStart on a possibly-
   *  blurred textarea — which on iOS Safari can return 0 (text lands
   *  at start) or value.length (text lands at end), and the visible
   *  caret then jumps to whatever setCursor was given. See dictate.ts
   *  ensureAnchor for the full anchor-source priority chain. */
  async function startDictate(initialCursor: number | null = null): Promise<void> {
    if (dictateActive) return;
    if (memoActive) return;
    // streamingEngine === 'local' uses browser Web Speech (Chrome/Safari);
    // it's typically reachable even when navigator.onLine reports false
    // since most browsers cache enough to keep recognising. Skip the
    // memo fallback for the local engine — fall through to the speech
    // start, which throws cleanly if Web Speech is genuinely unavailable.
    const useLocalEngine = settings.get().streamingEngine === 'local';
    if (!navigator.onLine && !useLocalEngine) {
      status.setStatus('Offline — using memo mode', null);
      await startMemo(false);
      return;
    }
    primeAudio(player);
    audioSession.prepareForCapture();
    try {
      // Engine selector — server (default) routes the WebRTC bridge;
      // local uses the in-browser SpeechRecognition path. Both are
      // STTProvider impls so dictate.ts's cursor-aware splice machine
      // stays the single owner of the textarea state.
      const provider = browserDictate.pickStreamingProvider();
      await webrtcDictate.start({
        sessionId: sessionDrawer.getViewed() || backend.getCurrentSessionId?.() || null,
        initialCursor,
        provider,
      });
    } catch (e: any) {
      diag('dictate start failed', e?.message);
      status.setStatus(`Dictate failed: ${e?.message ?? e}`, 'err');
    }
  }

  async function stopDictate(): Promise<void> {
    if (!dictateActive) return;
    await webrtcDictate.stop();
  }

  /** Start live chat-bubble streaming (call=true, autoSend=true). The
   *  existing webrtcControls + dictation.ts wiring handles the rest:
   *  silence/commit-phrase auto-dispatch, user/agent bubble rendering. */
  async function startCallStream(): Promise<void> {
    if (memoActive) return;
    if (dictateActive) await webrtcDictate.stop();
    if (webrtcControls.isOpen()) return;
    // Prime audio inside the gesture (pointerdown → startVoice →
    // startCallStream) — without this the shared AudioContext stays
    // null on iOS and feedback.ts falls back to a suspended private
    // ctx. Result: the bridge's first {type:'listening'} envelope
    // arrives but playFeedback('listening') silently no-ops on iOS.
    // Symmetric with startMemo/startDictate which already prime.
    primeAudio(player);
    // Stop any text-mode TTS playback before the WebRTC peer track
    // takes over the speaker — otherwise the two compete on the
    // same audio output.
    cancelReplyTts();
    audioSession.prepareForCapture();
    // openCall picks the mode per the user's settings.tts preference at
    // open time — same behavior as the old toolbar mic, just invoked
    // from the composer.
    //
    // Talk mode requires bridge-side TTS over the WebRTC peer track.
    // When ttsEngine === 'local' (browser speechSynthesis), the bridge
    // wouldn't be the audio source — there's nothing for the call's
    // outbound audio path to carry. Force stream mode in that case so
    // the user gets text replies + can use the per-bubble play button
    // (which honors ttsEngine='local'). Set 2026-05-03 v0.401.
    const sx = settings.get() as any;
    const wantTalk = sx.tts && sx.ttsEngine !== 'local';
    const mode: 'stream' | 'talk' = wantTalk ? 'talk' : 'stream';
    try {
      await webrtcControls.openCall(mode);
    } catch (e: any) {
      diag('call open failed', e?.message);
    }
  }

  async function stopCallStream(): Promise<void> {
    if (!webrtcControls.isOpen()) return;
    await webrtcControls.closeIfOpen();
  }

  // ── Listen mode (turn-based handsfree) ─────────────────────────────
  // Listen is the third handsfree mic mode: records locally with
  // MediaRecorder (like memo), commits the buffered blob to /transcribe
  // on silence (Phase 1) or sendword (Phase 2), drops the transcript
  // into the composer, auto-submits, then re-arms after reply playback.
  // Lives alongside Talk/Stream — never replaces them.
  let listenActive = false;
  async function startListen(): Promise<void> {
    if (listenActive) return;
    if (memoActive) return;
    if (dictateActive) await webrtcDictate.stop();
    if (webrtcControls.isOpen()) await webrtcControls.closeIfOpen();
    primeAudio(player);
    audioSession.prepareForCapture();
    // Mount the recorder bar via the shared helper — same place memo
    // uses, identical hide/restore semantics for the composer-actions
    // row. Reuses recorderBar.mount under the hood for visual parity.
    const mount = enterComposerBarMount();
    // Hide composer-actions synchronously alongside the bar mount so
    // there's no frame where both stack in the flex column. Same
    // rationale as startMemo — the bar's recorderBar.mount runs before
    // any await so the user sees the bar (with empty waveform) rather
    // than an empty composer.
    mount?.hide();
    // Move btn-mic into the bar's right-end slot so the user has a
    // visible "end call" affordance (mirrors how memo embeds the send
    // button). The btn-mic's existing pointer handlers in main.ts
    // already do the right thing on click while listenActive: route
    // through stopVoice → stopListen. The .listening / .active CSS
    // classes give it the red end-call appearance.
    const btnMicOriginalParent = btnMic?.parentElement || null;
    const btnMicOriginalNextSibling = btnMic?.nextElementSibling || null;
    const restoreComposerActions = () => {
      // Restore btn-mic to its original DOM home BEFORE un-hiding the
      // composer-actions row so it's back in its slot when visible.
      if (btnMic && btnMicOriginalParent && btnMic.parentElement !== btnMicOriginalParent) {
        try { btnMicOriginalParent.insertBefore(btnMic, btnMicOriginalNextSibling); }
        catch { btnMicOriginalParent.appendChild(btnMic); }
      }
      mount?.restore();
    };
    const ok = await turnbased.start({
      barContainer: mount?.container || null,
      barInsertBefore: mount?.insertBefore || null,
      barRightBtn: btnMic || null,
      onCommit: async (blob, reason) => {
        // Post the blob to /transcribe (mirrors the memo path) and route
        // the resulting transcript through composer.appendText +
        // composer.submit — same canonical send path as the user typing
        // a message + hitting Enter. Auto-send is ALWAYS on for Listen.
        try {
          const res = await fetch('/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': blob.type || 'audio/webm' },
            body: blob,
          });
          const data = await res.json().catch(() => ({} as any));
          let text = String((data && data.transcript) || '').trim();
          // Strip the trailing sendword (only when sendword actually
          // triggered the commit — silence-triggered commits keep the
          // full transcript). Pulls the live setting so a renamed
          // sendword takes effect on next turn. Allows trailing
          // punctuation; case-insensitive.
          if (text && reason === 'sendword') {
            // Same matchSendword regex used by both audio modes — keep
            // the strip in lockstep with the detector.
            const { sendwordPhrase } = handsfree.getHandsfreeConfig();
            const m = handsfree.matchSendword(text, sendwordPhrase);
            if (m.matched) text = m.cleaned;
          }
          if (!text) {
            log('listen: empty transcript, skipping send');
            return;
          }
          composer.appendText(text);
          composer.submit();
        } catch (e: any) {
          diag('listen: /transcribe failed', e?.message);
        }
      },
      onCommitText: async (text, reason) => {
        // LOCAL streamingEngine path — turnbased.ts already ran Web
        // Speech in-browser and accumulated the transcript. No
        // /transcribe call. Same sendword strip + composer
        // append/submit as the server path so downstream behaviour is
        // identical from the user's perspective.
        let body = text;
        if (body && reason === 'sendword') {
          const { sendwordPhrase } = handsfree.getHandsfreeConfig();
          const m = handsfree.matchSendword(body, sendwordPhrase);
          if (m.matched) body = m.cleaned;
        }
        if (!body) {
          log('listen: empty local transcript, skipping send');
          return;
        }
        composer.appendText(body);
        composer.submit();
      },
      onCancel: () => {
        listenActive = false;
        if (btnMic) btnMic.classList.remove('listening-armed', 'listening');
        status.setStatus('');
      },
      onBarge: () => {
        // User spoke during TTS — PAUSE (not cancel) so the audio
        // position survives. User can then resume by clicking the
        // bubble's play button, OR talk to commit a new turn (Listen
        // re-arms via the 'paused' tts event subscribed at boot).
        // The barge bleed itself isn't shipped — the NEXT clean turn
        // is what gets committed if the user keeps talking.
        try { ttsModule.pauseReplyTts(); } catch { /* noop */ }
      },
      onState: (s) => {
        if (btnMic) {
          btnMic.classList.toggle('listening-armed', s === 'armed' || s === 'committing');
          btnMic.classList.toggle('listening', s === 'armed');
        }
        if (s === 'armed') status.setStatus('Listen: armed', 'live');
        else if (s === 'committing') status.setStatus('Listen: sending…', null);
        else if (s === 'playing') status.setStatus('Listen: speaking…', null);
        else if (s === 'cooldown') status.setStatus('Listen: re-arming…', null);
        else if (s === 'idle') {
          status.setStatus('');
          // Restore the composer-actions row that startListen hid so
          // the recorder bar could take its place. Tied to the 'idle'
          // transition (single point) so it covers every teardown
          // path: trash button, stopListen, mic-error fallback.
          restoreComposerActions();
        }
        // Wake-lock follows call state — release on idle, acquire on
        // armed/committing/playing/cooldown if user has the toggle on.
        evaluateWakeLock();
      },
    });
    if (!ok) {
      listenActive = false;
      restoreComposerActions();
      status.setStatus('Mic not available', 'err');
      return;
    }
    listenActive = true;
  }

  function stopListen(): void {
    if (!listenActive) return;
    listenActive = false;
    turnbased.stop();
    // Clear ALL voice-state classes — .active is added synchronously
    // on pointerdown (line ~2235) for immediate red-circle feedback,
    // but Listen's path doesn't go through the call/dictate cleanup
    // that normally removes it. Without explicit removal here, the
    // mic button stays red after Listen disarms even though the
    // micState is correctly 'idle'.
    if (btnMic) btnMic.classList.remove('listening-armed', 'listening', 'active');
  }

  /** Whether some voice path is currently active. Used by the click
   *  toggle to decide start vs stop. */
  function voiceActive(): boolean {
    return memoActive || dictateActive || webrtcControls.isOpen() || listenActive;
  }

  /** Stop whichever voice path is active. Idempotent / safe to call
   *  when nothing is running. */
  async function stopVoice(): Promise<void> {
    if (memoActive) {
      // Mid-memo stop fires send (release-to-send PTT semantics) by
      // clicking the composer-send. If the user wants to discard, they
      // hit the trash button or Esc.
      composerSend.click();
      return;
    }
    if (dictateActive) {
      await stopDictate();
      return;
    }
    if (webrtcControls.isOpen()) {
      await stopCallStream();
      return;
    }
    if (listenActive) {
      stopListen();
      return;
    }
  }

  /** Mic-button dispatch. Streaming ON → live STT into the composer
   *  cursor (cursor-aware dictation). Streaming OFF (the default) → memo:
   *  blob recorded locally, transcribed on stop, dropped into the
   *  composer (or auto-sent if `micAutoSend` is on).
   *
   *  `initialCursor` (composer textarea selectionStart, captured at the
   *  gesture site BEFORE focus shifted) is plumbed only to the dictate
   *  path — it's the only mode that splices into the textarea at the
   *  user's caret. */
  /** Mic-button dispatch — gesture-driven (no settings).
   *
   *   gesture='tap'  → live streaming dictation into the composer at
   *                    the captured cursor. Ends on second tap, Esc,
   *                    or Send. No auto-send (text stays in composer
   *                    for review; user submits manually).
   *   gesture='hold' → PTT memo recording. Drag-right or release-in-
   *                    place sends the audio blob; drag-left discards.
   *                    Always sends — autoSend is implicit in the PTT
   *                    gesture itself.
   *
   * Replaces the previous settings.streaming + settings.micAutoSend
   * menu toggles. The gesture IS the affordance now. */
  async function startMicMode(
    gesture: 'tap' | 'hold',
    initialCursor: number | null = null,
  ): Promise<void> {
    if (gesture === 'tap') {
      await startDictate(initialCursor);
    } else {
      // PTT memo always sends on release (autoSend=true). Discard via
      // the drag-off-bar gesture handler in the pointerup classifier.
      await startMemo(true);
    }
  }

  /** Call-button dispatch. Realtime ON → WebRTC duplex (talk if
   *  speak-replies is on, else stream). Realtime OFF (the default) →
   *  turn-based Listen: full local audio buffer, sent to the server
   *  only when the user finishes speaking. Optimized for fidelity over
   *  latency; ideal when reply latency is dominated by the LLM
   *  round-trip. */
  // Re-entrancy guard: rapid btn-call taps during the cold-start audio-
  // session prime (~1.5s) used to spawn parallel startListen chains, each
  // creating its own MediaStream — only the last was tracked. Field
  // repro 2026-05-05: 3 taps → 3 "capture: acquired by listen" entries +
  // visible duplicate recorder bars, mic held by extras after end. The
  // capture.ts pendingOwner reservation now blocks the dupe streams
  // defensively; this guard prevents the racing chains from being kicked
  // off in the first place. Symmetric with controls.ts's btn-call disable
  // for WebRTC's requesting-mic/connecting states (turn-based listen
  // doesn't go through that state machine, hence this layer).
  let callOpening = false;
  async function startCallMode(): Promise<void> {
    if (callOpening) return;
    callOpening = true;
    try {
      const s = settings.get();
      if ((s as any).realtime) {
        await startCallStream();
      } else {
        await startListen();
      }
    } finally {
      callOpening = false;
    }
  }

  /** Read the current composer cursor position. Called BEFORE focus
   *  shifts off the textarea (mic-button pointerdown, hotkey handler)
   *  so the value reflects the user's intended insertion point. Returns
   *  null if the textarea has never been focused / has no selection
   *  data — dictate.ts will fall back gracefully. */
  function captureComposerCursor(): number | null {
    try {
      // Live read first — works when the textarea is still focused at
      // gesture time. On at least some browsers, button mousedown
      // shifts focus before our pointerdown handler runs, so by the
      // time we read selectionStart the textarea is blurred and the
      // value can be stale (0, value.length, or null depending on
      // browser). Fall back to composer.getLastCaret(), which is
      // tracked via a global selectionchange listener and reflects the
      // user's actual last-set caret position regardless of focus.
      if (document.activeElement === composerInput) {
        const ss = composerInput.selectionStart;
        if (typeof ss === 'number') return ss;
      }
      return composer.getLastCaret();
    } catch {
      return null;
    }
  }

  // ── Mic button — gesture-detected tap-vs-hold state machine ────────
  if (btnMic) {
    // Single gesture, mode auto-detected from press duration. No user
    // setting; the press itself reveals intent. State machine:
    //
    //   IDLE
    //     pointerdown → start recording, t0=now, state=RECORDING
    //
    //   RECORDING (mode pending)
    //     pointerup: dur = now - t0
    //       dur < TAP_THRESHOLD_MS → state=RECORDING_TOGGLE (keep running,
    //         next tap stops). Drag-to-discard NOT reachable here — the
    //         gesture surface ended on release; user must use the
    //         trash button on the memo bar to discard a toggled memo.
    //       dur ≥ TAP_THRESHOLD_MS → finalize (send/dispatch), state=IDLE
    //     pointercancel/leave-mid-press → treat as pointerup
    //
    //   RECORDING_TOGGLE
    //     pointerdown → finalize (send), state=IDLE
    //     pointerup → no-op (the click that started this state ALSO fires
    //       a pointerup; we ignore it once we've transitioned)
    //
    // While in RECORDING (HOLD path), the existing waveform-as-button
    // drag-to-discard gesture stays live: pointer-capture on the mic
    // button means pointermove/pointerup route here even when the
    // finger drifts onto the memo bar. Drag the finger ANY direction
    // (up/down/left/right) past the memo bar's padded bounds →
    // discard-armed; release in red → discard. The bar itself is the
    // "still recording" zone; outside the padded rect arms discard.
    // 200ms originally — too tight for a deliberate "tap" gesture
    // (natural finger lift takes ~250ms). Was 350ms (iOS long-press
    // range) but felt laggy in field use 2026-05-09; 280 splits the
    // difference: PTT triggers crisply for deliberate holds while
    // ~250ms tap-releases still classify as taps. If you start hitting
    // "I tapped to toggle but it recorded" misfires, bump back up.
    const TAP_THRESHOLD_MS = 280;

    type MicState = 'idle' | 'recording' | 'recording_toggle';
    let micState: MicState = 'idle';
    let pressStartedAt = 0;
    /** Time the gesture machine entered `recording_toggle`. A second
     *  pointerdown within TOGGLE_STOP_GUARD_MS of this is treated as
     *  an accidental double-tap (browser autoclick / fast user) and
     *  ignored — otherwise rapid double-clicks finalize a sub-second
     *  empty memo. Call mode dodges this because WebRTC handshake is
     *  still in flight on click 2, so its stopVoice no-ops. */
    let recordingToggleAt = 0;
    const TOGGLE_STOP_GUARD_MS = 500;
    /** True once we've classified the press as HOLD (release ≥ threshold).
     *  Distinct from micState so the drag-to-discard pointermove handler
     *  knows when the gesture surface is live. */
    let holdActive = false;
    /** Memo bar element — cached on press_down (HOLD path) so pointermove
     *  doesn't re-querySelector every frame. */
    let holdMemoBar: HTMLElement | null = null;
    /** True when the pointer is currently in the trash zone (HOLD only).
     *  Drives the red-state class swap; only transitions write to the DOM. */
    let holdDiscardArmed = false;
    /** Pointer ID currently captured for HOLD-mode drag-to-discard. */
    let capturedPointerId: number | null = null;

    /** Diagnostic: snapshot every relevant gesture-state variable at a
     *  decision site. Used to debug silent no-op press branches. */
    function diagMicState(label: string): void {
      const age = recordingToggleAt > 0 ? (performance.now() - recordingToggleAt).toFixed(0) : '-';
      log(
        '[mic-diag]', label,
        'micState=', micState,
        'memoActive=', memoActive,
        'dictateActive=', dictateActive,
        'webrtcOpen=', webrtcControls.isOpen(),
        'voiceActive=', voiceActive(),
        'recordingToggleAt_age=', age, 'ms',
        'holdActive=', holdActive,
        'capturedPointerId=', capturedPointerId,
      );
    }

    /** Padding (px) added on every side of the memo bar's bounding rect
     *  before the inside/outside test. Generous margin so a finger
     *  hovering near the bar's edge stays classified as "still
     *  recording" — Jonathan explicitly wants no false negatives where
     *  a near-edge release accidentally discards. Once the pointer
     *  clears this padded zone in ANY direction, discard arms. */
    const MEMO_BAR_DISCARD_PADDING_PX = 40;

    /** Inside-memo-bar hit test (padded). Returns true when the pointer
     *  is inside the memo bar's bbox expanded by MEMO_BAR_DISCARD_PADDING_PX
     *  on every side. The drag-to-discard gesture arms whenever this is
     *  false, so the user can flick the finger up, down, left, or right
     *  off the bar to discard — not just leftward. */
    function isInsideMemoBar(clientX: number, clientY: number): boolean {
      if (!holdMemoBar) return false;
      const r = holdMemoBar.getBoundingClientRect();
      const pad = MEMO_BAR_DISCARD_PADDING_PX;
      return (
        clientX >= r.left - pad &&
        clientX <= r.right + pad &&
        clientY >= r.top - pad &&
        clientY <= r.bottom + pad
      );
    }

    /** Trash-icon hit test. The trash icon is inside the memo bar
     *  (so isInsideMemoBar returns true when the pointer is over it),
     *  but it's a deliberate visual affordance — users naturally slide
     *  toward the trash to discard. Discard arms on EITHER condition:
     *  pointer outside the padded memo bar, OR pointer over the trash
     *  icon. Additive per Jonathan's spec 2026-05-03. */
    function isOverTrashZone(clientX: number, clientY: number): boolean {
      const trash = holdMemoBar?.querySelector('.memo-trash') as HTMLElement | null;
      if (!trash) return false;
      const r = trash.getBoundingClientRect();
      return (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      );
    }

    /** Resolve the memo bar element after startMicMode's async setup
     *  completes (mic permission, MediaRecorder spin-up). Polls briefly
     *  to cover iOS getUserMedia latency. Only relevant for memo mode
     *  (Streaming/dictate mode has no .memo-bar). */
    function pollForMemoBar(tries: number): void {
      if ((settings.get() as any).streaming) return;  // dictate mode — no memo bar
      const bar = document.querySelector('.memo-bar') as HTMLElement | null;
      if (bar) {
        bar.classList.add('memo-bar-ptt');
        holdMemoBar = bar;
      } else if (tries > 0) {
        setTimeout(() => pollForMemoBar(tries - 1), 30);
      }
    }

    let holdActivationTimer: ReturnType<typeof setTimeout> | null = null;
    /** Composer cursor captured at pointerdown — consumed when the
     *  classify resolves (TAP → dictate uses it; HOLD → memo discards
     *  it). Stashed at module level so the pointerup handler can read
     *  the value the pointerdown handler captured. */
    let pendingInitialCursor: number | null = null;

    /** Press-down: starts recording immediately (regardless of eventual
     *  tap-vs-hold classification). The release-time duration check
     *  decides whether to keep recording or stop. */
    btnMic.addEventListener('pointerdown', (e: PointerEvent) => {
      diagMicState('pointerdown ENTRY');
      // preventDefault + body.ptt-pressing as the very first acts of
      // the handler — kills iOS's native long-press selection-loupe
      // timer before it has a chance to fire (the loupe was leaking
      // text-selection from the textarea/composer area when the finger
      // landed a few px outside btn-mic's 22x22 hit zone). The
      // body.ptt-pressing class drives a global selection-disable rule
      // mirroring body.fake-lock-engaged, so even if iOS resolves the
      // gesture target to a sibling, no text gets selected. Cleared in
      // the pointerup/pointercancel handlers below.
      try { e.preventDefault(); } catch {}
      try { document.body.classList.add('ptt-pressing'); } catch {}
      if (holdActivationTimer) { clearTimeout(holdActivationTimer); holdActivationTimer = null; }
      // Stale-state guard: if the gesture machine thinks we're in
      // recording_toggle but no voice path is actually running, the
      // memo finalized externally (Enter-in-composer, memo bar's
      // own send button, etc) without our pointerdown firing. The
      // old code path called stopVoice → no-op → user perceived
      // "click did nothing" alternating pattern. Reset to idle and
      // fall through to the normal start path.
      if (micState === 'recording_toggle' && !voiceActive()) {
        log('[mic-diag] stale recording_toggle (voice not active) — resetting to idle');
        micState = 'idle';
        recordingToggleAt = 0;
      }
      if (micState === 'recording_toggle') {
        // Second press on a tap-toggled recording — stop now, BUT only
        // if enough time has passed since toggle-start. A press within
        // ~500ms of the toggle-start is almost certainly a stray
        // double-tap, not a deliberate stop. Without this guard, two
        // fast clicks fire start+stop in <1s and produce an empty
        // memo (the "memo requires two clicks" symptom).
        const age = performance.now() - recordingToggleAt;
        if (age < TOGGLE_STOP_GUARD_MS) {
          e.preventDefault();
          log('[mic-diag] BRANCH: double-tap guard SWALLOWED press, age=', age.toFixed(0), 'ms');
          return;
        }
        e.preventDefault();
        log('[mic-diag] BRANCH: recording_toggle → stopVoice (age=', age.toFixed(0), 'ms)');
        micState = 'idle';
        void stopVoice();
        return;
      }
      if (micState !== 'idle') {
        log('[mic-diag] BRANCH: micState !== idle → SILENT NO-OP (state=', micState, ')');
        return;
      }
      // Defensive: if voice somehow active without our state knowing
      // (race / external trigger), treat press as a stop request.
      if (voiceActive()) {
        e.preventDefault();
        log('[mic-diag] BRANCH: voiceActive defensive → stopVoice (memo=', memoActive, 'dict=', dictateActive, 'rtc=', webrtcControls.isOpen(), ')');
        void stopVoice();
        return;
      }
      log('[mic-diag] BRANCH: idle → press start (deferred classify)');
      pressStartedAt = performance.now();
      micState = 'recording';
      holdActive = false;
      holdDiscardArmed = false;
      holdMemoBar = null;
      capturedPointerId = e.pointerId;
      try { btnMic.setPointerCapture(e.pointerId); } catch {}
      // Immediate visual feedback (red dot) so the user sees their
      // press registered even though the actual mode-start is deferred
      // until classify (TAP vs HOLD).
      try { btnMic.classList.add('active'); } catch {}
      // Capture composer cursor BEFORE focus shifts to the mic button.
      // Reading later — after the implicit focus shift / the async
      // startVoice handshake — risks getting 0 / value.length / null
      // on iOS Safari, landing voice text at the wrong location. See
      // dictate.ts ensureAnchor for details. Stash for either branch
      // (timer-fire → memo discards it; pointerup-tap → dictate uses it).
      pendingInitialCursor = captureComposerCursor();
      log('[mic] pointerdown — pressed (t0=', pressStartedAt.toFixed(0), ', initialCursor=', pendingInitialCursor, ')');
      // Deferred-start gesture machine: don't pick a mode yet. After
      // TAP_THRESHOLD_MS, if the finger is still down, classify HOLD →
      // start memo (PTT) + activate drag-to-discard surface. If the
      // finger lifts before the timer fires, classify TAP in the
      // pointerup handler → start dictate instead. This gives us
      // gesture-driven mode selection (tap=dictate, hold=PTT memo)
      // without the cost of starting memo speculatively for every press.
      holdActivationTimer = setTimeout(() => {
        holdActivationTimer = null;
        if (micState !== 'recording') return;
        holdActive = true;
        log('[mic] HOLD threshold elapsed → start PTT memo');
        void startMicMode('hold');
        try {
          status.setStatus('Recording — release to send, drag off bar to discard', 'live');
        } catch {}
        pollForMemoBar(10);
      }, TAP_THRESHOLD_MS);
    });

    btnMic.addEventListener('pointermove', (e: PointerEvent) => {
      // Drag-to-discard surface only active during HOLD-confirmed recording
      // (the brief window between press_down and release_classified is
      // pre-classification; we'd rather not flicker the bar red during
      // a finger that's about to lift as a tap).
      if (!holdActive) return;
      if (!holdMemoBar) {
        holdMemoBar = document.querySelector('.memo-bar') as HTMLElement | null;
        if (!holdMemoBar) return;
      }
      // Discard arms on EITHER:
      //   (a) pointer leaves the padded memo-bar rect in any direction
      //       (up/down/left/right) — natural "drag away" gesture, OR
      //   (b) pointer is OVER the trash icon — deliberate visual target,
      //       user instinct is to slide toward what they want.
      // Both motifs converge on discard intent.
      const discardArmed =
        !isInsideMemoBar(e.clientX, e.clientY)
        || isOverTrashZone(e.clientX, e.clientY);
      if (discardArmed !== holdDiscardArmed) {
        holdDiscardArmed = discardArmed;
        holdMemoBar.classList.toggle('discard-armed', discardArmed);
      }
    });

    /** Press-up classifier: short → toggle (keep running); long → finalize. */
    const onPointerUp = (e: PointerEvent) => {
      diagMicState('pointerup ENTRY (' + e.type + ')');
      // Ignore pointerup events that don't correspond to a press we own.
      if (micState !== 'recording') {
        log('[mic-diag] pointerup IGNORED (state=', micState, ')');
        return;
      }

      const dur = performance.now() - pressStartedAt;
      const isCancel = e.type === 'pointercancel';
      try { btnMic.releasePointerCapture(e.pointerId); } catch {}
      capturedPointerId = null;

      const classify = dur < TAP_THRESHOLD_MS && !isCancel ? 'TAP' : 'HOLD';
      log('[mic] pointerup — dur=', dur.toFixed(0), 'ms, classify=', classify);

      if (classify === 'TAP') {
        // Pre-classify TAP: holdActivationTimer hasn't fired yet, so
        // memo never started. Cancel the timer + start dictate now.
        // The dictate session ends on second tap (handled by the
        // recording_toggle branch in pointerdown above), Esc, or Send.
        if (holdActivationTimer) {
          clearTimeout(holdActivationTimer);
          holdActivationTimer = null;
        }
        micState = 'recording_toggle';
        recordingToggleAt = performance.now();
        const cursor = pendingInitialCursor;
        pendingInitialCursor = null;
        log('[mic] TAP → start dictate (cursor=', cursor, ')');
        void startMicMode('tap', cursor);
        try {
          status.setStatus('Dictating — tap mic again, Esc, or Send to finish', 'live');
        } catch {}
        return;
      }

      // HOLD → memo started in the timer-fire branch. Finalize:
      //   pointer outside padded memo-bar rect → discard
      //   pointer still inside padded rect → send
      micState = 'idle';
      const wasDiscard = (holdActive && holdDiscardArmed) || isCancel;
      holdActive = false;
      holdDiscardArmed = false;
      const barRef = holdMemoBar;
      holdMemoBar = null;
      pendingInitialCursor = null;
      e.preventDefault();
      e.stopPropagation();
      // Defer a tick so async startVoice's MediaRecorder handshake
      // settles before we ask the same primitive to stop.
      setTimeout(() => {
        if (wasDiscard && memoActive) {
          log('memo finish: path=hold-discard (gesture released over trash zone)');
          memo.cancel();
          exitMemoMode();
        } else {
          if (barRef) barRef.classList.remove('discard-armed');
          void stopVoice();
        }
      }, 0);
    };
    btnMic.addEventListener('pointerup', onPointerUp);
    btnMic.addEventListener('pointercancel', onPointerUp);
    const cancelHoldTimer = () => {
      if (holdActivationTimer) { clearTimeout(holdActivationTimer); holdActivationTimer = null; }
    };
    btnMic.addEventListener('pointerup', cancelHoldTimer);
    btnMic.addEventListener('pointercancel', cancelHoldTimer);
    // Clear body.ptt-pressing on every press release path so the
    // global selection-disable doesn't outlive the press. iOS PWA can
    // skip pointerup if the finger leaves the screen out of bounds —
    // pointercancel fires for that case, which is why both are wired.
    const clearPttPressing = () => {
      try { document.body.classList.remove('ptt-pressing'); } catch {}
    };
    btnMic.addEventListener('pointerup', clearPttPressing);
    btnMic.addEventListener('pointercancel', clearPttPressing);
    // Safety nets — iOS WKWebView occasionally drops pointerup on
    // btnMic when the gesture overlaps with system events (e.g. mic
    // tap stopping a Listen call also triggers an audio-session
    // transition that can swallow the pointerup). The class then
    // stays on, disabling composer-input until next pointerup.
    // Field bug 2026-05-10 (Jonathan): turnbased mic-tap left
    // ptt-pressing stuck on alongside swipe-active.
    //
    //   1. visibilitychange — return-to-foreground is a clean
    //      "user definitely isn't pressing the button anymore"
    //      signal; clear unconditionally.
    //   2. Any window pointerdown — if ptt-pressing is on but the
    //      target isn't btnMic, the user moved on. Clear.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && document.body.classList.contains('ptt-pressing')) {
        diag('[mic] safety: clearing stuck ptt-pressing on visibilitychange');
        document.body.classList.remove('ptt-pressing');
      }
    });
    window.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!document.body.classList.contains('ptt-pressing')) return;
      const t = e.target as Node | null;
      if (t && btnMic.contains(t)) return;  // legitimate continued press
      diag('[mic] safety: clearing stuck ptt-pressing on stray pointerdown');
      document.body.classList.remove('ptt-pressing');
    }, { capture: true, passive: true });

    // The btnMic.onclick handler is intentionally absent: gestures are
    // dispatched entirely by the pointerdown / pointerup state machine
    // above. A click handler here would race with the synthetic click
    // browsers fire after pointerup and re-stop a just-tap-toggled
    // recording. Keyboard activation (Enter/Space on focused button)
    // is handled below with explicit handlers.
    btnMic.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      // Keyboard tap = same semantics as a quick tap: toggle.
      if (micState === 'recording_toggle' || voiceActive()) {
        micState = 'idle';
        void stopVoice();
      } else if (micState === 'idle') {
        micState = 'recording_toggle';
        // Reading composer cursor here is best-effort: the user is
        // tabbed onto the mic button so the textarea is blurred. On
        // browsers that preserve selectionStart across blur (most
        // desktops) we get the right value; on ones that don't, we
        // fall back to whatever ensureAnchor() can read at first
        // interim. Either way better than nothing.
        // Keyboard activation = TAP semantics (no press-and-hold via
        // Enter/Space) — start dictation.
        void startMicMode('tap', captureComposerCursor());
      }
    });

    // Esc / Enter while memo bar is up.
    document.addEventListener('keydown', (e) => {
      if (!memoActive) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        memo.stop();
        const trash = document.querySelector('.memo-trash') as HTMLButtonElement | null;
        if (trash) trash.click();
        else exitMemoMode();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        composerSend.click();
      }
    });
  }

  // ── Call button — tap-to-toggle (no PTT, no drag-to-discard) ───────
  // Simpler than btn-mic: a call is always an explicit on/off action
  // (no "tap and hold to keep recording" ambiguity, no discard zone).
  // pointerdown is good enough; we don't need the gesture state machine.
  const btnCall = document.getElementById('btn-call') as HTMLButtonElement | null;
  if (btnCall) {
    btnCall.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // If a mic-mode (memo / dictate) is currently active, tear it
      // down before opening the call so we don't have two voice paths
      // fighting for the mic. capture.ts's single-owner mutex would
      // catch this defensively but doing it here gives a cleaner
      // teardown sequence.
      const callOpen = webrtcControls.isOpen() || listenActive;
      if (callOpen) {
        // Tap on an active call → end it.
        log('[call] pointerdown — ending active call');
        void stopVoice();
        return;
      }
      // If mic-mode is running, stop it first (memo finalizes via send).
      if (voiceActive()) {
        log('[call] pointerdown — pre-empting active mic mode before call');
        void stopVoice();
      }
      log('[call] pointerdown — startCallMode');
      void startCallMode();
    });
    // Keyboard activation (Enter/Space).
    btnCall.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const callOpen = webrtcControls.isOpen() || listenActive;
      if (callOpen) {
        void stopVoice();
      } else {
        if (voiceActive()) void stopVoice();
        void startCallMode();
      }
    });
  }

  /** Active-state visual on the call button. Reflects "user is in a
   *  CALL" — not just "WebRTC is connected." Dictation also opens
   *  the WebRTC peer (live STT to composer) but is mic-initiated, so
   *  webrtcControls.isOpen() being true during dictation would
   *  wrongly flip btn-call.active. Gate on dictateActive=false to
   *  exclude that case. */
  function syncCallButtonVisual(): void {
    if (!btnCall) return;
    const active = listenActive
      || (webrtcControls.isOpen() && !dictateActive);
    btnCall.classList.toggle('active', active);
  }
  /** Composer mic shows a stop glyph whenever some voice path is in
   *  flight, since the mic-tap dispatcher routes to stopVoice in that
   *  case (see pointerdown's "voiceActive defensive" branch). Without
   *  the swap the user sees a mic icon that actually ends the call. */
  function syncMicIcon(): void {
    const btn = document.getElementById('btn-mic');
    if (!btn) return;
    btn.classList.toggle('voice-active', voiceActive());
  }
  // Sync on every settings flip + every voice-state transition we know
  // about. Enough coverage: webrtcControls open/close fires through
  // controls.ts; listenActive flips through startListen/stopListen.
  // Hooking those would be cleaner but the polling here is cheap.
  setInterval(() => { syncCallButtonVisual(); syncMicIcon(); }, 250);
  syncCallButtonVisual();
  syncMicIcon();

  // ── Mic + Call mode chevron menus (per-button toggle rows) ─────────
  // Two independent menus. State persists in settings; reads on every
  // dispatch, writes on every flip. No teardown needed.
  //
  //   #mic-mode-menu  (right of composer): Auto-send + Streaming
  //   #call-mode-menu (left of composer):  Realtime + Speak-replies
  //
  // Both menus share the .mic-toggle-row + .mic-mode-menu CSS rules; the
  // anchoring (left vs. right) is the only visual difference, handled
  // by the .call-mode-menu rule in app.css.
  // Mic button has no menu anymore — tap=dictate, hold=PTT-memo gesture
  // replaces the streaming + autoSend toggles. The mic-mode-menu DOM was
  // dropped in the same commit. Call button keeps its menu (Realtime +
  // Speak-replies).
  const btnCallMode = document.getElementById('btn-call-mode') as HTMLButtonElement | null;
  const callModeMenu = document.getElementById('call-mode-menu') as HTMLElement | null;
  const callModeWrap = document.querySelector('.call-mode-wrap') as HTMLElement | null;

  type CallToggleKey = 'realtime' | 'tts';

  // Hover-capable, fine-pointer devices (desktop, laptop, iPad+trackpad)
  // get .title tooltips on hover; touch-only devices (iPhone, iPad bare)
  // don't, because iOS treats title as a long-press tooltip preview that
  // fights with PTT gestures (see ae8eb88). aria-label is set
  // unconditionally for screen readers.
  const isHoverDevice = typeof window !== 'undefined'
    && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;

  function setTooltip(el: Element | null, text: string): void {
    if (!el) return;
    el.setAttribute('aria-label', text);
    if (isHoverDevice) el.setAttribute('title', text);
  }

  function tooltipForCallToggle(key: CallToggleKey): string {
    return key === 'realtime'
      ? 'Realtime: ON = WebRTC duplex audio (low latency, lossy on flaky networks). OFF (default) = turn-based recording (full fidelity, sent on end-of-utterance).'
      : 'Speak replies — TTS audio output during a call (talk mode vs. stream mode)';
  }

  function applyMenuRows(menu: HTMLElement | null, s: any): void {
    if (!menu) return;
    menu.querySelectorAll<HTMLButtonElement>('button.mic-toggle-row').forEach(b => {
      const key = b.dataset.toggle as CallToggleKey | undefined;
      if (!key) return;
      const on = !!s[key];
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
      setTooltip(b, tooltipForCallToggle(key));
    });
  }

  function applyMicModeUi(): void {
    const s = settings.get() as any;
    // Realtime + streamingEngine are conceptually one knob from the
    // user's perspective: "do you want WebRTC or turn-based." The
    // call-mode menu shows the Realtime toggle unconditionally; the
    // engine pairing is an implementation detail handled in the
    // toggle handler (flipping Realtime ON auto-flips streamingEngine
    // away from local). Reverse coupling NOT applied — the user can
    // still keep streamingEngine=server AND turn-based mode (real
    // bridge, full-fidelity recording) by leaving Realtime OFF.
    applyMenuRows(callModeMenu, s);
    if (callModeWrap) {
      callModeWrap.dataset.mode = s.realtime ? 'realtime' : 'turn-based';
    }
    // Dynamic call-button tooltip — only meaningful on hover devices
    // (setTooltip skips title= on touch). Includes the configured
    // toggle-call hotkey so desktop users see "⌘⇧C" and any rebind
    // surfaces here on next applyMicModeUi() trigger.
    const btnCallEl = document.getElementById('btn-call');
    if (btnCallEl) {
      const what = s.realtime
        ? (s.tts ? 'WebRTC call (talk mode)' : 'WebRTC call (stream mode)')
        : 'turn-based call (Listen)';
      const callHk = formatHotkey(s.hotkeyToggleCall || '');
      setTooltip(btnCallEl, callHk
        ? `Tap to start — ${what}  ·  ${callHk}`
        : `Tap to start — ${what}`);
    }
    // btn-mic tooltip is static in index.html ("Tap = dictate, hold =
    // memo  ·  ⌘⇧D"). Override here so user-rebound hotkeys surface
    // correctly. Same hover-only gating as btn-call.
    const btnMicEl = document.getElementById('btn-mic');
    if (btnMicEl) {
      const micHk = formatHotkey(s.hotkeyToggleMic || '');
      setTooltip(btnMicEl, micHk
        ? `Tap = dictate, hold = memo  ·  ${micHk}`
        : 'Tap = dictate, hold = memo');
    }
    // sb-new-chat tooltip — hotkey hint for Cmd+Shift+O. Hardcoded for
    // now (not yet a user-bindable setting; matches the hardcoded
    // branch in the global hotkey handler below).
    const btnNewChatEl = document.getElementById('sb-new-chat');
    if (btnNewChatEl) {
      setTooltip(btnNewChatEl, `New chat  ·  ${formatHotkey('Cmd+Shift+O')}`);
    }
  }
  applyMicModeUi();
  // Hotkey rebinds in the settings panel should refresh tooltips. Fire
  // applyMicModeUi via a custom event from settings.ts (close handler
  // dispatches it so any saved hotkey changes propagate).
  window.addEventListener('sidekick:hotkeys-changed', () => applyMicModeUi());
  // Engine flip (set-streaming-engine select in the Settings panel)
  // → re-render mic/call UI so btn-call hide/show keeps up live.
  window.addEventListener('sidekick:engine-changed', () => applyMicModeUi());

  // ── Barge slider (call-mode menu) ──────────────────────────────────
  // Single slider 0..100 that folds the bargeIn boolean into its
  // leftmost position (0 = OFF). Replaces the prior settings-panel
  // checkbox + slider pair. iOS speakerphone hides the row entirely
  // because barge is acoustically impossible there (no AEC against
  // <audio>-element TTS playing through the same physical device).
  // See audio/shared/headphones.ts for the routing detector.
  {
    const slider = document.getElementById('call-mode-barge-slider') as HTMLInputElement | null;
    const valEl = document.getElementById('call-mode-barge-val');
    const row = document.getElementById('call-mode-barge-row');
    function readSettingsToSlider(): void {
      if (!slider || !valEl) return;
      const s = settings.get() as any;
      const sens = s.bargeIn
        ? settings.vadThresholdToSensitivity(s.bargeVadThreshold)
        : 0;
      slider.value = String(sens);
      valEl.textContent = sens === 0 ? 'Off' : `${sens}%`;
    }
    function writeSliderToSettings(): void {
      if (!slider || !valEl) return;
      const sens = Number(slider.value);
      valEl.textContent = sens === 0 ? 'Off' : `${sens}%`;
      if (sens === 0) {
        // Kill switch — bargeIn=false skips detector creation AND
        // VAD asset prefetch entirely (see prefetch site below).
        void settings.set('bargeIn', false);
      } else {
        void settings.set('bargeIn', true);
        void settings.set('bargeVadThreshold' as any, settings.sensitivityToVadThreshold(sens));
      }
    }
    slider?.addEventListener('input', writeSliderToSettings);
    readSettingsToSlider();
    // Hide the slider row whenever barge is physically unavailable —
    // SSOT lives in headphones.isBargeAvailable() so future callers
    // (settings hints, tap-to-interrupt fallback decision, etc.)
    // read from the same function and stay in sync.
    function applyBargeRowVisibility(): void {
      if (!row) return;
      const s = settings.get() as any;
      const mode = s.realtime ? 'realtime' : 'turnbased';
      const { available } = headphones.isBargeAvailable(mode);
      row.hidden = !available;
    }
    headphones.onChange(() => applyBargeRowVisibility());
    window.addEventListener('sidekick:settings-changed', () => {
      readSettingsToSlider();
      applyBargeRowVisibility();
    });
    applyBargeRowVisibility();
  }

  // ── VAD source override (call-mode menu) ────────────────────────────
  // Three buttons (Auto / Client / Bridge) that pin the VAD strategy.
  // Auto defers to chooseVadStrategy() (default: bridge). Backed by
  // localStorage (sidekick_vad_override) so it survives PWA reloads —
  // the URL ?vad= override is unreachable inside an installed PWA
  // (browser caches the entry URL).
  //
  // Dev-mode-only (Jonathan, 2026-05-09): the row is testing
  // scaffolding for VAD experiments, not user-facing config. Hide
  // unless dev mode is on so non-dev users don't see a confusing
  // "VAD source: Auto / Client / Bridge" toggle in the call menu.
  {
    const vadRow = document.getElementById('call-mode-vad-row');
    if (vadRow) {
      const showVadRow = isDevMode();
      vadRow.hidden = !showVadRow;
    }
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.mic-vad-option'),
    );
    function refresh(): void {
      const cur = vadRouting.getVadStrategyOverrideSetting();
      for (const btn of buttons) {
        const opt = btn.dataset.vadOption;
        btn.setAttribute('aria-checked', String(opt === cur));
      }
    }
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        const opt = btn.dataset.vadOption as 'auto' | 'client' | 'bridge';
        vadRouting.setVadStrategyOverrideSetting(opt);
        refresh();
        // Note: takes effect on the NEXT call open. Active calls keep
        // their VadSource — cycling the call (close + reopen) picks up
        // the new strategy. We don't hot-swap here because BargeDetector
        // owns its source's lifecycle and a mid-call swap would race.
      });
    }
    refresh();
  }

  // Mirror static composer aria-label → title for hover devices. iOS
  // touch path keeps title-less buttons (no long-press tooltip popup).
  if (isHoverDevice) {
    for (const id of ['btn-mic', 'btn-call-mode']) {
      const el = document.getElementById(id);
      const label = el?.getAttribute('aria-label');
      if (el && label) el.setAttribute('title', label);
    }
  }

  // Single source of truth for "flip a mic / call menu toggle" — used by
  // BOTH the menu-click handlers AND the global hotkey handler. Reads
  // the POST-flip value via settings.get() after set() so the status
  // pill text doesn't drift from the menu visuals (visuals re-read
  // live state via applyMicModeUi).
  function flipMicSetting(key: CallToggleKey): void {
    const cur = !!(settings.get() as any)[key];
    const next = !cur;
    settings.set(key, next);
    // Flipping Realtime ON requires the WebRTC bridge — coerce
    // streamingEngine away from 'local' so the toggle is meaningful
    // immediately. One-way coupling: turning Realtime OFF leaves the
    // engine alone (user may still want server-engine turn-based,
    // which is a valid combination).
    if (key === 'realtime' && next) {
      const engine = (settings.get() as any).streamingEngine;
      if (engine === 'local') settings.set('streamingEngine', 'server');
    }
    applyMicModeUi();
    const label = key === 'realtime' ? 'Realtime' : 'Speak replies';
    const live = !!(settings.get() as any)[key];
    status.setStatus(`${label}: ${live ? 'on' : 'off'}`, null);
    // Flipping `realtime` ON while a turn-based Listen session is
    // armed should disarm — the user's intent ("switch to realtime")
    // outweighs leaving the local recorder running.
    if (key === 'realtime' && next && listenActive) {
      stopListen();
    }
    // Toggling speak-replies OFF stops any in-flight text-mode TTS so
    // the user gets immediate silence (otherwise an active mp3 keeps
    // playing through to its end).
    if (key === 'tts' && !next) cancelReplyTts();
    // Speak-replies flip during an OPEN call cycles the WebRTC connection
    // into the new mode (talk = TTS audio; stream = STT only) so the user
    // sees the change immediately rather than "next call only". Brief
    // gap is acceptable — if it becomes annoying we can wait-for-flush.
    if (key === 'tts' && webrtcControls.isOpen()) {
      const newMode: 'talk' | 'stream' = next ? 'talk' : 'stream';
      void (async () => {
        try {
          await webrtcControls.closeIfOpen();
          await webrtcControls.openCall(newMode);
        } catch (e: any) {
          diag('tts-flip mode swap failed', e?.message);
        }
      })();
    }
  }

  function setMenuOpen(menu: HTMLElement | null, btn: HTMLButtonElement | null, open: boolean): void {
    if (!menu || !btn) return;
    if (open) {
      menu.removeAttribute('hidden');
      menu.setAttribute('aria-hidden', 'false');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      menu.setAttribute('hidden', '');
      menu.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function wireMenu(
    btn: HTMLButtonElement | null,
    menu: HTMLElement | null,
    wrap: HTMLElement | null,
  ): void {
    if (!btn || !menu) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = btn.getAttribute('aria-expanded') === 'true';
      setMenuOpen(menu, btn, !open);
    };
    menu.querySelectorAll<HTMLButtonElement>('button.mic-toggle-row').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const key = b.dataset.toggle as CallToggleKey | undefined;
        if (!key) return;
        // Single canonical path — same as the hotkey. flipMicSetting
        // updates the setting, refreshes menu visuals, sets the status
        // pill text from the post-flip value, and runs side effects.
        // Menu stays open so the user can flip multiple toggles in one
        // pass (iOS Control Center pattern); tap outside to close.
        flipMicSetting(key);
      };
    });
    // Click outside closes the menu (capture so chat-bubble handlers
    // that stopPropagation can't strand us with a stuck-open menu).
    document.addEventListener('click', (e) => {
      if (menu.hasAttribute('hidden')) return;
      const t = e.target as Node;
      if (wrap && wrap.contains(t)) return;
      setMenuOpen(menu, btn, false);
    }, true);
  }
  wireMenu(btnCallMode, callModeMenu, callModeWrap);

  // Send-button intercept — when dictate is active, clicking Send (or
  // pressing Enter to fire it) should send whatever's in the composer
  // AND close the dictate stream. Capture phase so we run alongside
  // sendTypedMessage rather than racing it.
  composerSend.addEventListener('click', () => {
    if (dictateActive) void stopDictate();
  }, true);

  // Esc ends any active voice mode — dictate / Listen / WebRTC call.
  // Matches the memo Esc-cancel UX (memo has its own handler that
  // fires only when recording). Priority order matches the natural
  // "innermost active mode" the user is most likely trying to exit.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dictateActive) {
      e.preventDefault();
      void stopDictate();
      return;
    }
    if (listenActive) {
      e.preventDefault();
      stopListen();
      return;
    }
    if (webrtcControls.isOpen()) {
      e.preventDefault();
      void webrtcControls.closeIfOpen();
      return;
    }
  });

  // ── Global hotkeys (user-configurable in settings) ──────────────────
  // Three actions, three hotkey strings stored in settings. Matcher
  // accepts both Cmd (metaKey) and Ctrl (ctrlKey) for cross-platform
  // editing — Mac users see Cmd in defaults, Windows/Linux users can
  // overwrite with Ctrl. preventDefault + stopPropagation on match so
  // we override browser defaults (Cmd+Shift+C is DevTools "inspect" by
  // default, Cmd+Shift+D is "Bookmark all tabs" in Chrome, etc) AND
  // claim the event before any later document-level listener can run.
  //
  // Registered in CAPTURE phase (third arg `true`) so we run BEFORE any
  // other document-level keydown handler that might preventDefault or
  // stopPropagation us (e.g. the debug-panel Ctrl+Shift+D handler at
  // boot, or any future addition). Field reports of "⌘⇧D does nothing
  // regardless of cursor" pointed at exactly this scenario — handler
  // ordering / phase gymnastics. Capture-phase first listener with
  // stopPropagation gives the global hotkeys deterministic priority.
  document.addEventListener('keydown', (e) => {
    // Skip when typing in editable fields, except for the hotkey-capture
    // inputs themselves which handle their own keydown (those have
    // .hotkey-input class).
    const t = e.target as HTMLElement | null;
    if (t) {
      if (t.classList.contains('hotkey-input')) return;
      // Modifier-key combos (Cmd/Ctrl + Shift + key) aren't normal
      // typing — fire them everywhere INCLUDING input fields, so the
      // user can hit Cmd+Shift+D from inside the composer to toggle
      // mic without leaving the textarea. Without this, Chrome's
      // Cmd+Shift+D (bookmark all tabs) wins via browser default.
      const isShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey;
      if (!isShortcut && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return;
    }
    const s = settings.get();
    // Diagnostic: every Cmd/Ctrl+Shift+<letter> keydown logs what we saw
    // vs the three configured bindings. Lets us see whether the handler
    // fires at all for ⌘⇧D and (if so) why no match. Cheap; only triggers
    // for shortcut-shaped combos so it doesn't spam normal typing.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.length === 1) {
      log('[hotkey] keydown',
        'meta=', e.metaKey, 'ctrl=', e.ctrlKey, 'shift=', e.shiftKey,
        'alt=', e.altKey, 'key=', JSON.stringify(e.key),
        'bindings=', { call: (s as any).hotkeyToggleCall, mic: s.hotkeyToggleMic });
    }
    const matches = (combo: string): boolean => {
      if (!combo) return false;
      const parts = combo.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
      let needMeta = false, needCtrl = false, needAlt = false, needShift = false;
      let key = '';
      for (const p of parts) {
        if (p === 'cmd' || p === 'meta') needMeta = true;
        else if (p === 'ctrl') needCtrl = true;
        else if (p === 'alt') needAlt = true;
        else if (p === 'shift') needShift = true;
        else key = p;
      }
      // Cross-platform: if combo says Cmd, allow either metaKey OR ctrlKey
      // (so a "Cmd+Shift+C" binding works for Windows/Linux users typing Ctrl).
      const modifierOK =
        (needMeta ? (e.metaKey || e.ctrlKey) : !e.metaKey) &&
        (needCtrl ? (e.ctrlKey || e.metaKey) : (needMeta || !e.ctrlKey)) &&
        (needAlt ? e.altKey : !e.altKey) &&
        (needShift ? e.shiftKey : !e.shiftKey);
      if (!modifierOK) return false;
      const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
      return eventKey === key;
    };
    // claim() is the standard "we owned this event" sequence: cancel the
    // browser default (bookmark, devtools, downloads, etc) AND stop any
    // later document-level listener from re-handling the same keydown.
    const claim = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (matches((s as any).hotkeyToggleCall)) {
      claim();
      // Hotkey toggles the CALL — start a call if none active, end any
      // active call (mirrors btn-call's tap behavior). Pre-empts mic
      // mode if running so the call gets a clean mic.
      const callOpen = webrtcControls.isOpen() || listenActive;
      log('[hotkey] toggleCall — callOpen=', callOpen);
      if (callOpen) {
        void stopVoice();
      } else {
        if (voiceActive()) void stopVoice();
        void startCallMode();
      }
      return;
    }
    // hotkeyAutoSend retired — micAutoSend setting was eliminated when
    // the mic-button gesture model replaced the streaming/autoSend
    // toggles (PTT memo always sends; tap dictation never auto-sends).
    // The setting key + hotkey are dropped silently; old user-bound
    // values stay in localStorage but are no longer wired anywhere.
    if (matches('Cmd+Shift+O')) {
      claim();
      // Hotkey route to the sidebar "New chat" button. Hardcoded
      // binding for now (not yet user-configurable); same body as
      // btnNewChat.onclick — synthesize a click so we don't duplicate
      // the long minting + rotation sequence.
      const btn = document.getElementById('sb-new-chat') as HTMLButtonElement | null;
      if (btn && !btn.disabled) btn.click();
      return;
    }
    if (matches(s.hotkeyToggleMic)) {
      claim();
      // Toggle MIC specifically — startMicMode (memo/dictate). Not
      // btn.click() (the gesture machine listens to pointer events,
      // not clicks). The gesture machine's pointerdown handler has a
      // `if (voiceActive()) { stopVoice(); return; }` defensive branch
      // that auto-syncs state when the user next touches the mic.
      // Don't stop a call from this hotkey — calls have their own
      // dedicated hotkey (hotkeyToggleCall above).
      const micRunning = memoActive || dictateActive;
      log('[hotkey] toggleMic — micRunning=', micRunning);
      if (micRunning) {
        void stopVoice();
      } else {
        // Capture composer cursor BEFORE the rest of the hotkey path
        // (which may not shift focus, but reading at the gesture site
        // is the canonical pattern — same as the pointerdown handler).
        // If textarea was focused when the hotkey fired, this is the
        // user's caret; if focus was elsewhere, it's the last-known
        // selection state, which is still a reasonable insertion point.
        // Hotkey = TAP semantics (no press-and-hold variant).
        void startMicMode('tap', captureComposerCursor());
      }
      return;
    }
  }, true);

  // ── Refresh button ──
  // Forces a SW update check + WAITS for the new SW to install before
  // reloading. iOS PWA suspends the page aggressively, so the periodic
  // reg.update() polling rarely fires in practice — devices end up stuck
  // on an old cached SW indefinitely.
  //
  // Bug fix 2026-05-01: the previous version called `await reg.update()`
  // (which resolves on update CHECK initiated, NOT install complete),
  // then immediately tried `reg.waiting?.postMessage(SKIP_WAITING)` —
  // but `reg.waiting` is null at that point because the new SW is still
  // in `installing` state. Then `location.reload()` fired, the page
  // reloaded under the OLD SW, and the new install (if it succeeded at
  // all) didn't take over until a SECOND refresh click. With APP_SHELL
  // drift causing install to fail outright (cache.addAll atomic 404),
  // it never took over at all — PWA permanently stuck on the last
  // version with a clean install.
  //
  // New flow: update → wait for installing→installed → SKIP_WAITING →
  // wait for controllerchange (which reloads via the index.html listener)
  // → fall through to manual reload only if no update happened.
  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.onclick = async () => {
      try { void webrtcControls.closeIfOpen(); } catch {}
      try { player.pause(); player.src = ''; player.load(); } catch {}

      // Run keyterms + settings rehydrate in parallel with the SW
      // update flow — independent work, no need to serialize.
      const sideEffects = Promise.all([
        (async () => {
          try {
            const km = await import('./keyterms.ts');
            await km.rehydrateFromSeed();
          } catch (err) {
            diag(`refresh: keyterms rehydrate failed: ${(err as Error)?.message ?? err}`);
          }
        })(),
        (async () => {
          try { await settings.reload(); }
          catch (err) {
            diag(`refresh: settings reload failed: ${(err as Error)?.message ?? err}`);
          }
        })(),
      ]);

      let willControllerChangeReload = false;
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) {
          // Kick off update check. Resolves when the check completes —
          // a new worker (if any) is now in reg.installing.
          await reg.update();
          const newWorker = reg.installing || reg.waiting;
          if (newWorker && newWorker !== reg.active) {
            diag(`refresh: new SW detected, state=${newWorker.state}`);
            willControllerChangeReload = await waitForSwActivation(newWorker, 8000);
            if (!willControllerChangeReload) {
              diag('refresh: SW activation timed out — falling back to plain reload');
            }
          } else {
            diag('refresh: no new SW (already on latest)');
          }
        }
      } catch (err) {
        diag(`refresh: SW update failed: ${(err as Error)?.message ?? err}`);
      }

      await sideEffects;

      // If a SW activation is in flight, the index.html `controllerchange`
      // listener will reload us. Don't double-reload (causes a visible
      // flash). If no activation is happening, manual reload to pick up
      // keyterms / settings refresh.
      if (!willControllerChangeReload) {
        diag('refresh: location.reload()');
        location.reload();
      } else {
        diag('refresh: awaiting controllerchange auto-reload');
      }
    };
  }

  // SW passive-update detector — see swLifecycle.ts.
  initPassiveUpdateDetector();

  // Listen mode bootstrap — URL flag for headless smoke tests. Auto-arms
  // Listen on boot when ?listen=1 is present so the smoke can drive
  // synthetic frames in (?listen_mock_mic=1). The flag also accepts
  // ?silence_sec=N to compress the silence window for fast tests.
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('listen') === '1') {
      const sec = Number(qs.get('silence_sec'));
      if (Number.isFinite(sec) && sec > 0) settings.set('silenceSec', sec);
      // Defer briefly so settings.load() + audio prime can settle.
      setTimeout(() => { void startListen(); }, 50);
    }
  } catch { /* noop */ }

  log('page loaded, UA:', navigator.userAgent);

  // Console-typeable nuclear reset for stuck SW updates — see
  // swLifecycle.ts. Exposes `__forceUpdate()` on window.
  installForceUpdateConsoleHook();

  // Background prefetch of the VAD assets so the first BargeDetector.start()
  // doesn't pay the ~14.7 MB download cost mid-tap.
  //
  // Tuning history:
  //   v0.426 (2026-05-04): 5s delay, 5 fetches in PARALLEL.
  //   v0.435 (2026-05-05): 30s delay, serialized one-at-a-time.
  //   v0.440 (2026-05-05): immediate fire + speechVad.start AWAITS the
  //     prefetch promise. Field repro on hostile network (Mac Chrome
  //     T-Mobile 5G ~78 KB/s effective): the 30s delay didn't help
  //     because the user clicks Call within seconds of page load,
  //     well before the prefetch starts. MicVAD.new fires its OWN
  //     fetch which the 15s watchdog cancels mid-download — cache
  //     never populates → every retry fails identically.
  //
  //     New design: prefetch starts at page-ready and exposes its
  //     completion promise on `window.__vadPrefetchPromise__`.
  //     speechVad.start awaits that promise BEFORE constructing
  //     MicVAD. On slow networks the user's first call waits for
  //     the cache to populate (could be 30-60s on really bad links)
  //     but subsequent calls hit the warm cache instantly. On fast
  //     networks the prefetch is well done before any click, no
  //     visible delay.
  //
  //   Fetch order: lib bundle FIRST (smallest + needed first), then
  //   model + worklet + ort runtime.
  const prefetchUrls = [
    '/build/vendor/vad-web.mjs',
    '/assets/vad/silero_vad_legacy.onnx',
    '/assets/vad/vad.worklet.bundle.min.js',
    '/assets/vad/ort-wasm-simd-threaded.mjs',
    '/assets/vad/ort-wasm-simd-threaded.wasm',
  ];
  // Skip the VAD prefetch entirely when barge is disabled. The slider
  // 0% position sets bargeIn=false and means "I do not want barge to
  // run at all" — no detector is constructed, so loading 14.7 MB of
  // Silero assets is pure waste. Save bandwidth + parse time.
  const bargeEnabled = !!(settings.get() as any).bargeIn;
  if (!bargeEnabled) {
    log('VAD prefetch: skipped — barge disabled (slider 0%)');
    (window as any).__vadPrefetchPromise__ = Promise.resolve();
  } else {
    (window as any).__vadPrefetchPromise__ = (async () => {
      const t0 = performance.now();
      for (const url of prefetchUrls) {
        try {
          const r = await fetch(url);
          await r.text();
        } catch { /* best-effort warm */ }
      }
      log(`VAD prefetch: ${prefetchUrls.length} assets sequentially warmed in ${Math.round(performance.now() - t0)}ms`);
    })();
    // Lib parse — small additional step after prefetch promise.
    (window as any).__vadPrefetchPromise__.then(async () => {
      try {
        const speechVad = await import('./audio/shared/speechVad/index.ts');
        const supported = await speechVad.isSupported();
        log(`VAD prefetch: lib parsed, supported=${supported}`);
      } catch (e: any) {
        log(`VAD prefetch: lib import failed: ${e?.message}`);
      }
    });
  }
}

// ─── Session resume (drawer tap) ────────────────────────────────────────────

/** Replay a transcript into the chat UI after the adapter resumes a session.
 *  Clears current chat (on a real session switch), re-renders the
 *  messages, and marks history as loaded so backfillHistory doesn't
 *  double-append. resume() can fire onResumeCb multiple times for the
 *  same id (cache-cb + server-cb when results match); when the viewed
 *  id is unchanged we skip the clear so renderedMessages.upsert can
 *  reconcile in place without the blank-and-repaint flicker. */
function replaySessionMessages(
  id: string,
  messages: any[],
  pagination?: { firstId: number | null; hasMore: boolean },
  targetMessageId?: string,
  inflight?: any[],
) {
  const viewed = sessionDrawer.getViewed();
  const sameSession = viewed === id;
  diag(
    `[render-dupe] replaySessionMessages enter chat_id=${id} ` +
    `viewed=${viewed ?? ''} sameSession=${sameSession} ` +
    `msgCount=${messages.length} ` +
    `mode=${sameSession ? 'merge-existing' : 'clear-and-repopulate'} ` +
    `targetMessageId=${targetMessageId ?? ''} ` +
    `firstId=${pagination?.firstId ?? ''} hasMore=${pagination?.hasMore ?? ''}`,
  );
  if (!sameSession) {
    renderedMessages.clear();
    // Activity rows belong to the previous chat's transcript; only
    // clear when actually switching sessions. A same-session resume
    // (visibility flip, SSE reconnect, post-turn drawer refresh)
    // would otherwise wipe the just-rendered tool-call summary,
    // leaving no record of what the agent did.
    activityRow.clearAll();
    // Reset the per-reply playback pointer + cancel any in-flight
    // replay so a stale `.replaying` highlight doesn't survive into
    // the new transcript and BT skip-fwd starts from the new chat's
    // most-recent reply.
    replyNavigator.reset();
  }
  historyLoaded = true;  // we just populated history ourselves; skip backfill
  // Tell the drawer which session is ACTUALLY on screen — covers edge
  // cases where the adapter's conversationName diverges from what the
  // user is reading (superseded tokens, failed resumes, boot paths).
  sessionDrawer.setViewed(id);
  // Composer read-only when viewing a non-sidekick chat (cross-platform
  // send isn't supported — would route through the wrong adapter).
  const source = sessionDrawer.getSourceForChat(id);
  setComposerReadOnly(source !== 'sidekick', source);
  // Refresh server-side session list — handleReplyFinal also refreshes
  // when a turn completes, but if the user switches sessions mid-flight
  // (which aborts the SSE stream client-side), response.completed never
  // arrives here even though the server keeps computing + persisting.
  // Refreshing on switch catches that case so a now-persisted-but-not-
  // yet-shown session appears in the drawer without a page reload.
  // Coalesced: replaySessionMessages may be invoked multiple times in
  // rapid succession (cache-cb + server-cb in resume()), and each
  // independently-rendered drawer is wasted work + visible flicker.
  sessionDrawer.scheduleRefresh();
  // Persist the session id into the chat snapshot so a page reload can
  // re-seed the drawer highlight to this session even though adapter
  // state (conversationName) resets to default on reload.
  chat.trackViewedSession(id);
  viewedSessionForLoadEarlier = id;
  const label = getAgentLabel();
  // Batch-render: skip per-line autoScroll + persist (O(N²) without
  // batching). One flush at end does the same work O(N).
  const tRender0 = performance.now();
  for (const m of messages) {
    renderHistoryMessage(m, label, 'append', /*batch*/ true);
  }
  const tFlush0 = performance.now();
  chat.flushBatchedRender();
  const tEnd = performance.now();
  log(
    `[chat-resume] rendered ${messages.length} msgs ` +
    `loop=${Math.round(tFlush0 - tRender0)}ms ` +
    `flush=${Math.round(tEnd - tFlush0)}ms ` +
    `total=${Math.round(tEnd - tRender0)}ms`,
  );

  // Divergence-detection self-heal. After a server-driven replay,
  // the on-screen bubble count should match the server's message
  // set (modulo system_meta rows the server hides + filtered-out
  // CONTEXT-COMPACTION lines we silently drop in renderHistoryMessage).
  // If the count is materially higher, an earlier render path leaked
  // stale bubbles — most commonly the sidekick_id ↔ integer-id dedup-
  // mismatch this code is designed to prevent. Clear and re-render
  // once to recover. The check is O(1) on the happy path (DOM length
  // count + comparison); the heal path is a fresh batch render of
  // up to 200 messages (~10ms). Fires at most once per replaySession-
  // Messages call so we don't loop on stuck divergence.
  const transcriptEl = document.getElementById('transcript');
  if (transcriptEl) {
    // Only count SERVER-BACKED bubbles (finalized, non-pending,
    // non-failed, non-streaming). Optimistic in-flight bubbles
    // (.pending, .failed for a send the user is about to retry,
    // .streaming for a delta that hasn't finalized) are LOCAL-ONLY
    // state and shouldn't trigger the divergence wipe — otherwise a
    // reconcileActiveChat refetch immediately after a failed send
    // wipes the .failed bubble + Retry button before the user can
    // see them (smoke atomic-bubble-pending-failed.mjs).
    const renderedCount = transcriptEl.querySelectorAll(
      '.line[data-message-id]:not(.pending):not(.failed):not(.streaming)',
    ).length;
    // Server count excludes system_meta rows (no content, dropped by
    // renderHistoryMessage). Filter to match.
    const serverContentCount = messages.filter((m: any) => {
      const t = (m?.content || '').trim();
      return t && !t.startsWith('[CONTEXT COMPACTION');
    }).length;
    // Tolerance of +1 covers an in-flight streaming bubble that the
    // server hasn't persisted yet (rare during replay, but possible
    // on tightly-timed reconnects). Higher delta = real divergence.
    if (renderedCount > serverContentCount + 1) {
      log(
        `[chat-resume] divergence detected: DOM has ${renderedCount} ` +
        `bubbles vs server ${serverContentCount} — clearing + re-rendering`,
      );
      renderedMessages.clear();
      activityRow.clearAll();
      replyNavigator.reset();
      // Re-render from server. Don't recurse — we've already cleared
      // the entries map so the upserts here are guaranteed to create.
      for (const m of messages) {
        renderHistoryMessage(m, label, 'append', /*batch*/ true);
      }
      chat.flushBatchedRender();
      log(`[chat-resume] divergence healed: re-rendered ${messages.length} msgs from server`);
    }
  }
  // Register pagination state AFTER messages land so the scroll listener
  // doesn't fire mid-render. hasMore=false (or missing) disables lazy-load.
  chat.setPaginationState(pagination?.firstId ?? null, !!pagination?.hasMore);
  // If the resume was driven by a message-search hit, find the matching
  // bubble and scroll it into view + flash. Best-effort: if the hit
  // predates the initial replay window (older than the first ~200
  // messages), the bubble isn't in the DOM and we fall back to the
  // standard scroll-to-bottom. Drill-to-message via load-earlier is
  // a separate backlog item — see backlog.md.
  if (targetMessageId) {
    const transcriptEl = document.getElementById('transcript');
    const target = transcriptEl?.querySelector(
      `.line[data-message-id="${CSS.escape(targetMessageId)}"]`,
    ) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('search-target-flash');
      setTimeout(() => target.classList.remove('search-target-flash'), 1500);
      return;
    }
    // Fallthrough to scroll-to-bottom if not found — don't leave the
    // user stranded on a random scroll position. A future backlog
    // item drives load-earlier until the target is located.
    log(`[cmdk] target message ${targetMessageId} not in initial replay; load-earlier drill not yet implemented`);
  }
  // Replay any inflight envelopes from the proxy's in-memory cache —
  // user message + tool calls + reply deltas for an in-flight turn
  // that hermes-core hasn't yet persisted to state.db. Replay happens
  // AFTER the state.db render+clear+divergence-heal so the just-
  // rendered state.db bubbles aren't wiped by the clear path. Each
  // envelope goes through the same handler the live SSE stream uses
  // (handleReplyDelta / handleUserMessage / activityRow.appendToolCall
  // etc.) — keyed by stable id so live SSE arrival during this window
  // collapses to the same bubble idempotently. See
  // proxy/sidekick/inflight.ts for the server-side lifecycle.
  if (inflight && inflight.length > 0) {
    log(`[chat-resume] replaying ${inflight.length} inflight envelope(s)`);
    backend.replayInflight?.(id, inflight);
  }
  chat.forceScrollToBottom();
}

/** Shared rendering for both initial replay (append) and load-earlier
 *  (prepend, batched). The caller owns scroll behavior + persist. */
function renderHistoryMessage(m: any, label: string, mode: 'append' | 'prepend' = 'append', batch: boolean = false) {
  const raw = (m.content || '').trim();
  const text = raw;
  if (!text) return;
  // Hermes state.db stores timestamp as float UNIX seconds. chat.addLine's
  // formatTime passes through new Date(ts) which expects milliseconds, so
  // without the *1000 it'd render 1970. If ts is already >= 1e12 it's
  // probably ms already (openclaw / openai-compat backends), so pass
  // through unchanged.
  const rawTs = m.timestamp || m.created_at || m.at;
  const ts = typeof rawTs === 'number' && rawTs < 1e12 ? rawTs * 1000 : rawTs;
  const prepend = mode === 'prepend';
  // Stamp data-message-id on history-rendered bubbles so a subsequent
  // SSE re-delivery for the same message can be deduped at the handler
  // level (see handleReplyDelta / handleReplyFinal).
  //
  // Key selection: prefer `sidekick_id` (the SSE-shape id the plugin
  // emitted live via user_message / reply_final) over the raw integer
  // `id` from state.db. Without this preference the IDB-cached bubble
  // (keyed by umsg_*/msg_*) won't match the history-replay upsert
  // (keyed by integer), causing every reload to duplicate the entire
  // transcript. See backends/hermes/plugin's _write_msg_links_after_turn
  // for the link table the plugin populates after each turn. Falls
  // back to integer id for legacy rows persisted before the link table
  // existed and for messages from other channels (telegram, slack, ...).
  const messageId = m.sidekick_id
    ? String(m.sidekick_id)
    : (m.id != null ? String(m.id) : undefined);
  // Caller may force batching even for append (resume-loop case);
  // prepend always batches because chat.prependHistory wraps the loop.
  const useBatch = prepend || batch;
  if (m.role === 'assistant') {
    if (NO_REPLY_RE.test(text)) return;
    if (messageId) {
      renderedMessages.upsert(messageId, {
        role: 'assistant',
        text,
        status: 'finalized',
        speaker: label,
        cls: 'agent',
        markdown: true,
        timestamp: ts,
        prepend,
        batch: useBatch,
        // replyNavigator (BT skip-fwd / skip-back, per-bubble play
        // chips) keys off data-reply-id. For history-rendered bubbles
        // there's no separate replyId from the live SSE path, so reuse
        // messageId — same stable identifier, same dedup semantics.
        replyId: messageId,
      });
    } else {
      chat.addLine(label, text, 'agent', {
        markdown: true, timestamp: ts, prepend, batch: useBatch,
      });
    }
  } else if (m.role === 'user') {
    if (messageId) {
      renderedMessages.upsert(messageId, {
        role: 'user',
        text,
        status: 'finalized',
        speaker: 'You',
        cls: 's0',
        timestamp: ts,
        prepend,
        batch: useBatch,
      });
    } else {
      chat.addLine('You', text, 's0', {
        timestamp: ts, prepend, batch: useBatch,
      });
    }
  }
  // Tool role / system role: skip for now; UI has no slot for them.
}

/** Session id the chat is currently viewing — used by the load-earlier
 *  callback so it knows which session to fetch older messages for.
 *  Updated by replaySessionMessages. */
let viewedSessionForLoadEarlier: string | null = null;

async function loadEarlierHistory(beforeId: number) {
  const id = viewedSessionForLoadEarlier;
  if (!id) return;
  const result: any = await backend.loadEarlier(id, beforeId);
  const older = result.messages || [];
  if (!older.length) {
    chat.setPaginationState(null, false);
    return;
  }
  const label = getAgentLabel();
  chat.prependHistory(() => {
    // Iterate oldest→newest. Each prepend inserts at firstChild, so the
    // LAST call ends up topmost — which is what we want since older
    // messages should sit above newer ones that were already on screen.
    // (The returned `messages` array is chronological oldest→newest.)
    for (let i = older.length - 1; i >= 0; i--) {
      renderHistoryMessage(older[i], label, 'prepend');
    }
  });
  chat.setPaginationState(result.firstId ?? null, !!result.hasMore);
}

// ─── Session history backfill ────────────────────────────────────────────────

let historyLoaded = false;
/** In-flight backfill promise. The plain `historyLoaded` bool wasn't
 *  enough in practice — field logs showed triple-backfill runs on a
 *  single page load (same session key), and the only way that happens
 *  is concurrent entry between the sync guard and the fetchHistory
 *  await. The promise single-flight pattern also returns the same
 *  completion handle to overlapping callers so they await the same
 *  work rather than starting their own fetch. */
let backfillInFlight: Promise<void> | null = null;

async function backfillHistory() {
  if (historyLoaded) { diag('backfill: skip (already loaded)'); return; }
  if (backfillInFlight) { diag('backfill: awaiting in-flight run'); return backfillInFlight; }
  backfillInFlight = (async () => {
    historyLoaded = true;

    // Defensive dedupe: if the transcript already has content (e.g. restored
    // from the IDB snapshot), collect existing text to skip duplicates.
    // Agent bubbles store raw markdown in data-text; `.text` textContent is
    // rendered. Include both so backfill's raw-markdown text matches either.
    const transcriptEl = document.getElementById('transcript');
    const existingTexts = new Set();
    if (transcriptEl) {
      transcriptEl.querySelectorAll<HTMLElement>('.line').forEach(line => {
        const rendered = line.querySelector('.text')?.textContent?.trim();
        if (rendered) existingTexts.add(rendered);
        const raw = line.dataset.text?.trim();
        if (raw) existingTexts.add(raw);
      });
    }

    const messages = await backend.fetchHistory(50);
    if (!messages.length) return;
    log(`backfilling ${messages.length} history messages`);

    // Adapter already stripped adapter-specific conventions (openclaw's
    // "[voice]" prefix, internal system messages, etc.). Shell just displays.
    let appended = 0;
    for (const msg of messages) {
      const text = msg.text
        || (Array.isArray(msg.content) ? msg.content.find((c) => c?.type === 'text')?.text : '')
        || '';
      if (!text) continue;
      if (existingTexts.has(text.trim())) continue;
      const timestamp = msg.timestamp || msg.created_at || msg.at;

      if (msg.role === 'assistant') {
        if (NO_REPLY_RE.test(text)) continue;
        chat.addLine(getAgentLabel(), text, 'agent', { markdown: true, timestamp });
        appended++;
      } else if (msg.role === 'user') {
        chat.addLine('You', text, 's0', { timestamp });
        appended++;
      }
    }
    diag(`backfill: appended ${appended}/${messages.length} (${messages.length - appended} deduped)`);

    // Initial history backfill — always jump to latest regardless of
    // pinned state (user just loaded the app).
    chat.forceScrollToBottom();
  })();
  try { await backfillInFlight; }
  finally { backfillInFlight = null; }
}

// ─── Streaming indicator — shows partial text while agent is thinking ────────

let streamingIdleTimer = null;

/** Max time we'll leave a "thinking…" / streaming box on screen with no new
 *  events before assuming the reply is stuck. 90s is generous — tool calls
 *  (calendar scans, web fetches) can run long before any text arrives. */
const STREAMING_IDLE_TIMEOUT_MS = 90_000;

/** Synthetic key under which a pending-thinking bubble is registered in
 *  the renderedMessages map before any real message_id is known.
 *  Migrated to the real id on the first reply_delta carrying one. The
 *  in-flight bubble itself is recovered via renderedMessages.getStreaming()
 *  — no module-level ref needed. */
let pendingStreamingKey: string | null = null;

/** Create a tentative "the agent is working on it" bubble. Fired the instant
 *  the user sends a message, BEFORE any backend events arrive. Prevents the
 *  silent-chat problem where the agent jumps straight to tool calls without
 *  streaming text first — user would otherwise stare at a blank screen and
 *  wonder if anything happened.
 *
 *  On the first onDelta, `showStreamingIndicator` transitions this bubble
 *  into the real streaming reply (adopts a fresh replyId, populates text,
 *  wires the play-bar + TTS event stream). On onFinal with empty text or
 *  a 90s no-event timeout, `clearStreamingIndicator` removes it. */
function showThinking() {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  if (renderedMessages.getStreaming()) return;  // already showing; don't stack
  // Sweep any orphan streaming bubbles that escaped the map (e.g. an
  // interrupt aborted a stream mid-flight without going through
  // finalize). Invariant: at most one streaming bubble visible.
  transcriptEl.querySelectorAll('.line.streaming').forEach(el => el.remove());
  // Use a temporary replyId so the bubble has a data-reply-id from the
  // start (needed for TTS / DOM lookup); will be swapped out by the
  // adapter's real id on first delta.
  const tempId = `r-pending-${Date.now()}`;
  pendingStreamingKey = `pending:${tempId}`;
  const el = renderedMessages.upsert(pendingStreamingKey, {
    role: 'assistant',
    text: '',
    status: 'streaming',
    speaker: getAgentLabel(),
    cls: 'agent streaming pending',
    markdown: true,
    replyId: tempId,
  });
  if (el) {
    const dots = document.createElement('span');
    dots.className = 'thinking-dots';
    dots.textContent = 'sending…';
    el.appendChild(dots);
  }
  chat.autoScroll();
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Activity signal from the backend — positive evidence that the agent
 *  has acknowledged our send and is actively working. Transitions the
 *  thinking bubble from "sending…" (optimistic, .pending class) to
 *  "thinking…" / "using <tool>…" (confirmed, bright dots). Fires on
 *  every incremental activity event; we just update the label, the
 *  replyId swap happens in showStreamingIndicator. */
function handleActivity({ working, detail, conversation }: any) {
  // Drop only for an explicitly DIFFERENT viewed session — null gets
  // through (covers fresh-chat / first-message / boot races).
  const viewed = sessionDrawer.getViewed();
  if (viewed && conversation && conversation !== viewed) return;
  // Q1: typing/working envelope is the agent's first ack — finalize
  // the oldest pending user bubble for this chat.
  if (working) finalizeOldestPending(conversation);
  const el = renderedMessages.getStreaming();
  if (!el) return;
  el.classList.remove('pending');
  const dots = el.querySelector('.thinking-dots');
  if (!dots || !working) return;
  if (dots.classList.contains('hidden')) return;  // text already populated
  // Friendly labels for common tools; generic "using X" for anything else.
  let label = 'thinking…';
  if (detail === 'streaming') label = 'thinking…';
  else if (detail === 'canvas.show') label = 'sharing card…';
  else if (detail && detail !== 'tool') label = `using ${detail}…`;
  else if (detail === 'tool') label = 'using tool…';
  dots.textContent = label;
  // Reset idle timer on every real signal — an active agent shouldn't
  // time out while it's visibly working.
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Show or update the in-flight agent bubble. Called on onDelta events.
 *  If showThinking() already created a tentative bubble, this upgrades it
 *  in place — migrates the map key to the real message_id, adopts the
 *  real replyId + populates text. Otherwise creates a fresh bubble
 *  (e.g. agent-initiated messages where there was no user send to
 *  trigger the thinking bubble).
 */
function showStreamingIndicator(partialText, replyId, messageId?: string | null) {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;

  let el = renderedMessages.getStreaming();
  // Resolve the renderedMessages key. Prefer the real message_id; fall
  // back to the pending key if showThinking already minted one and the
  // adapter hasn't surfaced a message_id yet.
  const key = messageId || pendingStreamingKey || `live:${replyId}`;

  if (!el) {
    // Sweep any stragglers before creating a new bubble — one streaming
    // indicator at a time, no exceptions.
    transcriptEl.querySelectorAll('.line.streaming').forEach(elt => elt.remove());
    el = renderedMessages.upsert(key, {
      role: 'assistant',
      text: partialText || '',
      status: 'streaming',
      speaker: getAgentLabel(),
      cls: 'agent streaming',
      markdown: true,
      replyId,
    });
    if (el) {
      const dots = document.createElement('span');
      dots.className = 'thinking-dots';
      dots.textContent = 'thinking…';
      if (partialText) dots.classList.add('hidden');
      el.appendChild(dots);
    }
  } else {
    // Pending-thinking bubble exists — promote it: migrate the map key
    // to the real message_id, adopt the real reply id, populate text.
    if (pendingStreamingKey && messageId && pendingStreamingKey !== messageId) {
      renderedMessages.migrate(pendingStreamingKey, messageId);
      pendingStreamingKey = null;
    }
    el.classList.remove('pending');
    if (partialText) {
      renderedMessages.upsert(key, {
        role: 'assistant',
        text: partialText,
        status: 'streaming',
        speaker: getAgentLabel(),
        cls: 'agent streaming',
        markdown: true,
        replyId,
      });
      const dots = el.querySelector('.thinking-dots');
      if (dots) dots.classList.add('hidden');
    } else {
      // No text yet — still update replyId/messageId on the existing
      // bubble so downstream lookups work.
      el.dataset.replyId = replyId;
      if (messageId) el.dataset.messageId = messageId;
    }
  }
  chat.autoScroll();

  // Safety net: if a reply gets stuck with no more events, auto-clear.
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Promote the streaming bubble to its final form: update text, remove
 *  thinking dots, strip the .streaming class, open links in new tabs.
 *  Returns the bubble element (already in the DOM) or null if no
 *  streaming bubble existed. */
function finalizeStreamingBubble(finalText, messageId?: string | null) {
  if (streamingIdleTimer) { clearTimeout(streamingIdleTimer); streamingIdleTimer = null; }
  const el = renderedMessages.getStreaming();
  if (!el) return null;
  // Resolve the map key for this bubble. messageId wins if known; else
  // fall back to whatever synthetic key the streaming bubble was
  // registered under.
  const key = messageId
    || el.dataset.messageId
    || pendingStreamingKey
    || (el.dataset.replyId ? `live:${el.dataset.replyId}` : null);
  if (key) {
    if (pendingStreamingKey && messageId && pendingStreamingKey !== messageId) {
      renderedMessages.migrate(pendingStreamingKey, messageId);
    }
    renderedMessages.upsert(key, {
      role: 'assistant',
      text: finalText,
      status: 'finalized',
      speaker: getAgentLabel(),
      cls: 'agent',
      markdown: true,
      replyId: el.dataset.replyId,
    });
  } else {
    // Defensive fallback: bubble somehow not in the map. Mirror the
    // original in-place finalize so behavior matches pre-refactor.
    const textSpan = el.querySelector('.text');
    if (textSpan) textSpan.innerHTML = miniMarkdown(finalText);
    el.dataset.text = finalText;
    const dots = el.querySelector('.thinking-dots');
    if (dots) dots.remove();
    el.classList.remove('streaming');
    el.querySelectorAll('a').forEach(a => { a.target = '_blank'; (a as HTMLAnchorElement).rel = 'noopener'; });
  }
  pendingStreamingKey = null;
  return el;
}

function clearStreamingIndicator() {
  if (streamingIdleTimer) { clearTimeout(streamingIdleTimer); streamingIdleTimer = null; }
  const el = renderedMessages.getStreaming();
  if (!el) return;
  if (pendingStreamingKey) {
    renderedMessages.remove(pendingStreamingKey);
    pendingStreamingKey = null;
  } else {
    el.remove();
  }
}

/** Find the most-recent non-streaming agent bubble and attach a card.
 *  Falls back to the active streaming bubble if there's no finalized
 *  agent reply yet. */
function attachCardToLatestAgentBubble(card) {
  const el = document.getElementById('transcript');
  if (!el) return;
  const bubbles = Array.from(
    el.querySelectorAll('.line.agent[data-reply-id]:not(.streaming)')
  ) as HTMLElement[];
  const target = bubbles[bubbles.length - 1] || renderedMessages.getStreaming();
  if (!target) {
    log('attachCard: no agent bubble to attach to — dropping card', card.kind);
    return;
  }
  attachCard(target, card);
}

// ─── Backend event handlers ─────────────────────────────────────────────────
// Normalized per-event handlers. Shell logic only — the backend adapter
// handles wire-format parsing. Events not surfaced by the adapter (agent
// lifecycle, heartbeat, etc.) don't reach us by design.

/** Streaming partial reply. `cumulativeText` is the full text so far.
 *  Adapter already drops user-echo prefix variants so we don't need to
 *  defensively filter them here. With per-turn replay machinery gutted,
 *  the bubble is purely a text surface: TTS is owned by the WebRTC
 *  talk-mode track on the server side and arrives as audio independently. */
/** Q1 atomic-bubble: outstanding pending user bubbles per chat_id, in
 *  send order. Drained oldest-first when an agent envelope (typing /
 *  reply_delta) arrives for that chat — that envelope is the proof
 *  the agent received our message. Cleared on chat.clear(). */
const pendingBubblesByChat = new Map<string, HTMLElement[]>();

function finalizeOldestPending(conversation: string | null | undefined): void {
  if (!conversation) return;
  const list = pendingBubblesByChat.get(conversation);
  if (!list || list.length === 0) return;
  const bubble = list.shift()!;
  if (list.length === 0) pendingBubblesByChat.delete(conversation);
  chat.markBubbleFinalized(bubble);
}

function handleReplyDelta({ replyId, cumulativeText, conversation, messageId }: any) {
  if (!cumulativeText) return;
  // Drop deltas only for explicitly off-screen conversations: getViewed()
  // pinned to a DIFFERENT id. When getViewed() is null (boot before
  // setViewed pinned, race between async newSession and the next reply,
  // first-message-on-fresh-install where no setViewed has fired yet),
  // there's no on-screen session to protect — render. Otherwise we drop
  // the agent's reply on the floor while waiting for an IDB write the
  // user has no idea they're racing against.
  const viewed = sessionDrawer.getViewed();
  if (viewed && conversation && conversation !== viewed) return;
  // First-delta-of-turn signal: fire 'send' chime + open the suppress
  // envelope (drop user transcripts during agent reply). Detected via
  // renderedMessages.has(messageId) BEFORE upsert runs — first delta
  // is the one where the map doesn't yet have the id. Replaces the
  // duplicate path that lived in the data-channel ev.role==='assistant'
  // branch (now dead). SSE is the single source of assistant events.
  const isFirstDelta = !!messageId && !renderedMessages.has(messageId);
  if (isFirstDelta) {
    try { playFeedback('send'); } catch { /* feedback is best-effort */ }
  }
  // Suppress envelope is idempotent — calling onAssistantDelta on every
  // delta is fine; first call flips state, subsequent calls extend the
  // tail. See src/pipelines/webrtc/suppress.ts.
  webrtcSuppress.onAssistantDelta();
  // New turn arriving — cancel any paused per-bubble TTS player from
  // a prior reply. Without this, the old paused HTMLAudioElement sits
  // in tts.active across call open/close cycles. The bug surface
  // (Jonathan, 2026-05-03 ~12:30 BT-headset test): user barge'd to
  // pause an old reply mid-playback, ended call, started a new call,
  // asked a new question — pressing BT play resumed the OLD paused
  // player from its barge location instead of routing to the NEW
  // reply's audio path. Once a fresh assistant_delta arrives, the
  // previous turn's playhead state is moot; clear it.
  if (ttsModule.isPaused()) {
    cancelReplyTts('new-turn');
  }
  // Q1: agent ack for our optimistic bubble — flip pending → finalized.
  finalizeOldestPending(conversation);
  // renderedMessages.upsert (called inside showStreamingIndicator) is
  // idempotent on message_id, so re-delivery from the SSE replay ring
  // for a message history already rendered just updates the same
  // bubble in place rather than creating a duplicate.
  showStreamingIndicator(cumulativeText, replyId, messageId);
}

/** Complete reply. `content` (if present) is the raw block array used to
 *  pull out image attachments. */
function handleReplyFinal({ replyId, text, content = [], conversation, messageId, isReplay = false }: any) {
  // A completed turn means hermes has persisted this response to
  // response_store.db (+ state.db/sessions gets the derived entry). If
  // this was the first turn of a brand-new session, the drawer's
  // placeholder row needs to be replaced with the real row — trigger a
  // refresh. Background fetch will repopulate the cached list.
  // ALWAYS refresh the drawer, even when the reply belongs to an
  // off-screen conversation — that's the whole point of letting the
  // stream complete in the background: the user needs the row to find.
  // Coalesced: handleReplyFinal can fire multiple times in a burst
  // (multi-bubble turns); a single eventual refresh is enough.
  sessionDrawer.scheduleRefresh();

  // Same null-tolerant gate as handleReplyDelta: drop only for an
  // explicitly DIFFERENT viewed session. getViewed()=null = no
  // constraint (render). Side effects above (drawer refresh) already
  // fired regardless.
  const viewed = sessionDrawer.getViewed();
  if (viewed && conversation && conversation !== viewed) {
    return;
  }

  // No bubble-id dedup needed: renderedMessages.upsert is idempotent
  // on message_id, so a re-delivery for an already-rendered message
  // updates the same bubble in place rather than creating a duplicate.

  // Suppress envelope close — schedules grace-period drop of user-
  // transcript suppression. Idempotent (no-op if not currently
  // suppressing). Mirrors handleReplyDelta's onAssistantDelta call.
  // Replaces the duplicate path in the data-channel listener.
  webrtcSuppress.onAssistantFinal();

  const imageBlocks = extractImageBlocks(content);

  if (NO_REPLY_RE.test(text)) {
    log('suppressed NO_REPLY from agent');
    clearStreamingIndicator();
    return;
  }

  // reply_final is "this bubble is done streaming" — but adapters
  // differ in whether the final envelope carries the full text. The
  // legacy hermes /v1/responses adapter packed final text into the
  // last event (`response.completed`) so handleReplyFinal could just
  // use env.text. The hermes-gateway adapter (matching telegram /
  // slack / signal protocol shape) sends text only via reply_delta
  // and treats reply_final as a pure terminator. So `text` here is
  // often empty even when the bubble has streamed content visible
  // on screen — fall back to the streaming bubble's accumulated
  // text in that case.
  const streamingBubble = renderedMessages.getStreaming();
  const accumulated = (streamingBubble && streamingBubble.dataset.text) || '';
  const finalText = text || accumulated;

  if (finalText) {
    let bubble = finalizeStreamingBubble(finalText, messageId);
    if (!bubble) {
      // No streaming bubble in flight — adapter sent reply_final
      // without a preceding delta. Mint a finalized bubble directly
      // through the rendered-messages map so the same id can dedup
      // on a subsequent re-delivery.
      const key = messageId || `live:${replyId}`;
      bubble = renderedMessages.upsert(key, {
        role: 'assistant',
        text: finalText,
        status: 'finalized',
        speaker: getAgentLabel(),
        cls: 'agent',
        markdown: true,
        replyId,
      });
    } else if (messageId && !bubble.dataset.messageId) {
      // Streaming bubble was finalized but the messageId wasn't set
      // earlier (e.g. delta arrived without one, final has it).
      bubble.dataset.messageId = messageId;
    }
    if (!isReplay) playFeedback('receive');

    // Speak-replies (CALL-ONLY since 2026-05): TTS auto-fires only
    // inside an active call. In a turn-based call (Listen), we synth
    // the reply through /tts so the user hears the answer handsfree.
    // In a WebRTC call (talk mode), the peer track owns audio — we
    // don't double-up. Outside a call (text-only chat, memo dictation),
    // the user reads replies on screen; the per-bubble play button
    // handles on-demand replay. The `settings.tts` setting still
    // matters INSIDE a call (talk vs. stream WebRTC mode); it just
    // doesn't trigger TTS outside one.
    //
    // Note that `inListen` covers turnbased = armed/recording/sending/
    // playing/cooldown — i.e. any state where Listen owns the mic.
    // Idle-state turnbased means the call ended, so no TTS.
    //
    // isReplay gates the whole block: SSE ring replay on page-load /
    // reconnect re-emits old reply_finals; without this guard the
    // PWA would read the chat aloud from the top every refresh.
    const inListen = turnbased.getState() !== 'idle';
    const webrtcOpen = webrtcControls.isOpen();
    // Diagnose TTS-not-firing-after-tool-call: log every reply_final
    // routing decision so we can see whether the silent paragraph took
    // the turnbased-tts path, the webrtc-peer path (audio comes from
    // peer track), or no-audio (replay / call ended). Pair with the
    // [reply-tts] enter/cancel logs in tts.ts to follow the chain.
    const route = isReplay ? 'no-audio (replay)'
      : !inListen ? 'no-audio (call idle)'
      : webrtcOpen ? 'webrtc-peer'
      : 'turnbased-tts';
    diag(`[reply-route] ${route} replyId=${replyId} len=${finalText.length} turnbased=${turnbased.getState()} webrtcOpen=${webrtcOpen} isReplay=${isReplay}`);
    if (!isReplay && inListen && !webrtcOpen) {
      // Pass replyId so the per-bubble UX (loading bar, played-ratio
      // bar, play↔pause glyph) wires up. Listen-state notifications
      // happen via the centralized tts event subscribers above
      // (play-start / paused / ended / stopped) — no need for
      // per-call addEventListener('ended', ...) plumbing here.
      void playReplyTts(finalText, settings.get().voice, replyId);
    } else if (inListen) {
      // No TTS in flight (rare — settings.tts off AND not in Listen
      // would have skipped). Still notify so re-arm fires.
      turnbased.notifyReplyPlayback(true);
      turnbased.notifyReplyPlayback(false);
    }

    try {
      const cards = parseCardsFromText(finalText);
      for (const c of cards) attachCard(bubble, c);
    } catch (e) { log('card parse err:', e.message); }

    for (const b of imageBlocks) attachCard(bubble, b);
  } else if (imageBlocks.length) {
    clearStreamingIndicator();
    for (const b of imageBlocks) attachCardToLatestAgentBubble(b);
  } else {
    // Truly empty turn (no streamed text, no images, no text in the
    // final envelope). Clear the placeholder so it doesn't linger.
    clearStreamingIndicator();
  }
}

/** Tool-events — cards and similar side-channel data the agent emits.
 *  Currently just canvas.show; grows as backends add more. */
function handleToolEvent({ kind, payload, conversation }: any) {
  // Drop only for an explicitly DIFFERENT viewed session.
  const viewed = sessionDrawer.getViewed();
  if (viewed && conversation && conversation !== viewed) return;
  if (kind === 'canvas.show' && payload) {
    log('canvas.show event from agent');
    attachCardToLatestAgentBubble(payload);
  }
}

// ─── Go ─────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('SideKick boot failed:', err);
  document.body.textContent = `Boot error: ${err.message}`;
});
