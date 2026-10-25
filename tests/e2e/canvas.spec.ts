import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
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
    const panel = await app.firstWindow();
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
