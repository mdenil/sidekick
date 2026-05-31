import { test } from 'node:test';
import assert from 'node:assert/strict';

test('blur reports hidden after heartbeat refreshed visible engagement', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const originalSetInterval = Object.getOwnPropertyDescriptor(globalThis, 'setInterval');

  const documentListeners = new Map<string, Array<() => void>>();
  const windowListeners = new Map<string, Array<() => void>>();
  let visibilityState: DocumentVisibilityState = 'hidden';
  let focused = false;
  let heartbeat: (() => void) | null = null;
  const posts: Array<{ state: string; chat_id?: string }> = [];

  const addDocumentListener = (type: string, fn: () => void) => {
    const listeners = documentListeners.get(type) || [];
    listeners.push(fn);
    documentListeners.set(type, listeners);
  };
  const addWindowListener = (type: string, fn: () => void) => {
    const listeners = windowListeners.get(type) || [];
    listeners.push(fn);
    windowListeners.set(type, listeners);
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get visibilityState() { return visibilityState; },
      hasFocus: () => focused,
      addEventListener: addDocumentListener,
      // isMobileRuntime() reads documentElement.classList to detect the
      // Capacitor shell; a real browser always has it. Non-capacitor here.
      documentElement: { classList: { contains: () => false } },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: addWindowListener },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body || '{}')));
      return { ok: true } as Response;
    },
  });
  Object.defineProperty(globalThis, 'setInterval', {
    configurable: true,
    value: (fn: () => void) => {
      heartbeat = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
  });

  try {
    const mod = await import('./visibility.ts');
    mod.initVisibilityReporting(() => 'chat-A');

    assert.deepEqual(posts, [{ state: 'hidden', chat_id: 'chat-A' }]);

    visibilityState = 'visible';
    focused = true;
    for (const listener of documentListeners.get('visibilitychange') || []) listener();
    assert.deepEqual(posts.at(-1), { state: 'visible', chat_id: 'chat-A' });

    heartbeat?.();
    assert.deepEqual(posts.at(-1), { state: 'visible', chat_id: 'chat-A' });

    focused = false;
    for (const listener of windowListeners.get('blur') || []) listener();

    assert.deepEqual(posts.at(-1), { state: 'hidden', chat_id: 'chat-A' });
    assert.deepEqual(posts.map(p => p.state), ['hidden', 'visible', 'visible', 'hidden']);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as any).document;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as any).window;
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
    else delete (globalThis as any).fetch;
    if (originalSetInterval) Object.defineProperty(globalThis, 'setInterval', originalSetInterval);
  }
});
