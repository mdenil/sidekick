/**
 * Entry-point for the bundled SortableJS ESM produced at build time
 * (see scripts/build.mjs → buildVendorBundles).
 *
 * Re-exports the Sortable constructor. esbuild resolves `sortablejs` from
 * node_modules and emits a single bundled ESM at /build/vendor/sortable.mjs,
 * dynamic-imported on demand from sessionDrawer when the first pinned row
 * appears (so the cost is paid only by users who pin sessions). This file
 * is .mjs (not .ts) so it's excluded from the per-file ts compile.
 */
export { default } from 'sortablejs';
