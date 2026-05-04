/**
 * @fileoverview Recorder bar — the visual row (trash button, pulse dot,
 * timer, scrolling waveform, optional send button) shared by Memo and
 * Listen modes. Pure DOM + Canvas; no MediaRecorder, no mic acquisition,
 * no transcribe wiring. Owners are mode modules (memo.ts, listen.ts)
 * that drive an `AnalyserNode` into the bar via `attachAnalyser` and
 * tear it down via `destroy`.
 *
 * Extracted from memo.ts:191-302 (renderBar + drawWaveform). The
 * algorithm — ring-buffered 40 RMS samples, one new sample every 8 rAFs
 * — is preserved verbatim so the existing memo smoke covers it.
 */
export type RecorderBar = {
  /** The root `<div class="memo-bar">` mounted into `container`. */
  el: HTMLDivElement;
  /** Wire (or rewire) the AnalyserNode the waveform reads from. The
   *  bar starts the rAF loop on first attach so the bar can mount
   *  before mic permission resolves; before then the loop draws an
   *  empty waveform. Pass `null` to detach (waveform freezes). */
  attachAnalyser(analyser: AnalyserNode | null): void;
  /** Stop the rAF + timer loops, remove the DOM node, drop callbacks. */
  destroy(): void;
};

export type RecorderBarOpts = {
  container: HTMLElement;
  insertBefore?: HTMLElement | null;
  /** Existing send-button node to relocate INTO the bar (WhatsApp-
   *  style trash/timer/wave/send on a single row). Caller restores
   *  it on exit. Pass null/undefined for modes without a send button
   *  (Listen mode). */
  sendBtn?: HTMLElement | null;
  /** Trash-button click handler — caller decides what cancel means
   *  (memo cancel, listen disarm, etc). */
  onCancel: () => void;
};

const WAVE_DOTS = 40;
/** Sample a new bar every N rAFs (slows scroll without dropping fps). */
const FRAMES_PER_SAMPLE = 8;

/** Mount a recorder bar. Caller drives audio; this module only renders. */
export function mount(opts: RecorderBarOpts): RecorderBar {
  const startTime = Date.now();
  const waveHistory = new Float32Array(WAVE_DOTS);
  let wavePos = 0;
  let frameCount = 0;
  let analyser: AnalyserNode | null = null;
  let animFrame: number | null = null;
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  const barEl = document.createElement('div');
  barEl.className = 'memo-bar';

  const btnTrash = document.createElement('button');
  btnTrash.className = 'memo-btn memo-trash';
  btnTrash.title = 'Discard';
  btnTrash.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.5 9.5h6l.5-9.5"/></svg>`;
  btnTrash.onclick = () => { opts.onCancel(); };

  const dot = document.createElement('span');
  dot.className = 'memo-dot';

  const timerEl = document.createElement('span');
  timerEl.className = 'memo-timer';
  timerEl.textContent = '0:00';

  const canvasEl = document.createElement('canvas');
  canvasEl.className = 'memo-wave';
  canvasEl.height = 32;
  // Prevent the HTML default width=300 from being the initial drawing
  // surface — on iOS Safari that 300px leaks through flex-shrink and
  // overflows the bar past the composer's right edge. Start tiny;
  // drawWaveform's resize-on-frame loop expands it once layout settles.
  canvasEl.width = 1;

  barEl.appendChild(btnTrash);
  barEl.appendChild(dot);
  barEl.appendChild(timerEl);
  barEl.appendChild(canvasEl);
  if (opts.sendBtn) barEl.appendChild(opts.sendBtn);

  if (opts.insertBefore) {
    opts.container.insertBefore(barEl, opts.insertBefore);
  } else {
    opts.container.appendChild(barEl);
  }

  function updateTimer(): void {
    if (destroyed) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    timerEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
  }

  function drawWaveform(): void {
    if (destroyed) return;
    frameCount++;

    // Only push a new sample every N frames → slower scroll
    if (analyser && frameCount % FRAMES_PER_SAMPLE === 0) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);

      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      waveHistory[wavePos % WAVE_DOTS] = rms;
      wavePos++;
    }

    const rect = canvasEl.getBoundingClientRect();
    if (rect.width > 0 && canvasEl.width !== Math.round(rect.width)) {
      canvasEl.width = Math.round(rect.width);
    }

    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx.clearRect(0, 0, w, h);

    const dotSpacing = w / WAVE_DOTS;
    const style = getComputedStyle(document.documentElement);
    const color = style.getPropertyValue('--primary').trim() || '#6b8f5e';

    for (let i = 0; i < WAVE_DOTS; i++) {
      const idx = (wavePos + i) % WAVE_DOTS;
      const amp = waveHistory[idx];
      // Visual gain — calibrated for AGC=OFF. Pre-2026-05-04 the mic
      // pipeline ran AGC=ON (which compressed voice to ~0.3-0.5 RMS
      // peaks); the 4x multiplier was tuned for that. With AGC=OFF
      // (our new DSP triple — see audio/shared/capture.ts) voice RMS
      // peaks at ~0.1-0.15, so the bars looked barely-visible. 10x
      // restores the perceived amplitude; clamp at h to prevent visual
      // overflow on loud peaks.
      const barH = Math.min(h, Math.max(2, amp * h * 10));
      const x = i * dotSpacing + dotSpacing / 2;
      const y = (h - barH) / 2;

      ctx.fillStyle = color;
      ctx.beginPath();
      (ctx as any).roundRect(x - 1.5, y, 3, barH, 1.5);
      ctx.fill();
    }

    animFrame = requestAnimationFrame(drawWaveform);
  }

  // Start rAF + timer immediately so the bar animates the moment the
  // analyser connects; before that draws an empty waveform.
  timerInterval = setInterval(updateTimer, 100);
  drawWaveform();

  return {
    el: barEl,
    attachAnalyser(a: AnalyserNode | null) {
      analyser = a;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (animFrame !== null) { cancelAnimationFrame(animFrame); animFrame = null; }
      if (timerInterval !== null) { clearInterval(timerInterval); timerInterval = null; }
      analyser = null;
      try { barEl.remove(); } catch { /* noop */ }
    },
  };
}
