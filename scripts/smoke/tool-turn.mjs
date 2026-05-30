// Scenario: tool-using prompt → activity row appears AND a new
// finalized agent bubble lands after it. Validates the Phase 3
// tool_call / tool_result envelope rendering path.
//
// Catches:
//   - Tool envelopes flow but activity row doesn't render.
//   - Tool round-trip but reply_final never finalizes (stuck mid-stream).
//   - .activity-row exists but no tool rows inside.

import { waitForReady, clickNewChat, send, deleteChat, captureNextChatId, SEL, assert } from './lib.mjs';

export const NAME = 'tool-turn';
export const DESCRIPTION = 'Tool-using prompt → activity row + finalized reply';
// install-only, alongside the other real-tool-event smokes
// (tool-turn-web-search, real-live-tool-events, scroll-real-tool-chats-diag,
// background-session-isolation). The outcome is live-model nondeterministic:
// the model may answer via web_search (no approval) OR via a shell command
// (e.g. `curl … | python`) that trips the approval gate and blocks the turn
// on a human decision an unattended dev-loop never gives. Plus the
// finalized-reply assertion races the short "On it." preamble bubble. The
// deterministic real-backend coverage in the default suite is text-turn
// (greeting round-trip) + pdf-upload-roundtrip (vision path); this runs at
// install / weekly cadence where approval + Tavily can be observed.
// Trigger explicitly: `npm run smoke -- tool-turn` or `--include-install`.
export const STATUS = 'install-only';
// Tool turn requires a real model to decide to call a tool. Mock can't
// simulate Phase 3's tool_call/tool_result envelopes faithfully (that's
// the thing we're testing).
export const BACKEND = 'real';

const TOOL_PROMPT = 'Search the web for today\'s weather in London and tell me the high temperature.';

export default async function run({ page, log }) {
  await waitForReady(page);
  const chatIdP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatIdP;

  try {
    // Skip the greeting — go straight to the tool prompt. (The greeting
    // round-trip is covered by text-turn.mjs.)
    const t0 = await send(page, TOOL_PROMPT);

    // Activity row should appear when the first tool_call envelope arrives.
    await page.waitForSelector(SEL.activityRow, { timeout: 30_000 });
    const tActivity = Date.now();
    log(`activity row appeared in ${tActivity - t0} ms`);

    // Eventually a finalized agent bubble lands (the reply post-tool).
    // Count baseline first since the home-channel nudge from earlier
    // chats may already be present.
    //
    // 90s, not 60s: a real multi-tool turn against live hermes finalizes
    // around 55-60s on its own, but bumps the deadline when it runs after
    // another heavy real-backend smoke (resource contention) — observed
    // flake 2026-05-29, finalized at 57.5s alone vs timeout in the
    // combined suite. Matches the tool-turn-web-search cousin's 90s gate.
    const baselineCount = await page.locator(SEL.agentFinal).count();
    await page.waitForFunction(
      ({ sel, baseline }) => document.querySelectorAll(sel).length > baseline,
      { sel: SEL.agentFinal, baseline: baselineCount },
      { timeout: 90_000, polling: 250 },
    );
    const tReply = Date.now();
    log(`reply finalized in ${tReply - t0} ms`);

    // Tool rows: at least one .tool-row in DOM (collapsed under summary
    // in 'summary' mode but still in the DOM tree).
    const toolRowCount = await page.locator(SEL.toolRow).count();
    log(`tool rows in DOM: ${toolRowCount}`);
    assert(toolRowCount >= 1, `expected ≥1 tool row, got ${toolRowCount}`);
  } finally {
    if (chatId) await deleteChat(page, chatId);
  }
}
