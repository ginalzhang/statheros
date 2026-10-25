import { test, expect, _electron } from '@playwright/test';
import path from 'node:path';
import { panelWindow } from './helpers';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';

test('merged voice actions preserve eraser state, smoothing and both window exclusions', async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: path.resolve('out/Steady-darwin-arm64/Steady.app/Contents/MacOS/Steady'),
    args: [`--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'steady-merge-e2e-'))}`, '--test-fake-backend'], env });
  try {
    const panel = await panelWindow(app);
    await expect.poll(() => panel.evaluate(async () => (await window.steady.status()).nativeClockReady)).toBe(true);
    // Observe the actual bridge without adding production test IPC or posting desktop input.
    await app.evaluate(() => {
      const root = globalThis as any, emitter = (process as any).getBuiltinModule('node:events').EventEmitter.prototype;
      const original = emitter.emit;
      root.mergeTest = { actions: [], configs: [], hooked: false, failNextErase: false };
      emitter.emit = function (this: any, event: string | symbol, ...args: any[]) {
        const state = root.mergeTest;
        if (event === 'canvas-observation' && this.clock && this.request && !state.hooked) {
          state.hooked = true;
          const request = this.request.bind(this);
          this.request = (type: string, payload: any) => {
            if (type === 'configure') state.configs.push(payload);
            if (type === 'action') {
              state.actions.push(payload.actionId);
              if (payload.actionId === 'toggleErase' && state.failNextErase) {
                state.failNextErase = false; return Promise.reject(new Error('controlled rejection'));
              }
            }
            return request(type, payload);
          };
        }
        return original.call(this, event, ...args);
      };
    });
    await expect.poll(() => app.evaluate(() => (globalThis as any).mergeTest.hooked)).toBe(true);
    await panel.evaluate(() => window.steady.selectCamera('merge-fixture', 'head'));
    await panel.evaluate(() => window.steady.saveCalibration({ schemaVersion: 1, cameraId: 'merge-fixture', mode: 'head', selectedHand: null,
      neutral: { x: .5, y: .5 }, extents: { left: .2, right: .2, up: .2, down: .2 }, jitter: { x: .001, y: .001 }, gain: 1.4, smoothing: 42 }));
    const configs = await app.evaluate(({ BrowserWindow }) => ({ config: (globalThis as any).mergeTest.configs.at(-1),
      windows: BrowserWindow.getAllWindows().filter(win => ['panel', 'preview'].includes(new URL(win.webContents.getURL()).searchParams.get('view') ?? '')).map(win => win.getBounds()) }));
    expect(configs.config.excludedRects).toEqual(expect.arrayContaining(configs.windows));
    expect(configs.config.excludedRects).toHaveLength(2);
    const calibration = () => panel.evaluate(async () => (await window.steady.status()).settings!.calibrations[0]!);
    await panel.evaluate(() => window.steady.action('tremorFilter'));
    expect(await calibration()).toMatchObject({ smoothing: 95, gain: 1.4 });
    await panel.evaluate(() => window.steady.action('tremorFilter'));
    expect(await calibration()).toMatchObject({ smoothing: 42, gain: 1.4 });
    await app.evaluate(() => { (globalThis as any).mergeTest.actions = []; });
    await panel.evaluate(async () => { await window.steady.action('eraser'); await window.steady.action('eraser'); await window.steady.action('brush'); });
    expect(await app.evaluate(() => (globalThis as any).mergeTest.actions)).toEqual(['toggleErase', 'brush', 'toggleErase']);
    await app.evaluate(() => { (globalThis as any).mergeTest.failNextErase = true; });
    await expect(panel.evaluate(() => window.steady.action('eraser'))).rejects.toThrow('controlled rejection');
    await panel.evaluate(() => window.steady.action('eraser'));
    const before = await app.evaluate(() => (globalThis as any).mergeTest.actions.length);
    await panel.evaluate(() => window.steady.action('eraser'));
    expect(await app.evaluate(() => (globalThis as any).mergeTest.actions.length)).toBe(before);
    expect((await panel.evaluate(() => window.steady.status())).microphoneEnabled).toBe(false);
  } finally { await app.close(); }
});
