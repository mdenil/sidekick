/**
 * Entry-point for the bundled vad-web ESM produced at build time
 * (see scripts/build.mjs → buildVendorBundles).
 *
 * Re-exports the bits SpeechVAD needs from @ricky0123/vad-web. esbuild
 * resolves `@ricky0123/vad-web` and `onnxruntime-web` from node_modules
 * and emits a single bundled ESM at /build/vendor/vad-web.mjs. Source
 * code is excluded from per-file ts compile (this file is .mjs, not .ts).
 *
 * The runtime asset URLs (wasm + onnx + worklet) are NOT bundled — they
 * stay at /assets/vad/, configured via baseAssetPath / onnxWASMBasePath
 * in MicVAD.new() options inside speechVad.ts.
 */
export { MicVAD, utils } from '@ricky0123/vad-web';
