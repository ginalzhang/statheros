import { expect, it } from 'vitest';
import { explainRejection } from '../src/main/rejections';
import type { NativeState } from '../src/shared/contracts';

const native = (accessibility: boolean, foregroundTarget: string | null): NativeState => ({
  state: 'PAUSED', reason: '', buttonDown: false, foregroundTarget, generation: 1, latestValidFrame: null,
  permissions: { accessibility, camera: 'authorized', microphone: 'authorized', speech: 'unknown' },
});

it('says which guard rejected a command', () => {
  expect(explainRejection('foreground-or-permission', native(false, 'org.krita'))).toMatch(/Accessibility/);
  expect(explainRejection('foreground-or-permission', native(true, 'com.apple.Safari'))).toMatch(/Krita is the front app/);
  expect(explainRejection('foreground-or-permission', null)).toMatch(/Krita is the front app/);
  expect(explainRejection('foreground', native(true, null))).toMatch(/Krita is the front app/);
  expect(explainRejection('prerequisites', null)).toMatch(/camera on/);
  expect(explainRejection('duplicate-event', null)).toBe('duplicate-event');
});
