import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, net, powerMonitor, protocol, screen, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NativeSupervisor } from './supervisor';
import { emptySpeechDiagnostics, isSpeechDiagnosticError, SpeechDiagnosticRecorder } from './speech-diagnostics';
import { LiveProbe } from './live-probe';
import { PANEL_COLLAPSED_HEIGHT, PANEL_HEIGHT, PANEL_WIDTH, SETTINGS_HEIGHT, SETTINGS_WIDTH, TOAST_HEIGHT, TOAST_WIDTH, UTILITY_SIZE, canvasSelectionControlsFrame, panelPosition, preferredDisplay, sameCanvasSelectionDisplay, settingsFrame, toastPosition, utilityPosition, type UtilityView } from './panel';
import { CanvasCapture, containsPoint, fitWorkspaceSuggestion, intersects, validateCanvas } from './canvas';
import { CanvasSetup, canvasIdentity, freshCanvasObservation, freshWorkspaceSuggestion, routeCanvasObservation, sameCanvasRect } from './canvas-setup';
import { CanvasDiagnostics } from './canvas-diagnostics';
import { GlobalBindingInstaller, defaultBindings, kritaProfile, isLocalAction, hitSurfaces, resolveBinding, validateBindings, validateProfile } from './commands';
import { freshPointer, mappedSampleAllowed, readyForControl } from './input-gates';
import { resourcesRoot, verifyResources } from './resources';
import { ACTIONS, type Ack, type ActionID, type LocalActionID, type Point, type DisplayInfo, type Mode, type ProbeStatus, type Rect, type TrackingSample, type CanvasObservation, type CanvasSelectionSession, type ToastMessage } from '../shared/contracts';
import { isObject, rect, uint, point, finite } from './protocol';
import { isTrackingSample } from '../shared/tracking-validation';
import { DisplayLayoutGuard } from './display-layout';
import { ConfigurationQueue } from './configuration';
import { deliverCommand } from './command-delivery';
import { SettingsStore } from './settings';
import { defaultSettings, withCalibration } from '../shared/settings';
import { isCalibrationV1 } from '../renderer/engine';
import { ElectronVoice } from './voice/electron-voice';
import { dispatchVoiceCommand } from './voice/command-dispatch';
import { anthropicKey, createIntentClient, interpretPlan, type IntentClient } from './voice/intent';
import type { PlanStep } from './voice/plan';
import { explainRejection } from './rejections';
import type { CommandEvent } from './voice/types';
import type { VoiceCaptureReport } from '../shared/voice';
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

protocol.registerSchemesAsPrivileged([{ scheme: 'steady-resource', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let realInput = false;
const testFakeBackend = process.argv.includes('--test-fake-backend');
const canvasCapture = new CanvasCapture();
const canvasSetup = new CanvasSetup();
const canvasDiagnostics = new CanvasDiagnostics();
let selectionOverlay: BrowserWindow | null = null, canvasOutline: BrowserWindow | null = null;
let latestCanvasObservation: CanvasObservation | null = null;
let latestCanvasReceivedAt = -Infinity;
let canvasObservationPending = false;
let canvas: Rect | null = null;
let pointer: { position: Point; timestamp: number; generation: number } | null = null;
let nativeConfiguredTarget: number | null = null;
let knownPanelOrigin: Point | null = null;
let panelGeometryPending = false;
let panelGeometryEpoch = 0;
let movingPanelProgrammatically = false;
const bindingInstaller = new GlobalBindingInstaller(globalShortcut);
let panel: BrowserWindow | null = null, settings: BrowserWindow | null = null, supervisor: NativeSupervisor | null = null;
/** Figma (Statheros 2): the Camera Preview is its own movable window beside the compact panel. */
const utilities: Record<UtilityView, BrowserWindow | null> = { preview: null };
/** Advanced (developer) settings: the former settings page, kept for real input, canvas, bindings and diagnostics. */
let advanced: BrowserWindow | null = null;
/** Transient notifications. Click-through and never excluded, so showing one never changes input geometry. */
let toastWindow: BrowserWindow | null = null;
/** Panel plus the Camera Preview. The native helper excludes both from drawing input. */
function overlaySurfaces(): BrowserWindow[] {
  return [panel, utilities.preview].filter((win): win is BrowserWindow => Boolean(win && !win.isDestroyed()));
}
let voice: ElectronVoice | null = null;
let quitting = false, generation = 1;
let settingsStore: SettingsStore;
const configuration = new ConfigurationQueue();
let savedSettings = defaultSettings();
async function configureControl(setup = false): Promise<void> {
  pointer = null;
  if (canvasSetup.state.mode === 'mouse' && canvasSetup.state.active && canvasSetup.sessionGeneration !== generation) invalidateCanvas('Canvas selection expired after configuration changed. Select with mouse again.');
  if (!supervisor || status.selectedDisplayId === undefined || !status.targetPid) {
    await pause('Open Krita, then Recover native helper before configuring control.'); return;
  }
  // Only the panel must stay off the canvas. The utilities float over it as in Figma; the
  // helper still treats them as excluded, so a stroke that reaches one lifts the pen.
  const bounds = panel?.getBounds();
  if (canvas && bounds && intersects(canvas, bounds)) {
    invalidateCanvas('Panel overlaps the canvas. Move the panel, then select or detect the canvas again.');
    status.fault = canvasSetup.state.message;
  }
  await supervisor.request('configure', { generation, targetBundleId: 'org.krita', targetPid: status.targetPid,
    displayId: status.selectedDisplayId, canvas: setup ? null : canvas, excludedRects: overlaySurfaces().map(win => win.getBounds()) });
  nativeConfiguredTarget = status.targetPid;
  if (!setup) await supervisor.request('action', { generation, eventId: randomUUID(), actionId: 'pause' });
  publish();
}
function closeCanvasWindows(): void {
  const overlay = selectionOverlay; selectionOverlay = null;
  const outline = canvasOutline; canvasOutline = null;
  overlay?.destroy(); outline?.destroy();
}
function invalidateCanvas(message = 'Canvas confirmation required. Select or detect the drawing area again.'): void {
  canvas = null; canvasCapture.cancel(); pointer = null; status.canvasConfirmed = false;
  closeCanvasWindows(); canvasSetup.invalidate(message);
}
async function beginLegacyCanvas(): Promise<void> {
  if(panelGeometryPending)throw new Error('Wait for panel geometry to settle, then Set canvas again.');
  await pause('Canvas setup requested; pen up.');
  // Refresh target identity/foreground metadata before using UI prerequisites.
  await supervisor?.request('ping', { senderTimestamp: performance.now() });
  const reason = readyForControl({ ...status, generation }, false);
  if (reason) throw new Error(reason);
  if (!fixedKritaProfile()) throw new Error('Select the fixed Krita profile before canvas setup. Generic profiles are configuration previews.');
  invalidateCanvas(); generation++; canvasCapture.begin();
  canvasSetup.legacy(true, null, canvasCapture.message);
  await configureControl(true); publish();
}
async function cancelCanvas(sessionId?: string): Promise<void> {
  if (sessionId !== undefined && sessionId !== canvasSetup.state.sessionId) throw new Error('Canvas selection expired.');
  const restorePid = selectionOverlay ? canvasSetup.targetPid : null;
  invalidateCanvas('Canvas setup canceled; input stays paused.');
  // Cancellation must remain canceled until an explicit detection request.
  canvasSetup.preference = 'manual';
  await pause('Canvas setup canceled; input stays paused.');
  generation++; await configureControl(); publish();
  if (restorePid) await supervisor?.request('restoreTarget', { targetPid: restorePid });
}

function selectedDisplay(): DisplayInfo {
  const display = status.displays.find(item => item.id === status.selectedDisplayId);
  if (!display) throw new Error('Select an available display.');
  return display;
}
async function canvasPrerequisites(): Promise<void> {
  if (panelGeometryPending) throw new Error('Wait for the panel to stop moving before canvas setup.');
  if (status.settingsOpen) throw new Error('Close Settings before canvas setup.');
  if (!supervisor || status.nativeFault || !status.nativeClockReady) throw new Error('Recover the native helper first.');
  await supervisor.request('ping', { senderTimestamp: performance.now() });
  if (!status.targetPid || status.native?.foregroundTarget !== 'org.krita') throw new Error('Open a Krita document and keep Krita foreground before setting the canvas.');
  if (!fixedKritaProfile()) throw new Error('Select the fixed Krita profile before canvas setup.');
  selectedDisplay();
}
async function beginCanvas(): Promise<void> {
  await pause('Canvas detection requested; input stays paused.');
  await canvasPrerequisites(); invalidateCanvas(); canvasSetup.detect();
  latestCanvasObservation = null; latestCanvasReceivedAt = -Infinity;
  generation++; await configureControl(); status.fault = null; publish();
}
async function selectCanvas(initialSelection: Rect | null = null, reviewObservation: CanvasObservation | null = null): Promise<void> {
  await pause('Mouse canvas selection requested; pen up.');
  await canvasPrerequisites();
  if (reviewObservation && (reviewObservation !== latestCanvasObservation || !freshWorkspaceSuggestion(reviewObservation, generation, status.targetPid, latestCanvasReceivedAt, performance.now()))) {
    throw new Error('The workspace suggestion expired while preparing selection. Keep Krita ready and try again, or Select with mouse.');
  }
  const display = selectedDisplay(), pid = status.targetPid!;
  if (!panel || panel.isDestroyed()) throw new Error('Steady panel is unavailable. Restart Steady before canvas setup.');
  let controlsBounds = canvasSelectionControlsFrame(panel.getBounds(), display);
  // A selector has one visible controls area, over the existing panel. If the
  // panel is off-display or clipped, bring that same panel to the reachable
  // position before configuring its exclusion rectangle. No focus is taken.
  if (panel.getBounds().x !== controlsBounds.x || panel.getBounds().y !== controlsBounds.y) {
    movingPanelProgrammatically = true;
    try {
      panel.setPosition(controlsBounds.x, controlsBounds.y, false);
      knownPanelOrigin = panel.getBounds();
    } finally { movingPanelProgrammatically = false; }
    controlsBounds = canvasSelectionControlsFrame(panel.getBounds(), display);
  }
  // A suggestion remains untrusted until the overlay submits and confirms it.
  // Fit around the panel before showing the draft. The overlay still validates
  // and requires explicit confirmation; an impossible fit remains redrawable.
  const seed = initialSelection ? fitWorkspaceSuggestion(initialSelection, display.bounds, panel?.getBounds() ?? null) : null;
  const seedAdjusted = Boolean(seed && initialSelection && !sameCanvasRect(seed, initialSelection));
  const baseline = latestCanvasObservation;
  const identity = baseline ? canvasIdentity(baseline) : null;
  invalidateCanvas(); generation++;
  const session = { sessionId: randomUUID(), generation, displayId: display.id };
  canvasSetup.beginMouse(session.sessionId, generation, display.id, pid, identity, seed, seedAdjusted, controlsBounds);
  if (baseline) canvasSetup.bindObservation(baseline);
  await configureControl();
  selectionSession(session);
  if (status.native?.buttonDown || status.nativeFault) throw new Error('Input could not be released. Recover the helper before selecting.');
  const overlay = new BrowserWindow({ ...display.bounds, frame: false, transparent: true, backgroundColor: '#00000000',
    show: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: false, skipTaskbar: true, focusable: true, alwaysOnTop: true, title: 'Steady — Select canvas',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, zoomFactor: 1 } });
  selectionOverlay = overlay;
  overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(false); secureWindow(overlay); trackCanvasSurface(overlay);
  overlay.on('closed', () => { if (selectionOverlay === overlay) { selectionOverlay = null; void configuration.run(() => cancelCanvas()).catch(error => fault(String(error))); } });
  overlay.on('blur', () => {
    if (selectionOverlay === overlay) void configuration.run(async () => {
      if (selectionOverlay !== overlay) return;
      // A user switching applications cancels selection without stealing focus back.
      invalidateCanvas('Selection lost focus; canvas unconfirmed. Select with mouse again.');
      await pause(canvasSetup.state.message); generation++; await configureControl();
    }).catch(error => fault(String(error)));
  });
  status.fault = null; publish();
  try { await loadView(overlay, 'canvas-overlay'); if (selectionOverlay === overlay) { overlay.show(); overlay.focus(); } }
  catch (error) { invalidateCanvas('Could not open canvas selection. Try Select with mouse again.'); await pause(canvasSetup.state.message); throw error; }
}
async function reviewWorkspace(): Promise<void> {
  const observation = latestCanvasObservation;
  if (!freshWorkspaceSuggestion(observation, generation, status.targetPid, latestCanvasReceivedAt, performance.now())) {
    throw new Error('No fresh workspace suggestion is available. Keep Krita ready and try Detect canvas, or Select with mouse.');
  }
  await selectCanvas({ ...observation!.workspaceSuggestion! }, observation);
}
function selectionSession(value: unknown): CanvasSelectionSession {
  if (!isObject(value) || typeof value.sessionId !== 'string' || !uint(value.generation) || !uint(value.displayId) ||
    !canvasSetup.matches(value as unknown as CanvasSelectionSession, generation, status.targetPid) || panelGeometryPending) throw new Error('Canvas selection expired. Start Select with mouse again.');
  return value as unknown as CanvasSelectionSession;
}
function selectionSurface(value: unknown): void {
  try {
    canvasSetup.validateSurface(isObject(value) && rect(value.surfaceBounds) ? value.surfaceBounds as Rect : null, selectionOverlay?.getContentBounds() ?? null);
  } finally { publish(); }
}
async function confirmCanvas(value: unknown): Promise<void> {
  selectionSession(value);
  selectionSurface(value);
  const proposed = canvasSetup.state.preview;
  if (!proposed || canvasSetup.state.phase !== 'preview') throw new Error('Drag and preview a valid rectangle before choosing Use canvas.');
  const display = selectedDisplay(), bounds = panel?.getBounds();
  let validated: Rect;
  try {
    validated = validateCanvas(proposed, { x: proposed.x + proposed.width, y: proposed.y + proposed.height }, display.bounds, bounds ? [bounds] : []);
    canvasDiagnostics.selectionValidated({ stage: 'confirm', selection: proposed, displayBounds: display.bounds, panelBounds: bounds ?? null, controlsBounds: canvasSetup.state.selectionControlsBounds, surfaceBounds: selectionOverlay?.getContentBounds() ?? null, accepted: true });
  } catch (error) {
    canvasDiagnostics.selectionValidated({ stage: 'confirm', selection: proposed, displayBounds: display.bounds, panelBounds: bounds ?? null, controlsBounds: canvasSetup.state.selectionControlsBounds, surfaceBounds: selectionOverlay?.getContentBounds() ?? null, accepted: false });
    publish(); throw error;
  }
  const pid = canvasSetup.targetPid!, identity = canvasSetup.identity;
  closeCanvasWindows();
  try {
    await supervisor!.request('restoreTarget', { targetPid: pid });
    // Application activation is asynchronous. Poll metadata without resuming input.
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      await supervisor!.request('ping', { senderTimestamp: performance.now() });
      if (status.native?.foregroundTarget === 'org.krita') break;
    }
    selectionSession(value);
    if (status.native?.foregroundTarget !== 'org.krita') throw new Error('Return to Krita and select the canvas again.');
    await canvasSetup.commitManual(identity, async () => {
      canvas = validated; status.canvasConfirmed = false; generation++;
      await configureControl();
      if (!canvas) throw new Error(canvasSetup.state.message);
    });
    status.canvasConfirmed = true; status.fault = null;
    trackingEvidence('canvas-confirmed', { canvas, source: 'manual', realInput }); publish();
    void showCanvasOutline();
  } catch (error) { invalidateCanvas('Canvas confirmation failed. Select with mouse again.'); await pause(canvasSetup.state.message); throw error; }
}
async function showCanvasOutline(): Promise<void> {
  if (!canvas || selectionOverlay) return;
  const outline = new BrowserWindow({ ...selectedDisplay().bounds, frame: false, transparent: true, backgroundColor: '#00000000', show: false,
    focusable: false, resizable: false, movable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, zoomFactor: 1 } });
  canvasOutline?.destroy(); canvasOutline = outline;
  outline.setIgnoreMouseEvents(true); outline.setAlwaysOnTop(true, 'screen-saver'); outline.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); secureWindow(outline); trackCanvasSurface(outline);
  try { await loadView(outline, 'canvas-outline'); if (canvasOutline === outline) outline.showInactive(); }
  catch { if (canvasOutline === outline) canvasOutline = null; outline.destroy(); }
  setTimeout(() => { if (canvasOutline === outline) canvasOutline = null; if (!outline.isDestroyed()) outline.destroy(); }, 1200);
}

async function observeCanvas(observation: CanvasObservation, native: NativeSupervisor): Promise<void> {
  if (supervisor !== native || !status.nativeClockReady || status.nativeFault) return;
  let nativeNow: number;
  try { nativeNow = native.clock.convert(performance.now(), performance.now()); } catch { return; }
  if (!freshCanvasObservation(observation, generation, status.targetPid, nativeNow, latestCanvasObservation?.observedAt ?? -Infinity, native.clock.uncertainty)) return;
  latestCanvasObservation = observation; latestCanvasReceivedAt = performance.now(); canvasSetup.observation(observation); canvasDiagnostics.observe(observation);
  const identity = canvasIdentity(observation);
  if (canvasSetup.preference !== 'automatic') {
    const changes = canvasSetup.geometryChanges(observation);
    if ((canvas || canvasSetup.state.active) && changes.length > 0) {
      const reason = changes.some(change => change.endsWith('unavailable')) ? 'Krita window information became unavailable. Select the drawing area again when it is readable.' :
        changes.includes('window-bounds') ? 'Krita window moved or resized. Select the drawing area again.' :
        changes.includes('document') ? 'Krita document changed. Select the drawing area again.' :
        changes.includes('viewport-bounds') ? 'Krita drawing viewport changed. Select the drawing area again.' :
        changes.includes('workspace-bounds') ? 'Krita document workspace changed. Select the drawing area again.' : 'Krita target window changed. Select the drawing area again.';
      canvasDiagnostics.invalidated(reason, changes, canvasSetup.diagnosticBaseline, observation);
      invalidateCanvas(reason);
      await pause(canvasSetup.state.message); generation++; await configureControl();
    } else canvasSetup.bindObservation(observation);
    publish(); return;
  }
  if (status.settingsOpen || panelGeometryPending || !fixedKritaProfile() || status.native?.foregroundTarget !== 'org.krita') {
    // A known geometry change must clear old bounds even while another app or
    // Settings is foreground. A later Resume must not race the next AX poll.
    if (canvas && (canvasSetup.geometryChanged(observation) || observation.availability !== 'available' || !sameCanvasRect(canvas, observation.rect))) {
      const reason = 'Krita drawing area changed or could not be verified. Return to Krita to detect it again, or Select with mouse.';
      canvasDiagnostics.invalidated(reason, canvasSetup.geometryChanges(observation), canvasSetup.diagnosticBaseline, observation);
      invalidateCanvas(reason);
      await pause(canvasSetup.state.message); generation++; await configureControl();
    }
    publish(); return;
  }
  if (observation.availability !== 'available' || !observation.rect || !observation.kind) {
    if (canvas) {
      const reason = `${observation.reason} Select with mouse to continue.`;
      canvasDiagnostics.invalidated(reason, ['viewport-unavailable'], canvasSetup.diagnosticBaseline, observation);
      invalidateCanvas(reason); await pause(canvasSetup.state.message); generation++; await configureControl();
    }
    publish(); return;
  }
  const display = selectedDisplay(), bounds = panel?.getBounds();
  let detected: Rect;
  try { detected = validateCanvas(observation.rect, { x: observation.rect.x + observation.rect.width, y: observation.rect.y + observation.rect.height }, display.bounds, bounds ? [bounds] : []); }
  catch (error) {
    canvasSetup.state.detection = { availability: 'unavailable', reason: String(error) };
    if (canvas) { invalidateCanvas(String(error)); await pause(String(error)); generation++; await configureControl(); }
    canvasSetup.state.message = `${String(error)} Select with mouse, or move the panel and detect again.`; publish(); return;
  }
  if (canvas && sameCanvasRect(canvas, detected) && !canvasSetup.geometryChanged(observation) && canvasSetup.state.source === observation.kind) { canvasSetup.bindObservation(observation); publish(); return; }
  await pause('Krita drawing area changed; input stays paused.');
  closeCanvasWindows(); canvas = detected; status.canvasConfirmed = false; generation++;
  try {
    await configureControl(); if (!canvas) return;
    canvasSetup.confirmed(observation.kind, identity); canvasSetup.bindObservation(observation); status.canvasConfirmed = true; status.fault = null; publish(); void showCanvasOutline();
  } catch (error) { invalidateCanvas('Detected bounds could not be configured. Select with mouse or recover the helper.'); throw error; }
}
function installBindings(): void {
  status.bindingConflicts = bindingInstaller.install(status.bindings ?? defaultBindings(), action => {
    const resolved = resolveBinding(action, canvasCapture.active);
    void userAction(resolved).catch(error => fault(String(error)));
  });
  publish();
}

let status: ProbeStatus = { native: null, displays: [], fault: null, collapsed: false, settingsOpen: false, generation, realInput, microphoneEnabled: false };
/** Tracked-click targets per overlay surface, keyed by webContents id, in window-local coordinates. */
const surfaceButtons = new Map<number, {actionId:LocalActionID;rect:Rect}[]>();
let speechSession: string | null = null;
const speechSeen = new Set<string>();
let shutdownStarted = false;
let resourcesReady=false;
let liveProbe: ChildProcessWithoutNullStreams | null = null;
let liveProbeLifecycle: LiveProbe | null = null;
function trackingEvidence(type: string, data: unknown): void {
  const directory=path.join(app.getPath('userData'),'phase03-evidence');mkdirSync(directory,{recursive:true});
  appendFileSync(path.join(directory,'tracking.jsonl'),JSON.stringify({v:1,type,time:new Date().toISOString(),evidence:'physical-camera operator trial or automated harness; classify by session launch',cameraId:savedSettings.cameraId,mode:savedSettings.mode,displayId:status.selectedDisplayId,data})+'\n');
}
function stopLiveProbe(): void { liveProbeLifecycle?.cancel(); }
function releaseRealInput(): void { spawnSync(path.join(resourcesRoot(),'bin','SteadyNative'),['--release-and-exit',testFakeBackend?'--test-fake-backend':'--real-input'],{stdio:'ignore',timeout:1000}); }
function publish(): void {
  if (canvasCapture.active) canvasSetup.legacy(true, canvasCapture.firstCorner, canvasCapture.message);
  status = {...status, generation, realInput, canvas, canvasSetup: structuredClone(canvasSetup.state), canvasDiagnostics: canvasDiagnostics.snapshot()};
  for (const win of [panel,settings,advanced,selectionOverlay,canvasOutline,utilities.preview]) if (win && !win.isDestroyed()) win.webContents.send('steady:status-changed', statusForWindow(win));
}
function statusForWindow(win: BrowserWindow): ProbeStatus {
  // Screen/AX geometry and Electron content bounds are logical points. macOS
  // can clamp the requested window origin, so display bounds are not a valid
  // substitute for the actual page origin used by clientX/clientY and CSS.
  return win === selectionOverlay || win === canvasOutline ? { ...status, canvasSurfaceBounds: win.getContentBounds() } : status;
}
function trackCanvasSurface(win: BrowserWindow): void {
  const changed = (): void => { if (!win.isDestroyed() && (win === selectionOverlay || win === canvasOutline)) publish(); };
  win.on('move', changed); win.on('resize', changed); win.on('show', changed);
  win.webContents.on('did-finish-load', () => { win.webContents.setZoomFactor(1); changed(); });
  // Keep CSS pixels equal to content logical points; visual zoom is disabled
  // by default, and these keys must not activate the application menu's zoom.
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && ['+', '=', '-', '0'].includes(input.key)) event.preventDefault();
  });
}
function fault(message: string): void { status.fault = message; publish(); }
async function pause(reason: string): Promise<void> {
  stopLiveProbe();
  if (!supervisor) return;
  try { await supervisor.request('action', { generation:supervisor.state?.generation ?? 0, eventId: randomUUID(), actionId: 'pause' }); }
  catch (error) { supervisor.emergencyRelease(); status.nativeFault ??= String(error); }
  status.fault = reason; publish();
}
function fixedKritaProfile(): boolean {
  const actual = status.profile ?? kritaProfile(), expected = kritaProfile();
  return actual.name === expected.name && actual.targetBundleId === expected.targetBundleId &&
    (Object.keys(expected.shortcuts) as (keyof typeof expected.shortcuts)[]).every(key => actual.shortcuts[key] === expected.shortcuts[key]);
}
function enqueueAction(action: LocalActionID, eventId = randomUUID()): Promise<Ack | null> {
  return deliverCommand(configuration, () => generation, action, () => dispatch(action, eventId))
    .catch((error: unknown) => { throw error instanceof Error ? new Error(explainRejection(error.message, status.native)) : error; });
}
async function dispatch(actionId: LocalActionID, eventId: string = randomUUID()): Promise<Ack | null> {
  if (!isLocalAction(actionId)) throw new Error('Unknown action');
  stopLiveProbe();
  switch (actionId) {
    case 'microphoneOff': await microphone(false); return null;
    case 'openSettings': await openSettings(); return null;
    case 'togglePanel': await collapsePanel(!status.collapsed); return null;
    case 'quit': app.quit(); return null;
    case 'recover': await recoverNative(); return null;
    case 'beginCanvas': await beginCanvas(); return null;
    case 'selectCanvas': await selectCanvas(); return null;
    case 'reviewWorkspace': await reviewWorkspace(); return null;
    case 'beginLegacyCanvas': await beginLegacyCanvas(); return null;
    case 'cancelCanvas': await cancelCanvas(); return null;
    case 'confirmHand': await pause('Selected hand confirmation; explicit Resume required.'); panel?.webContents.send('steady:local-action','confirmHand'); return null;
    case 'recenter':
      invalidateCanvas(); await pause('Recenter: capture a new neutral position; input remains paused');
      panel?.webContents.send('steady:recenter'); publish(); return null;
    case 'pause':
      if ((canvasSetup.state.mode === 'mouse' && canvasSetup.state.active) || canvasCapture.active) {
        const sessionId = canvasSetup.state.sessionId ?? undefined;
        // Release immediately; serialize setup cancellation behind configuration
        // already in flight rather than racing its generation changes.
        await pause('Paused');
        void configuration.run(() => cancelCanvas(sessionId)).catch(error => fault(String(error)));
        return null;
      }
      await pause('Paused'); return null;
    case 'markCorner': {
      const reason = readyForControl({ ...status, generation }, false);
      if (reason) throw new Error(reason);
      if (supervisor?.state?.state !== 'SETUP') throw new Error('Canvas setup paused. Begin canvas setup again.');
      const position = freshPointer(pointer, generation, performance.now());
      if (!position) throw new Error('No fresh tracked pointer. Corner command discarded.');
      const display = status.displays.find(d => d.id === status.selectedDisplayId);
      if (!display) throw new Error('Select an available display.');
      const bounds = panel?.getBounds();
      const result = canvasCapture.mark(position, display.bounds, bounds ? [bounds] : []);
      if (result) {
        await pause('Canvas confirmed; explicitly Resume when ready.'); canvas = result; status.canvasConfirmed = false;
        generation++; await configureControl();
        if (!canvas) throw new Error(canvasSetup.state.message);
        canvasSetup.confirmed('manual', latestCanvasObservation ? canvasIdentity(latestCanvasObservation) : null);
        if (latestCanvasObservation) canvasSetup.bindObservation(latestCanvasObservation);
        status.canvasConfirmed = true;
        trackingEvidence('canvas-confirmed', { canvas, realInput });
      }
      publish(); return null;
    }
    case 'resume': {
      if(panelGeometryPending)throw new Error('Panel geometry is changing. Retry Resume explicitly.');
      await supervisor?.request('ping', { senderTimestamp: performance.now() });
      const reason = readyForControl({ ...status, generation }, true);
      if (reason) throw new Error(reason);
      if (nativeConfiguredTarget !== status.targetPid) throw new Error('Krita restarted. Recover the native helper and reconfirm canvas.');
      break;
    }
    case 'click': {
      const position = freshPointer(pointer, generation, performance.now());
      if (position) {
        const hit = hitSurfaces(position, overlaySurfaces().map(win => ({ bounds: win.getBounds(), buttons: surfaceButtons.get(win.webContents.id) ?? [] })));
        if (hit.inside) {
          // End an active stroke before any local panel operation. Background consumes Click.
          await supervisor?.request('action', { generation, eventId: randomUUID(), actionId: 'penUp' });
          if (hit.action && hit.action !== 'click') return dispatch(hit.action, eventId);
          return null;
        }
      }
      break;
    }
  }
  if (!supervisor) throw new Error('Native helper unavailable');
  if (!ACTIONS.includes(actionId as ActionID)) throw new Error('Local action was not handled');
  if (canvasSetup.state.mode === 'mouse' && canvasSetup.state.active && actionId !== 'penUp') throw new Error('Finish or cancel mouse selection before using drawing controls.');
  if(status.settingsOpen && ['resume','penDown','penToggle','click'].includes(actionId)){
    await supervisor.request('action',{generation,eventId:randomUUID(),actionId:'penUp'});
    throw new Error('Close Settings before pointer actions.');
  }
  if (['resume','penDown','penToggle','click','undo','redo','brush','toggleErase','bigger','smaller'].includes(actionId) && !fixedKritaProfile()) {
    await supervisor.request('action', { generation, eventId: randomUUID(), actionId: 'penUp' });
    throw new Error('Generic shortcut profiles are unverified configuration previews. Select the fixed Krita profile to execute.');
  }
  const ack = await supervisor.request('action', { generation, eventId, actionId: actionId as ActionID });
  status.fault = null; publish(); return ack;
}
async function collapsePanel(collapsed: boolean): Promise<void> {
  status.collapsed = collapsed; panel?.setSize(PANEL_WIDTH, collapsed ? PANEL_COLLAPSED_HEIGHT : PANEL_HEIGHT, false); if (panel) surfaceButtons.delete(panel.webContents.id);
  // Native exclusion geometry changes are serialized and always leave input paused.
  await pause('Panel geometry changed; Resume when ready.');
  if (canvasCapture.active || selectionOverlay) invalidateCanvas();
  generation++; await configureControl(); publish();
}

/** Voice input (Cartesia STT + local wake word) replaces the deferred native speech path; the helper's microphone stays off. */
async function microphone(enabled: boolean): Promise<void> {
  if (!voice) throw new Error('Voice input is unavailable.');
  voice.setMicrophone(enabled);
}
let intentClient: IntentClient | null | undefined;
/** null when Claude is unavailable (no key, network error); [] when it heard no request. */
async function interpretWithClaude(text: string): Promise<PlanStep[] | null> {
  if (intentClient === undefined) { const key = anthropicKey(); intentClient = key ? createIntentClient(key) : null; }
  if (!intentClient) return null;
  try { return await interpretPlan(intentClient, text); }
  catch (error) { console.warn('Claude intent failed:', error instanceof Error ? error.message : error); return null; }
}
/** <<COMMAND_ENTRYPOINT>> for voice: runs the spoken plan through the shared dispatcher, resolving after the native acks. */
async function executeVoiceCommand(command: CommandEvent): Promise<string | null> {
  return dispatchVoiceCommand(command, userAction, interpretWithClaude);
}
function initialPanelPosition(): {x:number;y:number} {
  const display = screen.getAllDisplays().find(d=>d.internal) ?? screen.getPrimaryDisplay();
  return { x:display.workArea.x+display.workArea.width-PANEL_WIDTH-16, y:display.workArea.y+16 };
}
function updateDisplays(displays:DisplayInfo[],forcePosition=false):void {
  const previous=status.displays.find(display=>display.id===status.selectedDisplayId);
  const selected=preferredDisplay(displays,status.selectedDisplayId);
  const selecting = canvasSetup.state.mode === 'mouse' && canvasSetup.state.active;
  const keepSelectionPosition = selecting && !forcePosition && sameCanvasSelectionDisplay(previous, selected);
  // Controls and panel exclusion must share one stable frame for the session.
  // Ignore work-area animation while selecting; real display changes expire it.
  if (selecting && !keepSelectionPosition) invalidateCanvas('Selected display changed; select the canvas again.');
  const changed=previous?.id!==selected?.id||JSON.stringify(previous?.workArea)!==JSON.stringify(selected?.workArea);
  status.displays=displays;status.selectedDisplayId=selected?.id;
  if(selected&&!keepSelectionPosition&&(forcePosition||changed)){
    const position=panelPosition(selected);movingPanelProgrammatically=true;
    try{knownPanelOrigin=position;panel?.setPosition(position.x,position.y,false);if(panel)knownPanelOrigin=panel.getBounds();
      const at=utilityPosition('preview',selected.workArea);utilities.preview?.setPosition(at.x,at.y,false);}
    finally{movingPanelProgrammatically=false;}
  }
  publish();
}
function secureWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate', event=>event.preventDefault());
  const rendererFailed = (message: string): void => {
    if (win === selectionOverlay) invalidateCanvas('Canvas selector stopped responding. Select with mouse again.');
    void pause(message);
  };
  win.webContents.on('render-process-gone', ()=>rendererFailed('Renderer exited; restart required'));
  win.webContents.on('unresponsive', ()=>rendererFailed('Renderer unresponsive'));
}
async function loadView(win: BrowserWindow, view: string): Promise<void> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?view=${view}`);
  else await win.loadFile(path.join(__dirname,`../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),{query:{view}});
}
async function openSettings(): Promise<void> {
  if (selectionOverlay || canvasCapture.active) invalidateCanvas('Settings opened; canvas selection canceled.');
  status.settingsOpen=true;publish();
  await pause('Settings opened; input paused');
  if (settings) { settings.show(); settings.focus(); return; }
  // Figma Settings modal: floats over Krita without closing or replacing the compact panel.
  const display = status.displays.find(item => item.id === status.selectedDisplayId);
  const frame = display ? settingsFrame(display.workArea) : { width: SETTINGS_WIDTH, height: SETTINGS_HEIGHT };
  settings = new BrowserWindow({ ...frame,resizable:false,frame:false,transparent:true,hasShadow:true,alwaysOnTop:true,skipTaskbar:true,title:'Statheros — Settings',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false} });
  settings.setAlwaysOnTop(true,'floating'); secureWindow(settings); status.settingsOpen=true; publish();
  settings.on('closed',()=>{settings=null;status.settingsOpen=Boolean(advanced);publish();});
  await loadView(settings,'settings');
}
async function openAdvanced(): Promise<void> {
  if (selectionOverlay || canvasCapture.active) invalidateCanvas('Settings opened; canvas selection canceled.');
  status.settingsOpen=true;publish();
  await pause('Settings opened; input paused');
  if (advanced) { advanced.show(); advanced.focus(); return; }
  advanced = new BrowserWindow({ width:760,height:820,minWidth:600,minHeight:600,title:'Statheros — Advanced settings',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false} });
  secureWindow(advanced);
  advanced.on('closed',()=>{advanced=null;status.settingsOpen=Boolean(settings);publish();});
  await loadView(advanced,'advanced');
}
type ToastKind = ToastMessage['kind'];
/** Success toasts only for actions whose result the native bridge confirmed (it rejects otherwise). */
const SUCCESS_TOASTS: Partial<Record<LocalActionID, ToastKind>> = { undo: 'undo', redo: 'redo', toggleErase: 'eraser', brush: 'pencil', pause: 'paused', resume: 'resumed' };
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(kind: ToastKind, detail?: string): void {
  const win = toastWindow, display = status.displays.find(item => item.id === status.selectedDisplayId);
  if (!win || win.isDestroyed()) return;
  if (display) { const at = toastPosition(display.workArea); win.setPosition(at.x, at.y, false); }
  win.webContents.send('steady:toast', { kind, detail: detail ?? null, id: randomUUID() } satisfies ToastMessage);
  win.showInactive();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (!win.isDestroyed()) win.hide(); }, kind === 'failed' || kind === 'trackingLost' ? 3600 : 2200);
}
/** A command the user asked for (panel, settings, binding or voice): confirmed results and failures notify. */
async function userAction(action: LocalActionID): Promise<Ack | null> {
  try {
    const ack = await enqueueAction(action);
    const kind = SUCCESS_TOASTS[action];
    if (kind) showToast(kind);
    return ack;
  } catch (error) { showToast('failed', error instanceof Error ? error.message : String(error)); throw error; }
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
  if (![panel?.webContents,settings?.webContents,advanced?.webContents,utilities.preview?.webContents].includes(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted IPC sender');
}
function installIPC(): void {
  const handle = (name:string,fn:(...args:any[])=>unknown) => ipcMain.handle(`steady:${name}`,(event,...args)=>{trusted(event);return fn(...args);});
  handle('clock',()=>performance.now());
  ipcMain.handle('steady:status',event=>{
    const canvasWindow = [selectionOverlay,canvasOutline].find(win => win?.webContents === event.sender);
    if (canvasWindow && event.senderFrame === event.sender.mainFrame) return statusForWindow(canvasWindow);
    trusted(event); return status;
  });
  handle('action',async (action:unknown)=>{
    if(typeof action!=='string'||!ACTIONS.includes(action as ActionID))throw new Error('Invalid action');
    try { await enqueueAction(action as ActionID); } catch(error) { fault(String(error)); throw error; }
  });
  handle('local-action',async(action:unknown)=>{
    if(!isLocalAction(action))throw new Error('Invalid local action');
    try { await userAction(action); } catch(error) { fault(String(error)); throw error; }
  });
  handle('tracking-lost',()=>showToast('trackingLost'));
  handle('open-advanced',()=>configuration.run(openAdvanced));
  handle('begin-canvas',()=>configuration.run(beginCanvas));
  handle('copy-canvas-diagnostics',()=>{
    const report = canvasDiagnostics.snapshot();
    if (!report.current) throw new Error('No canvas observations are available yet.');
    clipboard.writeText(JSON.stringify(report, null, 2));
  });
  handle('select-canvas',()=>configuration.run(selectCanvas));
  handle('review-workspace',()=>configuration.run(reviewWorkspace));
  handle('begin-legacy-canvas',()=>configuration.run(beginLegacyCanvas));
  ipcMain.handle('steady:cancel-canvas',(event,sessionId:unknown)=>{
    const fromOverlay = event.sender === selectionOverlay?.webContents && event.senderFrame === event.sender.mainFrame;
    if (!fromOverlay) trusted(event);
    if (sessionId !== undefined && typeof sessionId !== 'string') throw new Error('Invalid selection session.');
    if (fromOverlay && sessionId !== canvasSetup.state.sessionId) throw new Error('Canvas selection expired.');
    return configuration.run(()=>cancelCanvas(sessionId as string|undefined));
  });
  const overlayHandle = (name: string, operation: (value: unknown) => Promise<void> | void): void => {
    ipcMain.handle(`steady:${name}`,(event,value:unknown)=>configuration.run(async()=>{
      if (event.sender !== selectionOverlay?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted canvas selection sender.');
      await operation(value);
    }));
  };
  overlayHandle('preview-canvas',value=>{
    selectionSession(value);
    selectionSurface(value);
    canvasSetup.preview(null, selectedDisplay().bounds, []);
    if (!isObject(value) || !(value.rect === null || rect(value.rect))) throw new Error('Invalid canvas rectangle.');
    const selection = value.rect as Rect | null, displayBounds = selectedDisplay().bounds, panelBounds = panel?.getBounds() ?? null;
    let accepted = false;
    try { canvasSetup.preview(selection, displayBounds, panelBounds ? [panelBounds] : []); accepted = true; status.fault = null; }
    catch (error) { canvasSetup.state.message = String(error); throw error; }
    finally {
      canvasDiagnostics.selectionValidated({ stage: 'preview', selection, displayBounds, panelBounds, controlsBounds: canvasSetup.state.selectionControlsBounds, surfaceBounds: selectionOverlay?.getContentBounds() ?? null, accepted });
      publish();
    }
  });
  overlayHandle('confirm-canvas',confirmCanvas);
  handle('recover',()=>configuration.run(recoverNative));
  handle('real-input',(enabled:unknown)=>configuration.run(async()=>{
    if(typeof enabled!=='boolean')throw new Error('Invalid real-input flag');
    if(enabled && (!app.isPackaged || testFakeBackend))throw new Error('Real input requires the packaged app and disposable Krita document confirmation.');
    await pause('Native input mode changed.'); invalidateCanvas(); realInput=enabled; generation++;
    await recoverNative();
  }));
  handle('save-bindings',(value:unknown)=>configuration.run(async()=>{
    const bindings=validateBindings(value);await pause('Bindings changed; input paused.');
    savedSettings={...savedSettings,bindings};settingsStore.save(savedSettings);status.settings=savedSettings;status.bindings=bindings;installBindings();
  }));
  handle('save-profile',(value:unknown)=>configuration.run(async()=>{
    const profile=validateProfile(value);await pause('Shortcut profile changed; input paused.');
    savedSettings={...savedSettings,profile};settingsStore.save(savedSettings);status.settings=savedSettings;status.profile=profile;publish();
  }));
  handle('collapse',(collapsed:unknown)=>configuration.run(async()=>{if(typeof collapsed!=='boolean')throw new Error('Invalid collapse');await collapsePanel(collapsed);}));
  handle('open-settings',()=>configuration.run(openSettings));
  handle('close-settings',()=>{settings?.close();advanced?.close();});
  handle('select-camera',(cameraId:unknown,mode:unknown)=>configuration.run(async()=>{
    if(typeof cameraId!=='string'||cameraId.length>1024||!['head','palm'].includes(mode as string))throw new Error('Invalid camera');
    await pause('Camera/mode changed; canvas confirmation required');generation++;
    savedSettings={...savedSettings,cameraId,mode:mode as Mode};settingsStore.save(savedSettings);status.settings=savedSettings;status.canvasConfirmed=false;
    invalidateCanvas(); await configureControl();publish();
  }));
  handle('tracking-metrics',(value:unknown)=>{
    if(!isObject(value)||!['frames','validFrames','mappedFrames','elapsedMs','mappingHz'].every(k=>finite(value[k])&&value[k]>=0)||!(value.receiptToMappedP95Ms===null||(finite(value.receiptToMappedP95Ms)&&value.receiptToMappedP95Ms>=0))||!(value.position===null||point(value.position))||typeof value.reason!=='string'||value.reason.length>256)throw new Error('Invalid tracking metrics');
    const metrics={frames:value.frames,validFrames:value.validFrames,mappedFrames:value.mappedFrames,elapsedMs:value.elapsedMs,mappingHz:value.mappingHz,receiptToMappedP95Ms:value.receiptToMappedP95Ms,position:value.position,reason:value.reason};
    trackingEvidence('baseline',metrics);
  });
  handle('save-calibration',(value:unknown)=>configuration.run(async()=>{
    if(!isCalibrationV1(value)||value.cameraId!==savedSettings.cameraId||value.mode!==savedSettings.mode)throw new Error('Calibration does not match selected camera/mode');
    await pause('Calibration saved; input remains paused and canvas confirmation is required');
    savedSettings=withCalibration(savedSettings,value);settingsStore.save(savedSettings);trackingEvidence('calibration-saved',value);status.settings=savedSettings;status.canvasConfirmed=false;generation++;
    invalidateCanvas(); await configureControl();publish();
  }));
  // Stroke/motion tuning: gain and smoothing only. Canvas geometry is unaffected, so no reconfirmation;
  // a held pen is released first so a mapping change can never extend a stroke.
  handle('tune-calibration',(value:unknown)=>configuration.run(async()=>{
    if(!isCalibrationV1(value)||value.cameraId!==savedSettings.cameraId||value.mode!==savedSettings.mode)throw new Error('Calibration does not match selected camera/mode');
    const current=savedSettings.calibrations.find(c=>c.cameraId===value.cameraId&&c.mode===value.mode);
    const fixed=(c:typeof value)=>JSON.stringify([c.schemaVersion,c.selectedHand,c.neutral.x,c.neutral.y,c.extents.left,c.extents.right,c.extents.up,c.extents.down,c.jitter.x,c.jitter.y]);
    if(!current||fixed(current)!==fixed(value))throw new Error('Only smoothing and sensitivity can be tuned from the panel');
    if(status.native?.buttonDown)await supervisor?.request('action',{generation,eventId:randomUUID(),actionId:'penUp'});
    savedSettings=withCalibration(savedSettings,value);settingsStore.save(savedSettings);status.settings=savedSettings;publish();
  }));
  // Orientation changes the tracked coordinate space: the camera's saved calibrations no longer apply.
  handle('set-orientation',(cameraId:unknown,flipX:unknown,flipY:unknown)=>configuration.run(async()=>{
    if(typeof cameraId!=='string'||cameraId.length>1024||typeof flipX!=='boolean'||typeof flipY!=='boolean')throw new Error('Invalid camera orientation');
    await pause('Camera orientation changed; recalibrate');generation++;
    const orientations=[...(savedSettings.orientations??[]).filter(entry=>entry.cameraId!==cameraId),...(flipX||flipY?[{cameraId,flipX,flipY}]:[])];
    savedSettings={...savedSettings,orientations,calibrations:savedSettings.calibrations.filter(c=>c.cameraId!==cameraId)};
    if(!orientations.length)delete savedSettings.orientations;
    settingsStore.save(savedSettings);status.settings=savedSettings;status.canvasConfirmed=false;
    invalidateCanvas();await configureControl();status.fault='Camera orientation changed; recalibrate';publish();
  }));
  handle('panel-opacity',(opacity:unknown)=>{if(opacity!==1&&opacity!==0.7)throw new Error('Invalid opacity');for(const win of overlaySurfaces())win.setOpacity(opacity);status.panelOpacity=opacity;publish();});
  handle('select-display',(displayId:unknown)=>configuration.run(async()=>{
    if(!uint(displayId)||!status.displays.some(display=>display.id===displayId))throw new Error('Unknown native display');
    await pause('Selected display changed; canvas invalidated');generation++;status.selectedDisplayId=displayId;surfaceButtons.clear();status.canvasConfirmed=false;invalidateCanvas();updateDisplays(status.displays,true); await configureControl();
  }));
  handle('microphone',async(enabled:unknown)=>{if(typeof enabled!=='boolean')throw new Error('Invalid microphone flag');await microphone(enabled);});
  handle('install-speech-assets',async()=>{throw new Error('Apple speech assets are not used; voice uses Cartesia.');});
  handle('voice-status',()=>({snapshot:voice?.snapshot()??null,keySource:voice?.keySource??null}));
  handle('voice-key',(key:unknown)=>{if(key!==null&&(typeof key!=='string'||key.length>256))throw new Error('Invalid key');voice?.setKey(key);});
  handle('voice-selftest',()=>voice?.selfTest()??{ok:false,samplesPerSecond:0,peakDbfs:null,message:'Voice unavailable'});
  handle('voice-latency',()=>voice?.latency()??null);
  handle('release-input',()=>{
    stopLiveProbe();
    releaseRealInput();
    return pause('Emergency release requested');
  });
  handle('run-native-probe',async()=>{
    if(!app.isPackaged || testFakeBackend)throw new Error('Real-input probes require packaged operator identity; unavailable in fake tests.');
    if(liveProbe)throw new Error('Probe already running');
    await pause('Bounded real-input probe: switch to disposable Krita document within five seconds');
    const child=liveProbe=spawn(path.join(resourcesRoot(),'bin','SteadyNative'),['--probe','--real-input',...(status.selectedDisplayId===undefined?[]:['--probe-display',String(status.selectedDisplayId)])],{stdio:['pipe','pipe','pipe']});
    const directory=path.join(app.getPath('userData'),'phase01-evidence');mkdirSync(directory,{recursive:true});
    child.stdout.on('data',data=>appendFileSync(path.join(directory,'native-probe.jsonl'),data));
    child.stderr.on('data',()=>{});
    liveProbeLifecycle=new LiveProbe(child,releaseRealInput,message=>{if(liveProbe===child){liveProbe=null;liveProbeLifecycle=null;}fault(message);});
  });
  handle('quit',()=>app.quit());
  ipcMain.on('steady:register-buttons',(event,value:unknown)=>{trusted(event);if(!overlaySurfaces().some(win=>win.webContents===event.sender)||!Array.isArray(value)||value.length>100) return;surfaceButtons.set(event.sender.id,value.filter(x=>isObject(x)&&isLocalAction(x.actionId)&&rect(x.rect)));});
  ipcMain.on('steady:sample',(event,sample:unknown)=>{
    trusted(event); if(event.sender!==panel?.webContents||!isObject(sample)||!uint(sample.generation)||!uint(sample.frameId)||!finite(sample.captureTimestamp)||typeof sample.valid!=='boolean'||!['head','palm'].includes(sample.mode as string)||(sample.valid?!point(sample.anchor):sample.anchor!==null)||typeof sample.qualityReason!=='string')return;
    if(sample.generation!==generation || (canvasSetup.state.mode === 'mouse' && canvasSetup.state.active))return;
    // Feasibility capture establishes freshness only. No uncalibrated pointer mapping.
    if(status.native?.generation)supervisor?.submit({...sample,valid:false} as unknown as TrackingSample,null,sample.captureTimestamp);
  });
  ipcMain.on('steady:mapped-probe',(event,sample:unknown,position:unknown)=>{
    trusted(event);
    if(event.sender!==panel?.webContents || (canvasSetup.state.mode === 'mouse' && canvasSetup.state.active) || !mappedSampleAllowed(sample,position,{...status,generation},performance.now()))return;
    pointer = sample.valid ? { position: position as Point, timestamp: sample.captureTimestamp, generation } : null;
    if(supervisor?.state?.generation===generation)supervisor.submit(sample, sample.valid ? position as Point : null, sample.captureTimestamp);
  });
  ipcMain.on('steady:voice-frame',(event,pcm:unknown)=>{if(event.sender!==panel?.webContents||event.senderFrame!==event.sender.mainFrame)return;voice?.frame(pcm);});
  ipcMain.on('steady:voice-report',(event,report:unknown)=>{
    if(event.sender!==panel?.webContents||!isObject(report)||typeof report.type!=='string')return;
    if(['opened','deviceChanged'].includes(report.type))voice?.report({type:report.type} as VoiceCaptureReport);
    else if(report.type==='failed'&&typeof report.reason==='string')voice?.report({type:'failed',reason:report.reason.slice(0,200)});
    else if((report.type==='earconStarted'||report.type==='earconStopped')&&typeof report.playId==='string'&&report.playId.length<=64)voice?.report({type:report.type,playId:report.playId});
  });
  ipcMain.on('steady:voice-button',(event,kind:unknown)=>{trusted(event);if(kind==='press'||kind==='longpress')voice?.button(kind);});
  ipcMain.on('steady:voice-cancel',(event)=>{trusted(event);voice?.cancel();});
  ipcMain.on('steady:clock-fault',(event,message:unknown)=>{trusted(event);void pause(typeof message==='string'?message:'Renderer clock synchronization failed');});
}
async function startNative(): Promise<void> {
  const next = new NativeSupervisor(path.join(resourcesRoot(),'bin','SteadyNative'), realInput, testFakeBackend);
  supervisor = next;
  latestCanvasObservation = null; latestCanvasReceivedAt = -Infinity;
  let recordedLoss: number | undefined;
  next.on('state',state=>{
    if(supervisor!==next)return;
    if(!state.buttonDown && status.native?.buttonDown && state.lastReleaseTimestamp!=null && state.lastReleaseTimestamp!==recordedLoss){
      recordedLoss=state.lastReleaseTimestamp;
      trackingEvidence('button-release',{realInput:next.realInput,generation:state.generation,nativeReason:state.reason,
        previousState:status.native.state,lastValidCaptureTimestamp:state.lastValidCaptureTimestamp??null,lastReleaseTimestamp:state.lastReleaseTimestamp,
        releaseAfterCaptureMs:state.lastValidCaptureTimestamp==null?null:state.lastReleaseTimestamp-state.lastValidCaptureTimestamp,
        buttonDown:state.buttonDown,clockUncertaintyMs:next.clock.uncertainty});
    }
    if(status.native && ['HOVER','DRAWING'].includes(status.native.state) && state.state!==status.native.state && state.reason==='stale-capture')showToast('trackingLost');
    status.native=state;if(state.reason==='microphone-enabled'&&speechSession!==null)status.microphoneEnabled=true;if(state.reason==='microphone-disabled')status.microphoneEnabled=false;if(state.reason==='speech-assets-ready')status.speechDiagnostics={...(status.speechDiagnostics??emptySpeechDiagnostics(speechSession)),assets:'ready'};publish();});
  next.on('fault',(message)=>{if(supervisor!==next)return;invalidateCanvas('Native helper unavailable; recover it and set the canvas again.');speechSession=null;status.microphoneEnabled=false;status.nativeClockReady=false;status.nativeFault=message;trackingEvidence('native-fault',{message});fault(message);});
  next.on('clock-ready',ready=>{if(supervisor!==next)return;status.nativeClockReady=ready;publish();});
  next.on('hello',(ack)=>{updateDisplays(ack.displays??[]);status.targetPid=ack.targetPid??null;publish();});
  next.on('displays',displays=>updateDisplays(displays));
  const targetUpdated = (pid: number | null): void => {
    if (supervisor !== next || status.targetPid === pid) return;
    const previous = status.targetPid;
    status.targetPid = pid;
    if (previous === undefined && !canvas && !canvasSetup.state.active) { publish(); return; }
    invalidateCanvas('Krita target changed; set the canvas again.');
    void configuration.run(async () => {
      if (supervisor !== next) return;
      await pause('Krita target changed; input stays paused.'); generation++; await configureControl(); publish();
    }).catch(error => fault(String(error)));
  };
  next.on('target',targetUpdated);
  next.on('canvas-observation',(observation: CanvasObservation)=>{
    if (supervisor !== next) return;
    if (canvasObservationPending) return;
    canvasObservationPending = true;
    void configuration.run(async()=>{
      if (supervisor !== next || !status.nativeClockReady || status.nativeFault) return;
      let nativeNow: number;
      try { nativeNow = next.clock.convert(performance.now(), performance.now()); } catch { return; }
      await routeCanvasObservation(observation, { generation, targetPid: status.targetPid, nativeNow,
        lastTimestamp: latestCanvasObservation?.observedAt ?? -Infinity, uncertainty: next.clock.uncertainty },
      () => next.request('ping', { senderTimestamp: performance.now() }), value => observeCanvas(value,next));
    }).catch(error=>fault(String(error))).finally(()=>{canvasObservationPending=false;});
  });
  const speechDiagnosticRecorder=new SpeechDiagnosticRecorder(path.join(app.getPath('userData'),'phase01-evidence','speech-diagnostics.jsonl'));
  next.on('speech-diagnostics',diagnostics=>{status.speechDiagnostics=diagnostics;try{speechDiagnosticRecorder.write(diagnostics);}catch{fault('Speech diagnostic evidence could not be saved');}publish();});
  next.on('native-fault',code=>{const errorCode=code==='microphone-failed'?'microphone-setup-failed':code;if(isSpeechDiagnosticError(errorCode)){status.speechDiagnostics={...(status.speechDiagnostics??emptySpeechDiagnostics(speechSession)),phase:'error',...(code==='speech-assets-failed'?{assets:'error' as const}:{}),errorCode};try{speechDiagnosticRecorder.write(status.speechDiagnostics);}catch{fault('Speech diagnostic evidence could not be saved');}publish();}});
  next.on('speech',event=>{
    const key=`${event.speechSession}:${event.utterance}`;
    if(event.speechSession!==speechSession||speechSeen.has(key))return;
    speechSeen.add(key); if(speechSeen.size>1000) {void microphone(false);return;}
    const record=(ack:Ack|null)=>{
      const timing={speechSession:event.speechSession,utterance:event.utterance,actionId:event.actionId,speechEndTimestamp:event.speechEndTimestamp,recognitionTimestamp:event.acceptedTimestamp,actionTimestamp:ack?.nativeTimestamp??null,latencyMs:ack?.nativeTimestamp==null?null:ack.nativeTimestamp-event.speechEndTimestamp,accepted:ack?.accepted??false};
      const directory=path.join(app.getPath('userData'),'phase01-evidence');mkdirSync(directory,{recursive:true});appendFileSync(path.join(directory,'speech-timings.jsonl'),JSON.stringify(timing)+'\n');
    };
    if(event.actionId===null){record(null);fault(event.reason==='late-result-retry'?'Speech result expired; retry':`Speech command rejected: ${event.reason}`);return;}
    let currentNative:number;
    try{currentNative=supervisor!.clock.convert(performance.now(),performance.now());}catch{fault('Speech clock requires synchronization; retry');return;}
    if(event.acceptedTimestamp-event.speechEndTimestamp>1500||currentNative-event.speechEndTimestamp>1500){record(null);fault('Speech result expired; retry');return;}
    void dispatch(event.actionId,key).then(record).catch(error=>{record(null);fault(String(error));});
  });
  try { await next.start(); generation++; await configureControl(); }
  catch(error) { status.nativeFault=String(error); fault(String(error)); }
}
async function recoverNative(): Promise<void> {
  await pause('Recovering helper; canvas must be reconfirmed.');
  const old=supervisor; supervisor=null; await old?.stop();
  invalidateCanvas(); nativeConfiguredTarget=null; status.native=null; status.nativeFault=null; status.nativeClockReady=false;
  status.fault=null; generation++;
  await startNative(); publish();
}
async function main(): Promise<void> {
  await app.whenReady(); app.dock?.hide();
  settingsStore=new SettingsStore(path.join(app.getPath('userData'),'settings-v1.json'));
  const loaded=settingsStore.load();savedSettings=loaded.settings;status.settings=savedSettings;status.bindings=savedSettings.bindings??defaultBindings();status.profile=savedSettings.profile??kritaProfile();status.canvasConfirmed=false;if(loaded.warning)status.fault=loaded.warning;
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
    const url = new URL(details.url);
    const dev = !app.isPackaged && MAIN_WINDOW_VITE_DEV_SERVER_URL && url.origin===new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
    callback({cancel:!(['file:','steady-resource:','data:','blob:','devtools:'].includes(url.protocol)||dev)});
  });
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>callback([panel?.webContents,settings?.webContents,advanced?.webContents].includes(contents)&&permission==='media'));
  protocol.handle('steady-resource',request=>{
    if(!resourcesReady)return new Response('Local resource integrity check failed',{status:503});
    const url=new URL(request.url); const name=decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const root=path.resolve(resourcesRoot(),'assets');const filename=path.resolve(root,name);
    if(url.hostname!=='assets'||!filename.startsWith(root+path.sep))return new Response('Forbidden',{status:403});
    return net.fetch(pathToFileURL(filename).href);
  });
  try { verifyResources();resourcesReady=true; } catch(error) { fault(String(error)); }
  panel=new BrowserWindow({ ...initialPanelPosition(),width:PANEL_WIDTH,height:PANEL_HEIGHT,resizable:false,frame:false,transparent:true,hasShadow:true,show:false,type:'panel',focusable:false,alwaysOnTop:true,skipTaskbar:true,title:'Steady',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false} });
  panel.setAlwaysOnTop(true,'floating'); panel.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}); secureWindow(panel);
  panel.on('close',()=>{if(!quitting)app.quit();});
  let panelGeometryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Moving any overlay surface changes the helper's excluded rectangles: pause now, reconfigure once it settles. */
  const surfaceMoved=(name:string):void=>{
    panelGeometryPending=true; const epoch=++panelGeometryEpoch;
    clearTimeout(panelGeometryTimer);
    void pause(`${name} moved; input paused.`);
    panelGeometryTimer=setTimeout(()=>{void configuration.run(async()=>{
      if(canvasCapture.active || selectionOverlay)invalidateCanvas(`${name} moved; select the canvas again.`);generation++;await configureControl();publish();
    }).catch(error=>fault(String(error))).finally(()=>{if(epoch===panelGeometryEpoch)panelGeometryPending=false;});},100);
  };
  knownPanelOrigin=panel.getBounds();
  panel.on('move',()=>{
    const bounds=panel?.getBounds();
    if(movingPanelProgrammatically){if(bounds)knownPanelOrigin=bounds;return;}
    if(!bounds || (knownPanelOrigin?.x===bounds.x && knownPanelOrigin?.y===bounds.y))return;
    knownPanelOrigin=bounds; surfaceMoved('Panel');
  });
  const createUtility=(view:UtilityView):BrowserWindow=>{
    const display=screen.getAllDisplays().find(d=>d.internal)??screen.getPrimaryDisplay();
    const win=new BrowserWindow({ ...utilityPosition(view,display.workArea),...UTILITY_SIZE[view],resizable:false,frame:false,transparent:true,hasShadow:true,show:false,type:'panel',focusable:false,alwaysOnTop:true,skipTaskbar:true,title:'Statheros — Camera Preview',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false} });
    win.setAlwaysOnTop(true,'floating'); win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}); secureWindow(win);
    // Utilities live as long as the app; the panel's close button quits.
    win.on('close',event=>{if(!quitting)event.preventDefault();});
    win.on('closed',()=>{if(utilities[view]===win)utilities[view]=null;});
    let known=win.getBounds();
    win.on('move',()=>{
      const bounds=win.getBounds(), unchanged=known.x===bounds.x&&known.y===bounds.y; known=bounds;
      if(!movingPanelProgrammatically&&!unchanged)surfaceMoved('Camera preview');
    });
    utilities[view]=win; return win;
  };
  const preview=createUtility('preview');
  toastWindow=new BrowserWindow({ width:TOAST_WIDTH,height:TOAST_HEIGHT,resizable:false,movable:false,frame:false,transparent:true,hasShadow:false,show:false,type:'panel',focusable:false,alwaysOnTop:true,skipTaskbar:true,title:'Statheros — Notification',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false} });
  toastWindow.setAlwaysOnTop(true,'floating'); toastWindow.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}); toastWindow.setIgnoreMouseEvents(true); secureWindow(toastWindow);
  toastWindow.on('close',event=>{if(!quitting)event.preventDefault();});
  installIPC();await loadView(panel,'panel');panel.showInactive();
  await Promise.all([loadView(preview,'preview'),loadView(toastWindow,'toast')]);preview.showInactive();
  voice=new ElectronVoice({buildDir:__dirname,voiceRoot:path.join(resourcesRoot(),'voice'),packaged:app.isPackaged,userData:app.getPath('userData'),
    panel:()=>panel,windows:()=>[panel,settings],execute:executeVoiceCommand,microphoneChanged:open=>{status.microphoneEnabled=open;publish();}});
  voice.start();
  app.on('browser-window-focus',()=>voice?.appFocused());
  await startNative(); installBindings();
  const detectionHealth = setInterval(()=>{
    if (canvasSetup.preference !== 'automatic' || !canvas || performance.now()-latestCanvasReceivedAt < 2000 || canvasObservationPending) return;
    canvasObservationPending = true;
    void configuration.run(async()=>{
      if (canvasSetup.preference !== 'automatic' || !canvas || performance.now()-latestCanvasReceivedAt < 2000) return;
      invalidateCanvas('Canvas detection stopped updating. Detect again or Select with mouse.');
      canvasSetup.state.detection = { availability: 'unavailable', reason: 'No fresh Accessibility observations.' };
      await pause(canvasSetup.state.message); generation++; await configureControl(); publish();
    }).catch(error=>fault(String(error))).finally(()=>{canvasObservationPending=false;});
  },500);
  detectionHealth.unref();
  powerMonitor.on('suspend',()=>{void pause('suspend');});
  powerMonitor.on('lock-screen',()=>{void pause('lock-screen');});
  powerMonitor.on('resume',()=>{void pause('Wake requires explicit Resume');for(const win of [panel,settings])win?.webContents.send('steady:resync-clocks');void supervisor?.synchronize().catch(error=>fault(String(error)));});
  const layout = new DisplayLayoutGuard(screen.getAllDisplays());
  const displayChanged=()=>{
    if (!layout.changed(screen.getAllDisplays())) return;
    void configuration.run(async()=>{
      await pause('Display geometry changed; canvas invalidated');
      generation++;status.canvasConfirmed=false;surfaceButtons.clear();
      // Pause refreshes native metadata; ping returns its authoritative displays.
      await supervisor?.request('ping',{senderTimestamp:performance.now()});
      invalidateCanvas(); await configureControl();publish();
    }).catch(error=>fault(String(error)));
  };
  screen.on('display-added',displayChanged);screen.on('display-removed',displayChanged);screen.on('display-metrics-changed',displayChanged);
  publish();
}
app.on('before-quit',event=>{
  if(shutdownStarted)return;event.preventDefault();shutdownStarted=true;quitting=true;bindingInstaller.clear();
  stopLiveProbe();
  void Promise.allSettled([voice?.stop(),supervisor?.stop()]).finally(()=>app.quit());
});
app.on('window-all-closed',()=>{if(!quitting)app.quit();});
void main().catch(error=>fault(String(error)));
