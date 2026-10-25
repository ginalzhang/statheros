import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { panelWindow } from './helpers';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';

async function openSelector(app: ElectronApplication, panel: Page): Promise<Page> {
  await panel.getByRole('button', { name: 'Select with mouse', exact: true }).click();
  // Confirmation can create a short-lived outline window at the same time.
  // Select the overlay by its view rather than accepting the next window event.
  const selectors = () => app.windows().filter(page => !page.isClosed() && new URL(page.url()).searchParams.get('view') === 'canvas-overlay');
  await expect.poll(() => selectors().length).toBe(1);
  const overlay = selectors()[0]!;
  await expect(overlay.getByRole('heading', { name: 'Select your canvas' })).toBeVisible();
  await expect(overlay.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  return overlay;
}

test('mouse setup works without calibration, validates preview, and ends paused', async () => {
  test.setTimeout(60_000);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: path.resolve('out/Steady-darwin-arm64/Steady.app/Contents/MacOS/Steady'),
    args: [`--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'steady-canvas-e2e-'))}`, '--test-fake-backend'], env, timeout: 15000 });
  try {
    const panel = await panelWindow(app);
    await expect.poll(() => panel.evaluate(async () => (await window.steady.status()).nativeClockReady)).toBe(true);
    expect((await panel.evaluate(() => window.steady.status())).settings?.calibrations).toEqual([]);
    let overlay = await openSelector(app, panel);
    await expect(panel.getByRole('heading', { name: 'Canvas', exact: true })).toBeAttached();
    // Canvas windows never mount the panel's microphone hook, even if a capture
    // command reaches their preload. Stub media so this test cannot open hardware.
    await overlay.evaluate(() => {
      (globalThis as any).audioCaptureAttempts = 0;
      navigator.mediaDevices.getUserMedia = async () => { (globalThis as any).audioCaptureAttempts++; throw new Error('No hardware in canvas tests'); };
    });
    await app.evaluate(({ BrowserWindow }) => {
      const overlay = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('view=canvas-overlay'))!;
      overlay.webContents.send('steady:voice-capture', { type: 'open' });
    });
    await overlay.waitForTimeout(100);
    expect(await overlay.evaluate(() => (globalThis as any).audioCaptureAttempts)).toBe(0);
    await expect(overlay.evaluate(() => window.steady.microphone(true))).rejects.toThrow('Untrusted');
    const setup = await panel.evaluate(async () => (await window.steady.status()).canvasSetup!);
    // Privileged overlay geometry IPC must reject a panel renderer, even with the right session.
    await expect(panel.evaluate(session => window.steady.previewCanvas({ ...session, surfaceBounds: {x:0,y:0,width:200,height:200}, rect: {x:0,y:0,width:200,height:200} }),
      { sessionId: setup.sessionId!, generation: (await panel.evaluate(() => window.steady.status())).generation, displayId: setup.displayId! })).rejects.toThrow('Untrusted');
    // Selection gestures are Chromium synthetic events; native input remains fake throughout.
    await overlay.mouse.move(150, 150); await overlay.mouse.down(); await overlay.mouse.move(180, 180); await overlay.mouse.up();
    await expect(overlay.getByRole('alert')).toContainText('100');
    await expect(overlay.getByRole('button', {name:'Use canvas',exact:true})).toBeDisabled();
    await overlay.mouse.move(400, 350); await overlay.mouse.down(); await overlay.mouse.move(100, 150); await overlay.mouse.up();
    await expect(overlay.getByRole('button', {name:'Use canvas',exact:true})).toBeEnabled();
    await overlay.getByRole('button', {name:'Retry',exact:true}).click();
    await expect(overlay.getByRole('button', {name:'Use canvas',exact:true})).toBeDisabled();
    await overlay.mouse.move(400, 350); await overlay.mouse.down(); await overlay.mouse.move(100, 150); await overlay.mouse.up();
    await expect(overlay.getByRole('button', {name:'Use canvas',exact:true})).toBeEnabled();
    const surface = await overlay.evaluate(async () => (await window.steady.status()).canvasSurfaceBounds!);
    await overlay.getByRole('button', {name:'Use canvas',exact:true}).click();
    await expect.poll(() => panel.evaluate(async () => (await window.steady.status()).canvasConfirmed)).toBe(true);
    let status = await panel.evaluate(() => window.steady.status());
    expect(status.canvas).toEqual({x:surface.x+100,y:surface.y+150,width:300,height:200});
    expect(status.canvasSetup?.source).toBe('manual'); expect(status.native?.state).toBe('PAUSED'); expect(status.native?.buttonDown).toBe(false);
    expect(status.realInput).toBe(false); expect(status.settings?.calibrations).toEqual([]);
    await expect(panel.evaluate(() => window.steady.action('resume'))).rejects.toThrow('Calibrate');
    overlay = await openSelector(app, panel);
    await overlay.keyboard.down('Escape');
    await expect.poll(() => panel.evaluate(async () => (await window.steady.status()).canvasSetup?.active)).toBe(false);
    status = await panel.evaluate(() => window.steady.status());
    expect(status.canvas).toBeNull(); expect(status.canvasConfirmed).toBe(false); expect(status.native?.state).toBe('PAUSED');
    await panel.evaluate(() => window.steady.beginCanvas());
    await expect.poll(() => panel.evaluate(async () => (await window.steady.status()).canvasSetup?.detection.availability)).toBe('unavailable');
  } finally { await app.close(); }
});

test('Set canvas confirms detection, reviews suggestions, and falls back without delayed overlays', async () => {
  test.setTimeout(75_000);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: path.resolve('out/Steady-darwin-arm64/Steady.app/Contents/MacOS/Steady'),
    args: [`--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'steady-set-canvas-e2e-'))}`, '--test-fake-backend'], env, timeout: 15000 });
  try {
    const panel = await panelWindow(app);
    const status = () => panel.evaluate(() => window.steady.status());
    const overlays = () => app.windows().filter(page => !page.isClosed() && page.url().includes('view=canvas-overlay'));
    await expect.poll(async () => (await status()).nativeClockReady).toBe(true);
    // Inject controlled observations at the supervisor event boundary. This lives
    // only in Playwright's main-process inspector; production exposes no test IPC.
    await app.evaluate(({ BrowserWindow }) => {
      const emitter = (process as any).getBuiltinModule('node:events').EventEmitter.prototype;
      const original = emitter.emit;
      const state = (globalThis as any).canvasTest = { mode: 'direct', supervisor: null,
        bounds: BrowserWindow.getAllWindows()[0]!.getBounds() };
      emitter.emit = function (this: any, event: string | symbol, ...args: any[]) {
        if (event === 'canvas-observation' && this.clock && this.request) {
          state.supervisor = this;
          const observation = args[0];
          const area = { x: 100, y: 150, width: 300, height: 200 };
          args[0] = { ...observation, generation: observation.generation - (state.mode === 'stale' ? 1 : 0),
            windowBounds: { x: 0, y: 0, width: 1512, height: 982 }, windowToken: 'controlled-document',
            rect: state.mode === 'direct' ? area : state.mode === 'invalid' ? state.bounds : null,
            kind: ['direct', 'invalid'].includes(state.mode) ? 'viewport' : null,
            availability: ['direct', 'invalid'].includes(state.mode) ? 'available' : 'unavailable',
            workspaceSuggestion: ['workspace', 'stale'].includes(state.mode) ? area : null,
            reason: 'Controlled canvas observation' };
        }
        return original.call(this, event, ...args);
      };
    });
    const mode = (value: string) => app.evaluate((_electron, value) => { (globalThis as any).canvasTest.mode = value; }, value);
    const start = async () => {
      const previousGeneration = (await status()).generation;
      await panel.getByRole('button', { name: 'Set canvas', exact: true }).click();
      // A DOM click returns before asynchronous IPC finishes starting detection.
      // Inject changes only after the new request (or its result) is published.
      await expect.poll(async () => {
        const current = await status();
        return current.generation > previousGeneration && Boolean(current.canvasSetup?.active || current.canvasConfirmed);
      }).toBe(true);
    };

    await start();
    await expect.poll(async () => (await status()).canvasConfirmed).toBe(true);
    expect((await status()).canvasSetup?.source).toBe('viewport');
    expect((await status()).native?.state).toBe('PAUSED');
    expect(overlays()).toHaveLength(0);

    await mode('workspace'); await start();
    await expect.poll(() => overlays().length).toBe(1);
    let overlay = overlays()[0]!;
    await expect(overlay.getByRole('heading', { name: 'Review suggested workspace', exact: true })).toBeVisible();
    expect((await status()).canvasConfirmed).toBe(false);
    await expect(overlay.getByRole('button', { name: 'Use canvas', exact: true })).toBeEnabled();
    await overlay.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(overlay.getByRole('button', { name: 'Use canvas', exact: true })).toBeDisabled();
    await overlay.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => overlays().length).toBe(0);
    // A second request can review and explicitly confirm the suggested bounds.
    await start(); await expect.poll(() => overlays().length).toBe(1); overlay = overlays()[0]!;
    await expect(overlay.getByRole('button', { name: 'Use canvas', exact: true })).toBeEnabled();
    await overlay.getByRole('button', { name: 'Use canvas', exact: true }).click();
    await expect.poll(async () => (await status()).canvasConfirmed).toBe(true);
    expect((await status()).canvasSetup?.source).toBe('manual');
    expect((await status()).native?.state).toBe('PAUSED');

    await mode('stale'); await start();
    await expect(panel.getByRole('button', { name: 'Set canvas', exact: true })).toBeDisabled();
    const pendingGeneration = (await status()).generation;
    await expect.poll(() => panel.evaluate(async () => {
      try { await window.steady.localAction('setCanvas'); return true; } catch { return false; }
    })).toBe(true);
    expect((await status()).generation).toBe(pendingGeneration);
    await panel.waitForTimeout(700);
    expect(overlays()).toHaveLength(0);
    await panel.getByRole('button', { name: 'Cancel canvas', exact: true }).click();
    await mode('workspace'); await panel.waitForTimeout(700);
    expect(overlays()).toHaveLength(0); expect((await status()).canvasConfirmed).toBe(false);

    await mode('invalid'); await start();
    await expect.poll(() => overlays().length).toBe(1); overlay = overlays()[0]!;
    await expect(overlay.getByRole('heading', { name: 'Select your canvas', exact: true })).toBeVisible();
    await expect(overlay.getByRole('status')).toContainText('Detected bounds could not be used');
    await expect(overlay.getByRole('button', { name: 'Use canvas', exact: true })).toBeDisabled();
    await overlay.keyboard.down('Escape'); await expect.poll(() => overlays().length).toBe(0);

    await mode('none'); await start();
    await app.evaluate(() => {
      const supervisor = (globalThis as any).canvasTest.supervisor;
      supervisor.emit('state', { ...supervisor.state, foregroundTarget: 'org.example.other' });
    });
    await expect.poll(async () => (await status()).canvasSetup?.active).toBe(false);
    await mode('workspace'); await panel.waitForTimeout(700);
    expect(overlays()).toHaveLength(0);

    await mode('none'); await start();
    await panel.getByRole('button', { name: 'Open settings', exact: true }).click();
    await expect.poll(async () => (await status()).settingsOpen).toBe(true);
    expect((await status()).canvasSetup?.active).toBe(false);
    await panel.evaluate(() => window.steady.closeSettings());
    // The standalone detection command retains its original behavior.
    await panel.getByRole('button', { name: 'Detect canvas', exact: true }).click();
    await panel.waitForTimeout(700); expect(overlays()).toHaveLength(0);
    expect((await status()).canvasSetup?.active).toBe(false);

    await start();
    await expect.poll(() => overlays().length, { timeout: 13_000 }).toBe(1); overlay = overlays()[0]!;
    await expect(overlay.getByRole('status')).toContainText('within 10 seconds');
    await expect(overlay.getByRole('button', { name: 'Use canvas', exact: true })).toBeDisabled();
    await overlay.keyboard.down('Escape'); await expect.poll(() => overlays().length).toBe(0);
    expect((await status()).native?.state).toBe('PAUSED'); expect((await status()).realInput).toBe(false);

    await start();
    await app.evaluate(() => { (globalThis as any).canvasTest.supervisor.emit('fault', 'Controlled helper failure'); });
    await expect.poll(async () => (await status()).nativeFault).toBe('Controlled helper failure');
    expect((await status()).canvasSetup?.active).toBe(false);
    await mode('workspace'); await panel.waitForTimeout(700); expect(overlays()).toHaveLength(0);
  } finally { await app.close(); }
});
