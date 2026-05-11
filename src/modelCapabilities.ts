// Model capabilities + attach-button gate. Extracted from main.ts
// 2026-05-11 for the Phase 2 / pre-notifications refactor (see
// docs/NOTIFICATIONS_REFACTOR_PLAN.md).
//
// Two responsibilities, both keyed on "the current model id":
//
//   1. Cache per-model capability lookups from the plugin's
//      `/v1/sidekick/model-capabilities` (proxy: `/api/sidekick/model-
//      capabilities?model=<id>`). Models.dev is the ground-truth
//      source. Each lookup is cached in-process so repeat hover /
//      setting-change cycles don't re-fetch.
//   2. Drive the +button and camera button states based on those
//      capabilities AND the auxiliary vision-fallback advertisement
//      from `/api/sidekick/auxiliary-models`. Three states:
//        - Primary supports vision: enabled, plain "Attach image".
//        - Primary text-only + aux fallback: enabled, tooltip says
//          "will route through <fallback>".
//        - Neither: disabled, tooltip explains why.
//
// Hermes auto-routes media_urls through `_enrich_message_with_vision`
// → `vision_analyze_tool` → `auxiliary.vision` (gateway/run.py:6051),
// so even text-only primaries can accept attachments end-to-end via
// the fallback. That's why the gate stays enabled when the fallback
// is configured — sending images IS supported, just via an extra hop.

export interface ModelCaps {
  known: boolean;
  supports_vision: boolean;
  supports_tools: boolean;
  supports_reasoning: boolean;
  context_window: number;
  max_output_tokens: number;
  model_family: string;
}

const capsByModel = new Map<string, ModelCaps>();
const capsInFlight = new Map<string, Promise<ModelCaps | null>>();
let visionFallbackModel: string | null = null;
let auxiliaryReady: Promise<void> | null = null;

// Caller-supplied accessors / DOM refs. Set by initModelCapabilities;
// null when uninitialized (the module's pure capability functions
// still work without init — only the gate-driving paths need them).
let btnAttachRef: HTMLButtonElement | null = null;
let btnCameraRef: HTMLButtonElement | null = null;
let getCurrentModelIdRef: () => string = () => '';

/** Read the most recently observed auxiliary vision fallback model.
 *  Refreshed by `ensureAuxiliaryFetched()` on init + visibilitychange.
 *  Null when none is configured (or the proxy is unreachable). */
export function getVisionFallbackModel(): string | null {
  return visionFallbackModel;
}

/** Auxiliary vision advertisement — separate from per-model caps
 *  because it's config-driven on the hermes side, not model-driven.
 *  Thin pass-through to the plugin's `/v1/sidekick/auxiliary-models`
 *  via the proxy. Idempotent: if a fetch is in flight or has already
 *  resolved, returns the existing promise. */
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

/** Look up + cache capabilities for one model. Single-flight per
 *  model id; concurrent callers share the same Promise. Returns null
 *  on fetch failure (caller treats as "unknown"). */
export async function fetchModelCaps(modelId: string): Promise<ModelCaps | null> {
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

/** True if the model can handle image input — either natively
 *  (supports_vision) or via the auxiliary fallback model. */
export function isVisionCapableModel(modelId: string): boolean {
  return primaryModelHasVision(modelId) || !!visionFallbackModel;
}

/** Single source of truth for "is the user allowed to attach files
 *  right now?" — read by both the +button gate and the main-area
 *  drag-drop handler. Future role checks / feature flags fold in here. */
export function canAttachFiles(): boolean {
  return isVisionCapableModel(getCurrentModelIdRef());
}

/** Update btn-attach + btn-camera disabled state + tooltips based on
 *  current model + fallback availability. Called from event handlers
 *  inside init and externally exposed for callers that change
 *  attachment state out-of-band (currently only the model
 *  system-line in main.ts:1881-1890). */
export function updateAttachButtonsState(): void {
  const modelId = getCurrentModelIdRef();
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
  if (btnAttachRef) {
    btnAttachRef.disabled = !enabled;
    btnAttachRef.title = attachTitle;
  }
  if (btnCameraRef) {
    btnCameraRef.disabled = !enabled;
    btnCameraRef.title = cameraTitle;
  }
}

/** Wire the module's event listeners + drive the initial pass.
 *  Idempotent — calling twice would stack listeners; the wired flag
 *  guards. main.ts boot calls this once after the agent-settings +
 *  composer DOM are ready. */
let wired = false;
export function initModelCapabilities(opts: {
  btnAttach: HTMLButtonElement | null;
  btnCamera: HTMLButtonElement | null;
  getCurrentModelId: () => string;
}): void {
  btnAttachRef = opts.btnAttach;
  btnCameraRef = opts.btnCamera;
  getCurrentModelIdRef = opts.getCurrentModelId;

  if (wired) {
    // Re-init with new DOM refs (post-DOM-replacement reboot) still
    // updates the buttons; just don't double-bind listeners.
    updateAttachButtonsState();
    return;
  }
  wired = true;

  // Run once whenever the schema loads + on every setting change. The
  // schema-loaded event fires from agentSettings.load after a
  // successful /v1/settings/schema response; the setting-changed event
  // fires after a successful POST /v1/settings/{id} round-trip.
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
}
