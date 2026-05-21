# Right Drawer Modules

The right drawer is designed as an internal module host. It is not a public
third-party plugin API yet, but new first-party drawer surfaces should use this
contract instead of wiring another bespoke drawer.

## Current Modules

The existing right drawer modules are implemented through
`src/rightDrawer/host.ts` and registered from `src/pins/drawer.ts`:

- `activity` — approval, cron, and agent-reply activity. Uses the bell rail
  button and stores entries through `src/notifications/activityStore.ts`.
- `pins` — pinned messages across chats. Uses the pin rail button and stores
  entries through `src/pins/store.ts`.

`src/pins/drawer.ts` still owns some legacy bootstrap and DOM lookups because
Pins existed first. The important architectural point is that panel selection,
rail toggle behavior, title updates, shared clear button behavior, drawer
open/close state, swipe exclusion, and resizing now belong to the host.

## Module Contract

A module supplies a `RightDrawerModule`:

```ts
interface RightDrawerModule {
  id: string;
  title: string;
  panel: HTMLElement;
  toggleIds: string[];
  render(ctx: RightDrawerModuleContext): void;
  onClear?: (ctx: RightDrawerModuleContext) => void;
  onSelect?: (ctx: RightDrawerModuleContext) => void;
}
```

The host supplies `RightDrawerModuleContext` to keep modules out of drawer
chrome details:

- `clearButton` — the shared header action. Modules set its label, visibility,
  tooltip, and behavior through `onClear`.
- `isOpen()`, `open()`, `close()` — drawer state helpers.
- `render()` — rerender the active module.

A module should own its data model and rendering. The host owns only chrome and
routing between modules.

## Adding A First-Party Module

1. Add the module panel markup to the right drawer body and a rail button in the
   drawer rail.
2. Implement a renderer that accepts `RightDrawerModuleContext` and writes only
   inside the module panel.
3. Register the module in the `modules` array passed to
   `createRightDrawerHost`.
4. Use a domain event, such as `sidekick:activity-changed`, to notify the
   drawer when the module store changes.
5. Add a mocked smoke that proves the module can render, switch, clear or act,
   and survive drawer open/close transitions.

Example shape:

```ts
createRightDrawerHost({
  drawerId: 'pin-drawer',
  titleEl,
  clearButton,
  defaultModuleId: 'activity',
  modules: [
    {
      id: 'activity',
      title: 'Activity',
      panel: activityPanelEl,
      toggleIds: ['btn-activity-drawer', 'btn-activity-drawer-rail'],
      render: renderActivity,
      onClear: () => clearResolvedActivity(),
      onSelect: () => { activePanel = 'activity'; },
    },
    {
      id: 'pins',
      title: 'Pinned',
      panel: pinPanelEl,
      toggleIds: ['btn-pin-drawer', 'btn-pin-drawer-rail'],
      render: renderPins,
      onClear: () => { void clearAllPins(); },
      onSelect: () => { activePanel = 'pins'; },
    },
  ],
  bodyClass: 'pin-drawer-open',
  prefKey: 'sidekick.pin-drawer.expanded',
});
```

## Boundaries

This API is intentionally internal for now. It assumes DOM panels and rail
buttons already exist in `index.html`, and it does not yet expose a lazy-load
or manifest system for user-installed extensions.

The pragmatic path toward user plugins is:

1. Keep adding first-party modules through this contract.
2. Split each module into its own source file once the second or third module is
   stable enough to reveal the repeated pattern.
3. Stabilize the module manifest, lifecycle, and permissions model.
4. Expose a constrained user-plugin surface for modules such as markdown notes,
   artifacts, or custom canvases.
