import { describe, expect, it } from 'vitest';
import { CanvasSetup, canvasIdentity, freshCanvasObservation, freshWorkspaceSuggestion, routeCanvasObservation } from '../src/main/canvas-setup';
import type { CanvasObservation } from '../src/shared/contracts';

const display = { x: -1920, y: -200, width: 1920, height: 1080 };
const selection = { sessionId: 'selection-1', generation: 4, displayId: 2 };
const observation: CanvasObservation = {
  generation: 4, targetPid: 123, windowId: 'window-1', layoutToken: 'layout-1', observedAt: 1000,
  windowBounds: { x: -1900, y: -100, width: 1800, height: 900 }, windowToken: 'document-1',
  diagnostics: null,
  workspaceSuggestion: null,
  rect: { x: -1800, y: 0, width: 900, height: 600 }, kind: 'viewport', availability: 'available', reason: 'Viewport',
};

describe('mouse canvas sessions', () => {
  it('rejects stale surface geometry before preview or confirmation and clears prior approval', () => {
    const setup = new CanvasSetup(), requested = {x:0,y:0,width:1512,height:982}, actual = {...requested,y:33};
    setup.beginMouse(selection.sessionId,4,2,123,null);
    setup.preview(observation.rect,display,[]);
    expect(() => setup.validateSurface(requested,actual)).toThrow('window moved');
    expect(setup.state.preview).toBeNull(); expect(setup.state.phase).toBe('selecting');
    expect(() => setup.validateSurface(actual,actual)).not.toThrow();
    setup.preview(observation.rect,display,[]);
    expect(() => setup.validateSurface(actual,{...actual,height:900})).toThrow('window moved');
    expect(setup.state.preview).toBeNull();
    expect(() => setup.validateSurface(null,actual)).toThrow();
    expect(() => setup.validateSurface(actual,null)).toThrow();
  });
  it('labels a fitted suggestion without confirming it, and clears the label when setup ends', () => {
    const setup = new CanvasSetup();
    setup.beginMouse(selection.sessionId, 4, 2, 123, null, observation.rect, true);
    expect(setup.state.initialSelectionAdjusted).toBe(true);
    expect(setup.state.preview).toBeNull(); expect(setup.state.source).toBeNull();
    setup.invalidate('Canceled'); expect(setup.state.initialSelectionAdjusted).toBe(false);
    setup.beginMouse(selection.sessionId, 4, 2, 123, null);
    expect(setup.state.initialSelectionAdjusted).toBe(false);
  });
  it('keeps controls geometry within its owning setup session and clears it on cancellation or confirmation', async () => {
    const setup = new CanvasSetup(), controls = {x:-336,y:-176,width:320,height:560};
    setup.beginMouse(selection.sessionId,4,2,123,null,observation.rect,false,controls);
    controls.x=0;
    expect(setup.state.selectionControlsBounds?.x).toBe(-336);
    setup.preview(observation.rect, display, []); await setup.commitManual(null,async()=>{});
    expect(setup.state.selectionControlsBounds).toBeNull();
    setup.beginMouse('replacement',4,2,123,null,null,false,controls);
    setup.invalidate('Canceled'); expect(setup.state.selectionControlsBounds).toBeNull();
  });
  it('keeps a workspace suggestion unconfirmed until it passes preview and explicit manual commit', async () => {
    const setup = new CanvasSetup();
    const suggestion = observation.rect!;
    setup.observation({ ...observation, availability: 'unavailable', kind: null, rect: null, workspaceSuggestion: suggestion });
    expect(setup.state.workspaceSuggestion).toEqual(suggestion); expect(setup.state.phase).toBe('idle'); expect(setup.state.source).toBeNull();
    setup.beginMouse(selection.sessionId, 4, 2, 123, canvasIdentity(observation), suggestion);
    expect(setup.state.initialSelection).toEqual(suggestion); expect(setup.state.preview).toBeNull(); expect(setup.state.phase).toBe('selecting');
    await expect(setup.commitManual(null, async () => {})).rejects.toThrow('No mouse selection');
    setup.preview(suggestion, display, []);
    await setup.commitManual(null, async () => { expect(setup.state.source).toBeNull(); });
    expect(setup.state.source).toBe('manual'); expect(setup.state.phase).toBe('confirmed'); expect(setup.state.initialSelection).toBeNull();
  });
  it('does not approve a suggested workspace overlapping the panel and lets the user redraw it', () => {
    const setup = new CanvasSetup(); setup.beginMouse(selection.sessionId, 4, 2, 123, null, observation.rect);
    const panel = {x:-1400,y:20,width:320,height:560};
    expect(() => setup.preview(observation.rect, display, [panel])).toThrow('panel');
    expect(setup.state.preview).toBeNull(); expect(setup.state.phase).toBe('selecting');
    expect(setup.state.initialSelection).toEqual(observation.rect);
    setup.preview({x:-1800,y:0,width:300,height:500},display,[panel]);
    expect(setup.state.phase).toBe('preview');
    setup.invalidate('Canceled'); expect(setup.state.initialSelection).toBeNull(); expect(setup.state.preview).toBeNull();
  });
  it('binds selection to generation, display, target and setup session', () => {
    const setup = new CanvasSetup(); setup.beginMouse(selection.sessionId, 4, 2, 123, canvasIdentity(observation));
    expect(setup.matches(selection, 4, 123)).toBe(true);
    for (const session of [{ ...selection, generation: 3 }, { ...selection, displayId: 1 }, { ...selection, sessionId: 'old' }]) expect(setup.matches(session, 4, 123)).toBe(false);
    expect(setup.matches(selection, 5, 123)).toBe(false); expect(setup.matches(selection, 4, 321)).toBe(false);
    setup.invalidate('Canceled'); expect(setup.matches(selection, 4, 123)).toBe(false); expect(setup.state.preview).toBeNull();
  });
  it('validates preview in logical coordinates and clears a previous preview on invalid replacement', () => {
    const setup = new CanvasSetup(); setup.beginMouse('selection-1', 4, 2, 123, null);
    setup.preview(observation.rect, display, []); expect(setup.state.phase).toBe('preview'); expect(setup.state.preview).toEqual(observation.rect);
    expect(() => setup.preview({ x: -1800, y: 0, width: 99, height: 100 }, display, [])).toThrow();
    expect(setup.state.preview).toBeNull(); expect(setup.state.phase).toBe('selecting');
    expect(() => setup.preview(observation.rect, display, [{ x: -1500, y: 10, width: 320, height: 500 }])).toThrow('panel');
    setup.preview(null, display, []); expect(setup.state.phase).toBe('selecting');
  });
  it('keeps manual selection preferred across observations and invalidation until explicit detection', () => {
    const setup = new CanvasSetup(); setup.beginMouse('selection-1', 4, 2, 123, null); setup.confirmed('manual', canvasIdentity(observation));
    setup.observation(observation); expect(setup.preference).toBe('manual'); expect(setup.state.source).toBe('manual'); expect(setup.state.phase).toBe('confirmed');
    setup.invalidate('Document changed'); expect(setup.preference).toBe('manual'); expect(setup.state.source).toBeNull();
    setup.detect(); expect(setup.preference).toBe('automatic'); expect(setup.state.detection.availability).toBe('checking');
  });
  it('explains unavailable detection and labels the drawing viewport accurately', () => {
    const setup = new CanvasSetup(); setup.observation({ ...observation, availability: 'unavailable', kind: null, rect: null, reason: 'No canvas in Accessibility' });
    expect(setup.state.message).toContain('Select with mouse');
    setup.confirmed('viewport', canvasIdentity(observation)); expect(setup.state.message).toContain('gray workspace'); expect(setup.state.active).toBe(false);
  });
  it('ends the overlay session before native generation changes and confirms only after acknowledgment', async () => {
    const setup = new CanvasSetup(); setup.beginMouse(selection.sessionId, 4, 2, 123, null); setup.preview(observation.rect, display, []);
    let acknowledge!: () => void;
    const nativeAck = new Promise<void>(resolve => { acknowledge = resolve; });
    const commit = setup.commitManual(canvasIdentity(observation), async () => {
      expect(setup.state.active).toBe(false); expect(setup.state.sessionId).toBeNull();
      expect(setup.matches(selection, 5, 123)).toBe(false);
      await nativeAck;
    });
    expect(setup.state.source).toBeNull(); expect(setup.state.phase).not.toBe('confirmed');
    acknowledge(); await commit;
    expect(setup.state.source).toBe('manual'); expect(setup.state.phase).toBe('confirmed');
  });
  it('does not confirm a canvas when native configuration is rejected', async () => {
    const setup = new CanvasSetup(); setup.beginMouse(selection.sessionId, 4, 2, 123, null); setup.preview(observation.rect, display, []);
    await expect(setup.commitManual(null, async () => { throw new Error('Native rejected configuration'); })).rejects.toThrow('Native rejected');
    expect(setup.state.source).toBeNull(); expect(setup.state.phase).toBe('idle'); expect(setup.state.active).toBe(false);
  });
});

describe('canvas observation freshness and identity', () => {
  it('does not let delayed AX target observations replace newer target metadata', async () => {
    const context = { generation: 4, targetPid: 321, nativeNow: 1100, lastTimestamp: 900, uncertainty: 0 };
    let targetPid = context.targetPid, generation = context.generation, refreshes = 0, applications = 0;
    const refresh = async (): Promise<void> => { refreshes++; targetPid = 456; generation++; };
    const apply = async (): Promise<void> => { applications++; };
    for (const patch of [{ generation: 3 }, { observedAt: 899 }, { observedAt: 1101 }, { observedAt: 0 }]) {
      await routeCanvasObservation({ ...observation, ...patch }, context, refresh, apply);
    }
    expect(refreshes).toBe(0); expect(applications).toBe(0); expect(targetPid).toBe(321);
    // A fresh mismatch requests authoritative metadata. Even if that refresh
    // changes generation, none of the old observation's geometry is applied.
    await routeCanvasObservation(observation, context, refresh, apply);
    expect(refreshes).toBe(1); expect(targetPid).toBe(456); expect(generation).toBe(5); expect(applications).toBe(0);
    await routeCanvasObservation({ ...observation, targetPid: 321 }, context, refresh, apply);
    expect(refreshes).toBe(1); expect(applications).toBe(1);
  });
  it('rechecks workspace age and target after waiting for asynchronous setup prerequisites', () => {
    const suggestion = { ...observation, workspaceSuggestion: observation.rect };
    expect(freshWorkspaceSuggestion(suggestion, 4, 123, 1000, 1100)).toBe(true);
    expect(freshWorkspaceSuggestion(suggestion, 4, 123, 1000, 2500)).toBe(false);
    expect(freshWorkspaceSuggestion(suggestion, 5, 123, 1000, 1100)).toBe(false);
    expect(freshWorkspaceSuggestion(suggestion, 4, 321, 1000, 1100)).toBe(false);
    expect(freshWorkspaceSuggestion(observation, 4, 123, 1000, 1100)).toBe(false);
    expect(freshWorkspaceSuggestion(suggestion, 4, 123, -Infinity, 1100)).toBe(false);
  });
  it('rejects wrong generations, targets, stale, future and reordered results', () => {
    expect(freshCanvasObservation(observation, 4, 123, 1100, 900)).toBe(true);
    for (const patch of [{ generation: 3 }, { targetPid: 321 }, { observedAt: 900 }, { observedAt: 0 }]) expect(freshCanvasObservation({ ...observation, ...patch }, 4, 123, 1100, 900)).toBe(false);
    expect(freshCanvasObservation({ ...observation, observedAt: 1101 }, 4, 123, 1100, 900)).toBe(false);
    expect(freshCanvasObservation(observation, 4, 123, 2500, 900)).toBe(false);
  });
  it('accepts measured clock uncertainty without accepting arbitrarily future observations', () => {
    expect(freshCanvasObservation(observation, 4, 123, 995, 900, 5)).toBe(true);
    expect(freshCanvasObservation(observation, 4, 123, 994, 900, 5)).toBe(false);
    expect(freshCanvasObservation(observation, 4, 123, 995, 900, Infinity)).toBe(false);
  });
  it('tracks document/layout changes without transmitting titles', () => {
    expect(canvasIdentity(observation)).toBe(canvasIdentity({ ...observation, observedAt: 1200 }));
    for (const patch of [{ targetPid: 321 }, { windowId: 'window-2' }, { layoutToken: 'layout-2' }]) expect(canvasIdentity({ ...observation, ...patch })).not.toBe(canvasIdentity(observation));
    expect(canvasIdentity({ ...observation, layoutToken: null })).toBeNull();
  });
});

describe('window changes independent of viewport discovery', () => {
  const incomplete: CanvasObservation = { ...observation, availability: 'unavailable', kind: null, rect: null, layoutToken: null, reason: 'Searching viewport' };
  it('invalidates manual bounds when the observed workspace changes, preserving its baseline across incomplete scans', async () => {
    const setup = new CanvasSetup();
    const workspace = { ...incomplete, workspaceSuggestion: observation.rect };
    setup.beginMouse(selection.sessionId, 4, 2, 123, null, observation.rect); setup.bindObservation(workspace);
    setup.preview(observation.rect, display, []); await setup.commitManual(null, async () => {});
    expect(setup.geometryChanges({ ...workspace, layoutToken: 'unrelated-idle-controls' })).toEqual([]);
    expect(setup.geometryChanges(incomplete)).toEqual([]); setup.bindObservation(incomplete);
    expect(setup.diagnosticBaseline?.workspaceSuggestion).toEqual(observation.rect);
    expect(setup.geometryChanges(workspace)).toEqual([]);
    expect(setup.geometryChanges({ ...workspace, workspaceSuggestion: { ...observation.rect!, width: 800 } })).toEqual(['workspace-bounds']);
  });
  it('invalidates a confirmed manual rectangle after move or resize even if every deep scan is incomplete', async () => {
    const setup = new CanvasSetup(); setup.beginMouse(selection.sessionId, 4, 2, 123, null); setup.bindObservation(incomplete);
    setup.preview(observation.rect, display, []); await setup.commitManual(null, async () => {});
    expect(setup.state.phase).toBe('confirmed'); expect(setup.identity).toBeNull();
    expect(setup.geometryChanged({ ...incomplete, observedAt: 1500 })).toBe(false);
    for (const patch of [{ x: -1800 }, { y: 0 }, { width: 1700 }, { height: 800 }]) expect(setup.geometryChanged({ ...incomplete, windowBounds: { ...incomplete.windowBounds!, ...patch } })).toBe(true);
  });
  it('preserves known layout and document metadata through a temporarily incomplete scan', () => {
    const setup = new CanvasSetup(); setup.confirmed('manual', canvasIdentity(observation)); setup.bindObservation(observation);
    expect(setup.geometryChanged({ ...incomplete, windowToken: null })).toBe(false);
    setup.bindObservation({ ...incomplete, windowToken: null });
    expect(setup.geometryChanged(observation)).toBe(false);
    expect(setup.geometryChanged({ ...observation, layoutToken: 'layout-2' })).toBe(false);
    expect(setup.geometryChanged({ ...incomplete, windowToken: 'document-2' })).toBe(true);
  });
  it('detects a closed, replaced, or unreadable root window without requiring a layout hash', () => {
    const setup = new CanvasSetup(); setup.bindObservation(incomplete);
    for (const patch of [{ targetPid: 321 }, { windowId: 'window-2' }, { windowId: null }, { windowBounds: null }]) expect(setup.geometryChanged({ ...incomplete, ...patch })).toBe(true);
    setup.invalidate('Canceled'); expect(setup.geometryChanged({ ...incomplete, windowId: 'window-2' })).toBe(false);
  });
  it('binds the root window while selecting, before any viewport or layout is found', () => {
    const setup = new CanvasSetup(); setup.beginMouse(selection.sessionId, 4, 2, 123, null);
    setup.bindObservation(incomplete);
    expect(setup.matches(selection, 4, 123)).toBe(true);
    expect(setup.geometryChanged({ ...incomplete, windowBounds: { ...incomplete.windowBounds!, width: 1500 } })).toBe(true);
  });
  it('ignores unrelated widget-tree hash churn while still detecting direct viewport changes', () => {
    const setup = new CanvasSetup(); setup.confirmed('manual', canvasIdentity(observation)); setup.bindObservation(observation);
    for (let index = 0; index < 6; index++) {
      const idle = { ...observation, layoutToken: `transient-docker-${index}`, observedAt: 1100 + index * 500 };
      expect(setup.geometryChanges(idle)).toEqual([]); setup.bindObservation(idle);
      expect(setup.state.phase).toBe('confirmed');
    }
    expect(setup.geometryChanges({ ...observation, rect: { ...observation.rect!, width: 800 } })).toEqual(['viewport-bounds']);
    expect(setup.geometryChanges({ ...observation, windowBounds: { ...observation.windowBounds!, width: 1700 } })).toEqual(['window-bounds']);
    expect(setup.geometryChanges({ ...observation, windowToken: 'another-document' })).toEqual(['document']);
  });
  it('preserves an inspectable baseline through manual confirmation and distinguishes missing metadata from layout changes', async () => {
    const setup = new CanvasSetup(); setup.beginMouse(selection.sessionId, 4, 2, 123, null); setup.bindObservation(incomplete);
    setup.preview(observation.rect, display, []); await setup.commitManual(null, async () => {});
    expect(setup.diagnosticBaseline?.windowBounds).toEqual(incomplete.windowBounds);
    expect(setup.diagnosticBaseline).not.toHaveProperty('diagnostics');
    expect(setup.geometryChanges({ ...incomplete, windowBounds: null })).toEqual(['window-geometry-unavailable']);
  });
});
