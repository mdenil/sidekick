import { waitForReady, openSidebar, clickRow, assert } from "./lib.mjs";

export const NAME = "scroll-two-session-positions-persist";
export const DESCRIPTION = "Distinct transcript scroll positions persist independently across two session switches";
export const STATUS = "implemented";
export const BACKEND = "mocked";

const CHAT_A = "mock-scroll-two-pos-a";
const CHAT_B = "mock-scroll-two-pos-b";

function makeMessages(count, prefix) {
  const out = [];
  const body = `${prefix}: ${"independent scroll position text ".repeat(22)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      sidekick_id: `${prefix.toLowerCase()}-two-pos-${i + 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: "Chat A - two position memory",
    source: "sidekick",
    messages: makeMessages(64, "A"),
    lastActiveAt: Date.now() - 60000,
  });
  mock.addChat(CHAT_B, {
    title: "Chat B - two position memory",
    source: "sidekick",
    messages: makeMessages(64, "B"),
    lastActiveAt: Date.now() - 30000,
  });
}

async function firstVisibleAnchor(page) {
  return page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (!t) return null;
    const tr = t.getBoundingClientRect();
    for (const child of Array.from(t.children)) {
      const el = child;
      const r = el.getBoundingClientRect();
      if (r.bottom <= tr.top) continue;
      if (r.top >= tr.bottom) break;
      return {
        key: el.getAttribute("data-key"),
        top: Math.round(r.top - tr.top),
        scrollTop: Math.round(t.scrollTop),
        text: (el.textContent || "").replace(/\s+/g, " ").slice(0, 120),
      };
    }
    return null;
  });
}

async function scrollToRowByGesture(page, rowIndex) {
  await page.evaluate((idx) => {
    const t = document.getElementById("transcript");
    const row = t?.querySelectorAll(".line")[idx];
    if (!t || !row) throw new Error(`missing row ${idx}`);
    // Dispatch the same input event the app uses to mark a scroll as
    // user-initiated, then set a deterministic scrollTop and emit scroll.
    // This keeps the smoke about frontend scroll memory, not OS wheel
    // acceleration or transcript height variance.
    t.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 8 }));
    t.scrollTo({ top: row.offsetTop + 8, behavior: "instant" });
    t.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, rowIndex);
  await page.waitForTimeout(700);
  return firstVisibleAnchor(page);
}

function assertRestored(label, before, after) {
  assert(before?.key, `${label}: expected saved anchor before switch, got ${JSON.stringify(before)}`);
  assert(after?.key, `${label}: expected anchor after switch, got ${JSON.stringify(after)}`);
  assert(after.key === before.key, `${label}: expected same first-visible anchor. before=${before.key} after=${after.key}`);
  assert(Math.abs(after.top - before.top) <= 28, `${label}: expected visual offset preserved. beforeTop=${before.top} afterTop=${after.top}`);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, CHAT_A);
  await page.waitForTimeout(800);
  assert(await page.locator("#transcript .line").count() >= 55, "chat A must be scrollable");
  const aSaved = await scrollToRowByGesture(page, 14);
  log(`A saved: key=${aSaved?.key} top=${aSaved?.top} scrollTop=${aSaved?.scrollTop}`);

  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  assert(await page.locator("#transcript .line").count() >= 55, "chat B must be scrollable");
  // Intentionally scroll B immediately after switching. This catches the
  // regression where restore-save suppression blocks a real user scroll,
  // causing B to lose its own position later.
  const bSaved = await scrollToRowByGesture(page, 42);
  log(`B saved: key=${bSaved?.key} top=${bSaved?.top} scrollTop=${bSaved?.scrollTop}`);
  assert(aSaved?.key !== bSaved?.key, `A and B need distinct anchors. A=${aSaved?.key} B=${bSaved?.key}`);
  assert(!aSaved?.key?.includes("a-two-pos-64"), `A should not be pinned to bottom, got ${aSaved?.key}`);
  assert(!bSaved?.key?.includes("b-two-pos-64"), `B should not be pinned to bottom, got ${bSaved?.key}`);

  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);
  const aRestored = await firstVisibleAnchor(page);
  log(`A restored: key=${aRestored?.key} top=${aRestored?.top} scrollTop=${aRestored?.scrollTop}`);
  assertRestored("A", aSaved, aRestored);

  await clickRow(page, CHAT_B);
  await page.waitForTimeout(1500);
  const bRestored = await firstVisibleAnchor(page);
  log(`B restored: key=${bRestored?.key} top=${bRestored?.top} scrollTop=${bRestored?.scrollTop}`);
  assertRestored("B", bSaved, bRestored);
}
