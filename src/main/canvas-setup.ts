import type { CanvasObservation, CanvasObservationSummary, CanvasSelectionSession, CanvasSetupStatus, Point, Rect } from '../shared/contracts';
import { validateCanvas } from './canvas';

interface WindowSnapshot {
  targetPid: number; windowId: string; bounds: Rect | null; token: string | null; viewport: Rect | null; workspace: Rect | null;
}
export const sameCanvasRect = (a: Rect | null, b: Rect | null): boolean => a !== null && b !== null &&
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Setup state is ephemeral. A renderer can propose geometry only for its own session. */
export class CanvasSetup {
  preference: 'automatic' | 'manual' | 'legacy' = 'automatic';
  targetPid: number | null = null;
  sessionGeneration = -1;
  identity: string | null = null;
  private windowSnapshot: WindowSnapshot | null = null;
  private boundObservation: CanvasObservationSummary | null = null;
  get diagnosticBaseline(): CanvasObservationSummary | null {
    if (!this.boundObservation) return null;
    const baseline = structuredClone(this.boundObservation), window = this.windowSnapshot;
    return window ? { ...baseline, targetPid: window.targetPid, windowId: window.windowId,
      windowBounds: window.bounds ? { ...window.bounds } : null, windowToken: window.token,
      workspaceSuggestion: window.workspace ? { ...window.workspace } : null,
      rect: window.viewport ? { ...window.viewport } : null, kind: window.viewport ? 'viewport' : null } : baseline;
  }
  state: CanvasSetupStatus = {
    active: false, firstCorner: null, message: 'Looking for a Krita drawing area. You can also select it with your mouse.',
    mode: 'detect', phase: 'idle', sessionId: null, displayId: null, preview: null, initialSelection: null, initialSelectionAdjusted: false, selectionControlsBounds: null, workspaceSuggestion: null, source: null,
    detection: { availability: 'checking', reason: 'Waiting for Accessibility canvas information.' },
  };
  invalidate(message: string): void {
    this.state = { ...this.state, active: false, firstCorner: null, mode: 'idle', phase: 'idle', sessionId: null, displayId: null, preview: null, initialSelection: null, initialSelectionAdjusted: false, selectionControlsBounds: null, workspaceSuggestion: null, source: null, message };
    this.targetPid = null; this.sessionGeneration = -1; this.identity = null; this.windowSnapshot = null; this.boundObservation = null;
  }
  detect(): void {
    this.invalidate('Looking for the document page or drawing viewport in Krita.'); this.preference = 'automatic'; this.state.mode = 'detect';
    this.state.detection = { availability: 'checking', reason: 'Waiting for fresh Accessibility information.' };
  }
  beginMouse(sessionId: string, generation: number, displayId: number, targetPid: number, identity: string | null, initialSelection: Rect | null = null, initialSelectionAdjusted = false, selectionControlsBounds: Rect | null = null): void {
    this.invalidate('Drag a rectangle around the drawing area, then choose Use canvas.'); this.preference = 'manual';
    Object.assign(this.state, { active: true, mode: 'mouse', phase: 'selecting', sessionId, displayId });
    this.state.initialSelection = initialSelection ? { ...initialSelection } : null;
    this.state.initialSelectionAdjusted = Boolean(initialSelection && initialSelectionAdjusted);
    this.state.selectionControlsBounds = selectionControlsBounds ? { ...selectionControlsBounds } : null;
    if (initialSelection) this.state.message = 'Review the suggested workspace. It may include tabs, rulers, or scrollbars. Drag to replace it, then choose Use canvas.';
    this.targetPid = targetPid; this.sessionGeneration = generation; this.identity = identity;
  }
  matches(session: CanvasSelectionSession, generation: number, targetPid: number | null | undefined): boolean {
    return this.state.mode === 'mouse' && this.state.active && session.sessionId === this.state.sessionId &&
      session.displayId === this.state.displayId && session.generation === generation && generation === this.sessionGeneration && this.targetPid === targetPid;
  }
  validateSurface(submitted: Rect | null, actual: Rect | null): void {
    if (sameCanvasRect(submitted, actual)) return;
    this.state.preview = null; this.state.phase = 'selecting';
    this.state.message = 'The selection window moved. Drag the canvas rectangle again before confirming.';
    throw new Error(this.state.message);
  }
  preview(selection: Rect | null, display: Rect, excluded: readonly Rect[]): void {
    this.state.preview = null; this.state.phase = 'selecting';
    if (!selection) return;
    this.state.preview = validateCanvas({ x: selection.x, y: selection.y }, { x: selection.x + selection.width, y: selection.y + selection.height }, display, excluded);
    this.state.phase = 'preview';
  }
  confirmed(source: 'manual' | 'document' | 'viewport', identity: string | null): void {
    this.invalidate(source === 'viewport' ? 'Krita drawing viewport detected (may include gray workspace). Input stays paused; Resume when ready.' : 'Canvas confirmed. Input stays paused; Resume when ready.');
    this.identity = identity; this.state.source = source; this.state.phase = 'confirmed';
  }
  async commitManual(identity: string | null, configure: () => Promise<void>): Promise<void> {
    if (this.state.mode !== 'mouse' || !this.state.active || this.state.phase !== 'preview') throw new Error('No mouse selection to confirm.');
    // End the renderer session before the native generation advances. Confirmation
    // is published only after the native configuration has actually succeeded.
    const windowSnapshot = this.windowSnapshot;
    const boundObservation = this.boundObservation;
    this.invalidate('Applying canvas; input stays paused.');
    try { await configure(); this.confirmed('manual', identity); this.windowSnapshot = windowSnapshot; this.boundObservation = boundObservation; }
    catch (error) { this.invalidate('Canvas confirmation failed. Select with mouse again.'); throw error; }
  }
  legacy(active: boolean, firstCorner: Point | null, message: string): void {
    this.preference = 'legacy'; Object.assign(this.state, { mode: 'legacy', active, firstCorner, message });
  }
  /** Root window geometry is observable even while deep viewport discovery is incomplete. */
  geometryChanges(observation: CanvasObservation): string[] {
    const previous = this.windowSnapshot;
    const changes: string[] = [];
    if (previous && observation.targetPid !== previous.targetPid) changes.push('target');
    if (previous && observation.windowId !== previous.windowId) changes.push(observation.windowId === null ? 'window-unavailable' : 'window');
    if (previous?.bounds && !sameCanvasRect(previous.bounds, observation.windowBounds)) changes.push(observation.windowBounds === null ? 'window-geometry-unavailable' : 'window-bounds');
    if (previous?.token && observation.windowToken !== null && previous.token !== observation.windowToken) changes.push('document');
    if (previous?.viewport && observation.rect !== null && !sameCanvasRect(previous.viewport, observation.rect)) changes.push('viewport-bounds');
    if (previous?.workspace && observation.workspaceSuggestion !== null && !sameCanvasRect(previous.workspace, observation.workspaceSuggestion)) changes.push('workspace-bounds');
    // A whole-tree layout hash also includes transient docker/control geometry.
    // Only stable root/document information or a directly observed viewport or
    // surrounding workspace can prove that a screen rectangle is stale.
    return changes;
  }
  geometryChanged(observation: CanvasObservation): boolean { return this.geometryChanges(observation).length > 0; }
  bindObservation(observation: CanvasObservation): void {
    if (observation.targetPid !== null && observation.windowId !== null) {
      const previous = this.windowSnapshot;
      const sameWindow = previous?.targetPid === observation.targetPid && previous?.windowId === observation.windowId;
      this.windowSnapshot = { targetPid: observation.targetPid, windowId: observation.windowId,
        bounds: observation.windowBounds ? { ...observation.windowBounds } : sameWindow ? previous.bounds : null,
        token: observation.windowToken ?? (sameWindow ? previous.token : null),
        viewport: observation.rect ? { ...observation.rect } : sameWindow ? previous.viewport : null,
        workspace: observation.workspaceSuggestion ? { ...observation.workspaceSuggestion } : sameWindow ? previous.workspace : null };
    }
    const { diagnostics: _diagnostics, ...summary } = observation;
    this.boundObservation = structuredClone(summary);
    const layout = canvasIdentity(observation);
    if (layout !== null) this.identity = layout;
  }
  observation(observation: CanvasObservation): void {
    this.state.detection = { availability: observation.availability, reason: observation.reason };
    this.state.workspaceSuggestion = observation.workspaceSuggestion ? { ...observation.workspaceSuggestion } : null;
    if (this.preference === 'automatic' && this.state.phase !== 'confirmed') this.state.message = observation.availability === 'unavailable'
      ? `${observation.reason} ${observation.workspaceSuggestion ? 'Review the suggested workspace or select with mouse.' : 'Select with mouse to continue.'}` : 'Drawing area detected; checking bounds.';
  }
}

export const canvasIdentity = (observation: CanvasObservation): string | null => observation.targetPid !== null && observation.windowId !== null && observation.layoutToken !== null
  ? JSON.stringify([observation.targetPid, observation.windowId, observation.layoutToken]) : null;

export function freshCanvasObservation(observation: CanvasObservation, generation: number, targetPid: number | null | undefined, nativeNow: number, lastTimestamp: number, clockUncertainty = 0): boolean {
  return observation.generation === generation && observation.targetPid === targetPid && observation.observedAt > lastTimestamp &&
    clockUncertainty >= 0 && clockUncertainty <= 10 && observation.observedAt <= nativeNow + clockUncertainty && nativeNow - observation.observedAt < 1500;
}

/** An AX observation can request a target refresh, but cannot assign target identity.
 * A refresh can change generation/session; never apply the pre-refresh geometry.
 */
export async function routeCanvasObservation(observation: CanvasObservation,
  context: { generation: number; targetPid: number | null | undefined; nativeNow: number; lastTimestamp: number; uncertainty: number },
  refreshTarget: () => Promise<unknown>, apply: (observation: CanvasObservation) => Promise<void>): Promise<void> {
  if (!freshCanvasObservation(observation, context.generation, observation.targetPid, context.nativeNow, context.lastTimestamp, context.uncertainty)) return;
  if (observation.targetPid !== context.targetPid) { await refreshTarget(); return; }
  await apply(observation);
}

/** Recheck after asynchronous prerequisites; a fresh button press can expire while waiting for the helper. */
export function freshWorkspaceSuggestion(observation: CanvasObservation | null, generation: number, targetPid: number | null | undefined, receivedAt: number, now: number): boolean {
  return Boolean(observation?.workspaceSuggestion && observation.generation === generation && observation.targetPid === targetPid &&
    Number.isFinite(receivedAt) && Number.isFinite(now) && now >= receivedAt && now - receivedAt < 1500);
}
