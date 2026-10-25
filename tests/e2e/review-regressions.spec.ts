import { test, expect, _electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { panelWindow } from './helpers';

test('one profile owns the app and Advanced settings receives live capture state', async () => {
  test.setTimeout(45_000);
  const executablePath = path.resolve('out/Steady-darwin-arm64/Steady.app/Contents/MacOS/Steady');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'steady-review-e2e-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE; env.CARTESIA_API_KEY = '';
  const args = [`--user-data-dir=${profile}`, '--test-fake-backend', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  const app = await _electron.launch({ executablePath, args, env });
  try {
    const panel = await panelWindow(app);
    await expect.poll(() => panel.evaluate(async () => (await window.steady.status()).nativeClockReady)).toBe(true);
    const secondCode = await new Promise<number | null>((resolve, reject) => {
      const second = spawn(executablePath, args, { env, stdio: 'ignore' });
      const timer = setTimeout(() => { second.kill(); reject(new Error('Second instance did not exit')); }, 5000);
      second.once('error', error => { clearTimeout(timer); reject(error); });
      second.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    expect(secondCode).toBe(0);
    // Fake renderer media needs no physical microphone permission prompt.
    await app.evaluate(({ systemPreferences }) => { systemPreferences.getMediaAccessStatus = () => 'granted'; });
    await panel.evaluate(() => window.steady.openAdvanced());
    const advanced = app.windows().find(page => new URL(page.url()).searchParams.get('view') === 'advanced')!;
    await advanced.waitForLoadState();
    await expect(advanced.getByRole('button', { name: 'Turn microphone on', exact: true })).toBeVisible();
    await panel.evaluate(() => window.steady.microphone(true));
    await expect.poll(() => advanced.evaluate(async () => (await window.steady.voiceStatus()).snapshot?.captureOpen)).toBe(true);
    await expect(advanced.getByRole('button', { name: 'Turn microphone off', exact: true })).toBeVisible();
    await advanced.getByRole('button', { name: 'Turn microphone off', exact: true }).click();
    await expect.poll(() => panel.evaluate(async () => (await window.steady.voiceStatus()).snapshot?.captureOpen)).toBe(false);
    await expect(advanced.getByRole('button', { name: 'Turn microphone on', exact: true })).toBeVisible();
    // Capture the supervisor through its normal observation event; no test-only IPC is exposed.
    await app.evaluate(() => {
      const root = globalThis as any, emitter = (process as any).getBuiltinModule('node:events').EventEmitter.prototype;
      const original = emitter.emit;
      emitter.emit = function (this: any, event: string | symbol, ...values: any[]) {
        if (event === 'canvas-observation' && this.clock && this.request) root.reviewNative = this;
        return original.call(this, event, ...values);
      };
    });
    await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).reviewNative))).toBe(true);
    const immediateRoutineSends = await app.evaluate(({ BrowserWindow }) => {
      const root = globalThis as any, native = root.reviewNative;
      const panel = BrowserWindow.getAllWindows().find(win => new URL(win.webContents.getURL()).searchParams.get('view') === 'panel')!;
      const send = panel.webContents.send.bind(panel.webContents);
      root.reviewSends = 0;
      panel.webContents.send = (channel: string, ...values: any[]) => {
        if (channel === 'steady:status-changed') root.reviewSends++;
        send(channel, ...values);
      };
      for (let i = 0; i < 30; i++) native.emit('state', { ...native.state, latestValidFrame: i });
      return root.reviewSends as number;
    });
    expect(immediateRoutineSends).toBe(0);
    await expect.poll(() => app.evaluate(() => (globalThis as any).reviewSends)).toBeGreaterThan(0);
    expect(await app.evaluate(() => (globalThis as any).reviewSends)).toBeLessThan(5);
    const urgentSends = await app.evaluate(() => {
      const root = globalThis as any, native = root.reviewNative; root.reviewSends = 0;
      native.emit('state', { ...native.state, state: 'FAULT', reason: 'synthetic UI transition' });
      const count = root.reviewSends;
      native.emit('state', native.state);
      return count as number;
    });
    expect(urgentSends).toBe(1);
  } finally { await app.close(); }
});
