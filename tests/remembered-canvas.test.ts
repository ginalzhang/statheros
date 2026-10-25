import { expect, it } from 'vitest';
import { rememberedCanvasMatches } from '../src/main/canvas-setup';
import { defaultSettings, isSettingsV1, type RememberedCanvas } from '../src/shared/settings';
import type { CanvasObservation } from '../src/shared/contracts';

const window = { x: 0, y: 25, width: 1440, height: 875 }, workspace = { x: 80, y: 120, width: 1000, height: 700 };
const remembered: RememberedCanvas = { displayId: 1, canvas: { x: 100, y: 140, width: 900, height: 650 }, windowBounds: window, windowToken: 'doc-hash', workspace, viewport: null };
const observation = (patch: Partial<CanvasObservation> = {}): CanvasObservation => ({
  generation: 3, targetPid: 999, windowId: 'w2', layoutToken: 'l', windowBounds: { ...window }, windowToken: 'doc-hash', workspaceSuggestion: { ...workspace },
  diagnostics: null, rect: null, kind: null, availability: 'unavailable', reason: 'anonymous workspace', observedAt: 1, ...patch,
});

it('reuses the canvas only when Krita looks exactly the same (pid/window ids may differ)', () => {
  expect(rememberedCanvasMatches(remembered, observation(), 1)).toBe(true);
  expect(rememberedCanvasMatches(remembered, observation(), 2)).toBe(false); // other display
  expect(rememberedCanvasMatches(remembered, observation({ windowBounds: { ...window, width: 1400 } }), 1)).toBe(false); // resized
  expect(rememberedCanvasMatches(remembered, observation({ windowToken: 'other-doc' }), 1)).toBe(false); // other document
  expect(rememberedCanvasMatches(remembered, observation({ workspaceSuggestion: { ...workspace, width: 900 } }), 1)).toBe(false); // docker resized
  expect(rememberedCanvasMatches(remembered, observation({ workspaceSuggestion: null }), 1)).toBe(false); // scan incomplete: wait
  expect(rememberedCanvasMatches(remembered, observation({ windowToken: null }), 1)).toBe(false);
  expect(rememberedCanvasMatches(undefined, observation(), 1)).toBe(false);
});
it('validates the remembered canvas in settings', () => {
  expect(isSettingsV1({ ...defaultSettings(), rememberedCanvas: remembered })).toBe(true);
  expect(isSettingsV1({ ...defaultSettings(), rememberedCanvas: { ...remembered, canvas: { x: 0, y: 0, width: -1, height: 5 } } })).toBe(false);
  expect(isSettingsV1({ ...defaultSettings(), rememberedCanvas: { ...remembered, extra: 1 } })).toBe(false);
});
