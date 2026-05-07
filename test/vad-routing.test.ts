/**
 * Unit tests for vadRouting — VadSource strategy selection per route +
 * URL override.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseVadStrategy,
  getVadStrategyOverride,
  makeVadSource,
} from '../src/audio/shared/vadRouting.ts';
import {
  BridgeVadSource,
  ClientSideVadSource,
} from '../src/audio/shared/vadSource.ts';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

let savedNavigator: PropertyDescriptor | undefined;
let savedWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
});

afterEach(() => {
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  else delete (globalThis as any).navigator;
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else delete (globalThis as any).window;
});

function setEnv(ua: string, search: string): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { location: { search } },
    configurable: true,
    writable: true,
  });
}

describe('vadRouting', () => {
  describe('getVadStrategyOverride', () => {
    it('returns null when no ?vad= present', () => {
      setEnv(IOS_UA, '');
      assert.equal(getVadStrategyOverride(), null);
    });

    it('returns "client" for ?vad=client', () => {
      setEnv(IOS_UA, '?vad=client');
      assert.equal(getVadStrategyOverride(), 'client');
    });

    it('returns "bridge" for ?vad=bridge', () => {
      setEnv(MAC_UA, '?vad=bridge');
      assert.equal(getVadStrategyOverride(), 'bridge');
    });

    it('returns null for unknown values', () => {
      setEnv(IOS_UA, '?vad=banana');
      assert.equal(getVadStrategyOverride(), null);
    });
  });

  describe('chooseVadStrategy', () => {
    it('iOS without override → client', () => {
      setEnv(IOS_UA, '');
      assert.equal(chooseVadStrategy(), 'client');
    });

    it('Mac without override → bridge', () => {
      setEnv(MAC_UA, '');
      assert.equal(chooseVadStrategy(), 'bridge');
    });

    it('iOS with ?vad=bridge → bridge (override beats per-route default)', () => {
      setEnv(IOS_UA, '?vad=bridge');
      assert.equal(chooseVadStrategy(), 'bridge');
    });

    it('Mac with ?vad=client → client (override beats per-route default)', () => {
      setEnv(MAC_UA, '?vad=client');
      assert.equal(chooseVadStrategy(), 'client');
    });
  });

  describe('makeVadSource', () => {
    it('returns ClientSideVadSource for "client"', () => {
      const src = makeVadSource('client');
      assert.ok(src instanceof ClientSideVadSource, 'expected ClientSideVadSource');
    });

    it('returns BridgeVadSource for "bridge"', () => {
      const src = makeVadSource('bridge');
      assert.ok(src instanceof BridgeVadSource, 'expected BridgeVadSource');
    });

    it('uses chooseVadStrategy() when no arg passed (iOS → client)', () => {
      setEnv(IOS_UA, '');
      const src = makeVadSource();
      assert.ok(src instanceof ClientSideVadSource);
    });

    it('uses chooseVadStrategy() when no arg passed (Mac → bridge)', () => {
      setEnv(MAC_UA, '');
      const src = makeVadSource();
      assert.ok(src instanceof BridgeVadSource);
    });
  });
});
