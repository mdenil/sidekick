/**
 * @fileoverview Composer attachments — image picker + chips UI + send-path
 * data. Models gate what's accepted (image-capable models only).
 *
 * Owns the `pendingAttachments` queue, the chip DOM in `#composer-attachments`,
 * and the enable/disable state of the attach + camera buttons. Everyone else
 * interacts via the exported helpers — no direct DOM pokes.
 */

import { log } from './util/log.ts';
import * as status from './status.ts';
import * as chat from './chat.ts';
import * as modelCaps from './modelCapabilities.ts';
import { toast } from './toast.ts';

/** Each pending attachment: { dataUrl, mimeType, fileName, size }. */
const pending = [];
// Binding server-side limit. PDFs are rasterized server-side and the
// backend caps the PDF on disk at SIDEKICK_PDF_MAX_BYTES (20 MB); images/
// video ride the same base64-in-JSON body which the proxy + aiohttp both
// cap at 50 MB. 20 MB is the smallest real ceiling, so gate there — the
// old 5 MB cap silently rejected legitimate PDFs the backend could handle.
const MAX_BYTES = 20_000_000;

/** Surface a rejection so it actually STAYS visible. The header status
 *  line is clobbered within ~2s by the memoOutbox network-status refresher,
 *  so a setStatus('…','err') flashes and vanishes — the user reads it as
 *  "nothing happened". Route attachment errors through a toast instead. */
function rejectAttachment(msg: string) {
  toast(msg, 'err');
  status.setStatus(msg, 'err');
}

/** Called after the pending list changes — main wires this to refresh the
 *  composer send-button enabled state. */
let onChange = () => {};

export function init(opts: { onChange?: () => void } = {}) {
  onChange = opts.onChange || (() => {});
}

export function getPending() { return pending; }
export function hasPending() { return pending.length > 0; }

/** Strip data-url prefix, return a gateway-ready attachment payload list.
 *  We tag videos with `type: 'video'` in case any plugin / model wants
 *  to distinguish; gateways that only recognise 'image' will typically
 *  still pass the bytes through with the mimeType intact. Probing
 *  strategy — if this breaks for a specific model, we'll iterate. */
export function toSendPayload() {
  return pending.map(a => ({
    type: a.mimeType?.startsWith('video/') ? 'video' : 'image',
    mimeType: a.mimeType,
    fileName: a.fileName,
    content: a.dataUrl,  // server strips the `data:...;base64,` prefix
  }));
}

/** Used by the transcript renderer when echoing a user message with images. */
export function toChatEcho() {
  return pending.map(a => ({
    dataUrl: a.dataUrl, mimeType: a.mimeType, fileName: a.fileName,
  }));
}

export function clear() {
  pending.length = 0;
  renderChips();
  onChange();
}

export async function add(file) {
  if (!file) return;
  // Accept images + videos + PDFs. The gateway currently bundles
  // images and videos as `{ type: 'image', ... }`; PDFs are rasterized
  // server-side by the hermes sidekick plugin (per-page PNGs), so by
  // the time the agent sees them they're back to image content blocks.
  // Some multimodal models (Gemini, some Gemma variants) decode video
  // frames; others reject. We keep the client permissive — if the
  // gateway or model rejects, the user sees it in the reply.
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  const isPdf = file.type === 'application/pdf';
  if (!isImage && !isVideo && !isPdf) {
    rejectAttachment('Only image, video, and PDF attachments are supported');
    return;
  }
  // A PDF only reaches the model if it's pdf-native or rasterize-capable
  // (vision, incl. the auxiliary fallback). On a model that's neither, the
  // gateway would silently discard it — reject up front so the user knows.
  if (isPdf && !modelCaps.canAttachPdf()) {
    rejectAttachment("Current model can't accept PDF attachments");
    return;
  }
  if (file.size > MAX_BYTES) {
    const mb = (n: number) => `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}MB`;
    rejectAttachment(`File too large — ${mb(file.size)} exceeds the ${mb(MAX_BYTES)} limit`);
    return;
  }
  try {
    const dataUrl = await readAsDataUrl(file);
    const kindLabel = isVideo ? 'video' : (isPdf ? 'document' : 'image');
    const ext = isPdf
      ? 'pdf'
      : (file.type.split('/')[1] || (isVideo ? 'mp4' : 'jpg')).split(';')[0];
    pending.push({
      dataUrl,
      mimeType: file.type,
      fileName: file.name || `${kindLabel}-${Date.now()}.${ext}`,
      size: file.size,
    });
    renderChips();
    onChange();
  } catch (e) {
    log('attachment read failed:', e.message);
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(/** @type {string} */ (r.result));
    r.onerror = () => reject(new Error('file read failed'));
    r.readAsDataURL(file);
  });
}

function renderChips() {
  const container = document.getElementById('composer-attachments');
  if (!container) return;
  container.innerHTML = '';
  if (pending.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  pending.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    // Video chips show a small silent <video> poster (iOS may not
    // auto-render frame 1 unless muted+preload=metadata). PDFs render
    // as a labelled placeholder — we can't easily preview the first
    // page client-side without pulling pdf.js, and rasterization
    // happens server-side anyway. Image chips stay as <img>.
    if (att.mimeType?.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.src = att.dataUrl;
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = 'metadata';
      vid.title = att.fileName;
      chip.appendChild(vid);
      chip.classList.add('chip-video');
    } else if (att.mimeType === 'application/pdf') {
      const placeholder = document.createElement('div');
      placeholder.className = 'chip-pdf-label';
      placeholder.title = att.fileName;
      placeholder.textContent = 'PDF';
      chip.appendChild(placeholder);
      chip.classList.add('chip-pdf');
    } else {
      const img = document.createElement('img');
      img.src = att.dataUrl;
      img.alt = att.fileName;
      chip.appendChild(img);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-remove';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.onclick = () => {
      pending.splice(i, 1);
      renderChips();
      onChange();
    };
    chip.appendChild(btn);
    container.appendChild(chip);
  });
}

/** React to a model change. Button enable/disable + tooltips are owned by
 *  modelCapabilities (single source: the plugin's models.dev-backed
 *  capability endpoint, which is fallback-aware — a text-only primary with
 *  an auxiliary vision model can still take attachments). This module
 *  previously set the buttons too, off settings.getCurrentModelEntry().input,
 *  which disagreed with the fallback path. Delegate the button state and
 *  keep only the pending-queue side effect here. */
export function updateModelGate() {
  modelCaps.updateAttachButtonsState();
  if (pending.length === 0) return;
  // Only drop pending items once we actually KNOW the new model's
  // capabilities — a transient cache miss must not discard valid files
  // before the real verdict lands.
  if (!modelCaps.capsKnownFor(modelCaps.currentModelId())) return;
  const canImage = modelCaps.canAttachFiles();
  const canPdf = modelCaps.canAttachPdf();
  const kept = pending.filter(a =>
    a.mimeType === 'application/pdf' ? canPdf : canImage);
  if (kept.length === pending.length) return;
  const dropped = pending.length - kept.length;
  pending.length = 0;
  pending.push(...kept);
  renderChips();
  onChange();
  chat.addSystemLine(
    `${dropped > 1 ? 'Attachments' : 'Attachment'} cleared — current model can't use ${dropped > 1 ? 'them' : 'it'}`,
  );
}
