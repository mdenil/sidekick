/**
 * @fileoverview Inline card attach — the replacement surface for the
 * old side-pane canvas. Agent-emitted cards (via the canvas WS or the
 * fallback text parser) render into an attachments container on the
 * agent bubble that produced them.
 *
 * Cards are keyed by replyId (the data-reply-id attribute on the agent
 * bubble) so they survive virtualizer unmount/remount: when the bubble
 * scrolls outside the window its DOM is destroyed, but the replyId is
 * stable across re-renders. On createAssistant, the reconciler calls
 * `rehydrateCards(bubble, replyId)` to replay every stored card into
 * the freshly-mounted bubble.
 *
 * Dedup: per-replyId hash set; the same URL parsed from streaming
 * delta + emitted explicitly by the agent doesn't render twice.
 *
 * @typedef {import('../types.js').CanvasCard} CanvasCard
 */

import { validateAndLog } from './validate.ts';
import { getCard } from './registry.ts';
import { log } from '../util/log.ts';

/** Per-replyId card store. Keys are replyId strings; values are the
 *  ordered list of validated card payloads attached so far. WeakMap on
 *  the bubble is gone — the bubble is ephemeral under virt. */
const cardsByReplyId = new Map();
/** Per-replyId dedup set so the same payload doesn't render twice. */
const hashesByReplyId = new Map();

function cardHash(card) {
  return `${card.kind}:${JSON.stringify(card.payload)}`;
}

function ensureContainer(bubble) {
  let container = /** @type {HTMLElement|null} */ (bubble.querySelector(':scope > .line-cards'));
  if (!container) {
    container = document.createElement('div');
    container.className = 'line-cards';
    bubble.appendChild(container);
  }
  return container;
}

function renderCardInto(bubble, card) {
  const mod = getCard(card.kind);
  if (!mod) { log('attachCard: unknown kind', card.kind); return; }
  const container = ensureContainer(bubble);
  const slot = document.createElement('div');
  slot.className = `card-slot card-slot-${card.kind}`;
  container.appendChild(slot);
  try {
    mod.render(card, slot);
  } catch (err) {
    log('card render error:', card.kind, err.message);
    slot.textContent = `Render error: ${err.message}`;
  }
}

/**
 * Validate + render a card into the given agent bubble. Dedup is
 * per-replyId — the same card payload won't render twice even if both
 * the fallback parser and the agent's explicit canvas.show fire it.
 * The card payload is also stored under the bubble's replyId so a virt
 * remount can replay it via rehydrateCards.
 *
 * @param {HTMLElement} bubble - The `.line.agent` DOM node.
 * @param {unknown} raw - Card candidate (validated before render).
 * @returns {boolean} true if the card was attached.
 */
export function attachCard(bubble, raw) {
  if (!bubble) return false;
  const card = validateAndLog(raw);
  if (!card) return false;

  const replyId = bubble.dataset?.replyId;
  if (replyId) {
    let seen = hashesByReplyId.get(replyId);
    if (!seen) { seen = new Set(); hashesByReplyId.set(replyId, seen); }
    const h = cardHash(card);
    if (seen.has(h)) return false;
    seen.add(h);
    let list = cardsByReplyId.get(replyId);
    if (!list) { list = []; cardsByReplyId.set(replyId, list); }
    list.push(card);
  }

  renderCardInto(bubble, card);
  return true;
}

/**
 * Replay every stored card into a freshly-mounted agent bubble.
 * Called by the reconciler's createAssistant after addLine — virt
 * unmount destroys the bubble's DOM (including its .line-cards
 * container), so a remount needs to rerender from cardsByReplyId.
 *
 * @param {HTMLElement} bubble
 * @param {string} replyId
 */
export function rehydrateCards(bubble, replyId) {
  if (!bubble || !replyId) return;
  const list = cardsByReplyId.get(replyId);
  if (!list || list.length === 0) return;
  for (const card of list) renderCardInto(bubble, card);
}
