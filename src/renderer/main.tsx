import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActionID, Mode, ProbeStatus } from '../shared/contracts';
import { ALL_CONTROLS, defaultBindings, kritaProfile, type GlobalBindings, type LocalActionID, type ShortcutProfile } from '../main/commands';
import { CameraProbe, type ProbeReport } from './probe';
import './style.css';
import { SetupController, type SetupSnapshot } from './setup-controller';
import { useVoice, useVoiceCapture, VoiceSettings, VoiceStrip } from './voice-ui';

const initialStatus: ProbeStatus = { native: null, displays: [], fault: null, collapsed: false, settingsOpen: false, generation: 0, realInput: false, microphoneEnabled: false };
const initialProbe: ProbeReport = { message: 'Camera off', frames: 0, delegate: null, running: false };
const actionLabels: [ActionID, string][] = [ ['penDown', 'Pen down'], ['penUp', 'Pen up'], ['penToggle', 'Pen toggle'], ['click', 'Click'], ['undo', 'Undo'], ['redo', 'Redo'], ['brush', 'Brush'], ['toggleErase', 'Toggle erase'], ['bigger', 'Bigger'], ['smaller', 'Smaller'], ['pause', 'Pause'], ['resume', 'Resume'], ['recenter', 'Recenter'], ['markCorner', 'Mark corner'], ['microphoneOff', 'Mic off'] ];

function App(): React.JSX.Element {
  const isSettings = new URLSearchParams(location.search).get('view') === 'settings';
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState(initialProbe);
  const [setup, setSetup] = useState<SetupSnapshot | null>(null);
  const setupRef = useRef<SetupController | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const probeRef = useRef<CameraProbe | null>(null);
  const probeReportRef = useRef(probe);
  probeReportRef.current = probe;
  const run = useCallback((work: () => Promise<void>): void => { setError(null); void work().catch(cause => setError(String(cause))); }, []);

  useEffect(() => {
    void window.steady.status().then(setStatus).catch(cause => setError(String(cause)));
    return window.steady.onStatus(setStatus);
  }, []);

  useEffect(() => {
    const channel = new BroadcastChannel('steady-camera-probe');
    channelRef.current = channel;
    if (!isSettings) {
      const controller = new SetupController(snapshot => { setSetup(snapshot); channel.postMessage({ type: 'setup', snapshot }); }, calibration => window.steady.saveCalibration(calibration), (sample, position) => window.steady.submitMappedProbe(sample, position), metrics => { void window.steady.recordTrackingMetrics(metrics).catch(cause => setError(String(cause))); });
      setupRef.current = controller;
      let resolvedCameraId: string | null = null;
      let cameraScope: string | null = null;
      let activeMode: Mode = 'head';
      const camera = new CameraProbe(() => statusRef.current.generation, report => {
        setProbe(report); channel.postMessage({ type: 'report', report });
        const current = statusRef.current.settings;
        if (report.cameraId) {
          cameraScope = JSON.stringify([report.cameraId, activeMode]);
          // A default-camera resolution is one configuration change per run.
          // Reports can arrive before React applies its asynchronous status update.
          if (resolvedCameraId !== report.cameraId) {
            resolvedCameraId = report.cameraId;
            if (current?.cameraId !== report.cameraId) void window.steady.selectCamera(report.cameraId, activeMode).catch(cause => setError(String(cause)));
          }
        }
      }, sample => controller.sample(sample), () => { void window.steady.action('pause').catch(cause => setError(String(cause))); });
      probeRef.current = camera; camera.preview(previewRef.current);
      const execute = (operation: () => void): void => { try { operation(); } catch (cause) { setError(String(cause)); channel.postMessage({ type: 'error', message: String(cause) }); } };
      channel.onmessage = event => {
        const message = event.data;
        if (message?.type === 'start' && typeof message.cameraId === 'string' && (message.mode === 'head' || message.mode === 'palm')) {
          controller.cancel(false);
          const calibration = statusRef.current.settings?.calibrations.find(c => c.cameraId === message.cameraId && c.mode === message.mode);
          const nextScope = JSON.stringify([message.cameraId, message.mode]);
          if (cameraScope !== nextScope || calibration?.selectedHand) camera.setSelectedHand(calibration?.selectedHand ?? null);
          activeMode = message.mode; resolvedCameraId = null;
          void camera.start(message.cameraId, message.mode);
        }
        if (message?.type === 'stop') { camera.stop(); controller.cancel(); setProbe(initialProbe); channel.postMessage({ type: 'report', report: initialProbe }); }
        if (message?.type === 'query') { channel.postMessage({ type: 'report', report: probeReportRef.current }); channel.postMessage({ type: 'setup', snapshot: controller.snapshot() }); }
        if (message?.type === 'calibrate') execute(() => controller.begin());
        if (message?.type === 'capture') execute(() => controller.capture());
        if (message?.type === 'cancel') execute(() => controller.cancel());
        if (message?.type === 'recenter') {
          void window.steady.action('pause').then(() => execute(() => controller.beginRecenter())).catch(cause => setError(String(cause)));
        }
        if (message?.type === 'confirmHand') void window.steady.localAction('confirmHand').catch(cause => setError(String(cause)));
        if (message?.type === 'baseline') execute(() => controller.startBaseline());
        if (message?.type === 'tuning') execute(() => {
          const c = controller.state.calibration;
          if (c) void window.steady.saveCalibration({ ...c, gain: message.gain, smoothing: message.smoothing }).catch(cause => setError(String(cause)));
        });
      };
    } else {
      channel.onmessage = event => {
        if (event.data?.type === 'report') setProbe(event.data.report as ProbeReport);
        if (event.data?.type === 'setup') setSetup(event.data.snapshot as SetupSnapshot);
        if (event.data?.type === 'error') setError(String(event.data.message));
      };
      channel.postMessage({ type: 'query' });
    }
    return () => { setupRef.current?.cancel(false); setupRef.current = null; probeRef.current?.stop(); probeRef.current = null; channel.close(); channelRef.current = null; };
    // The panel owns camera lifecycle; status updates must never restart capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettings]);

  useEffect(() => {
    if (isSettings) return;
    setupRef.current?.update(status.settings, status.displays.find(d => d.id === status.selectedDisplayId), status.generation);
    probeRef.current?.preview(previewRef.current);
  }, [isSettings, status]);

  useEffect(() => window.steady.onLocalAction(id => {
    if (!isSettings && id === 'confirmHand') { try { probeRef.current?.confirmHand(); } catch (cause) { setError(String(cause)); } }
  }), [isSettings]);

  useEffect(() => window.steady.onRecenter(() => {
    if (!isSettings) { try { setupRef.current?.beginRecenter(); } catch (cause) { setError(String(cause)); } }
  }), [isSettings]);

  useEffect(() => {
    if (isSettings) return;
    const register = (): void => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-action]:not(:disabled)')).map(button => {
        const rect = button.getBoundingClientRect();
        const clip = button.closest('.panel-content')?.getBoundingClientRect() ?? document.body.getBoundingClientRect();
        const x = Math.max(rect.left, clip.left), y = Math.max(rect.top, clip.top);
        return { actionId: button.dataset.action as LocalActionID, rect: { x, y, width: Math.min(rect.right, clip.right) - x, height: Math.min(rect.bottom, clip.bottom) - y } };
      }).filter(button => button.rect.width > 0 && button.rect.height > 0);
      window.steady.registerButtons(buttons);
    };
    register();
    const mutations = new MutationObserver(register);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    const observer = new ResizeObserver(register);
    observer.observe(document.body);
    document.addEventListener('scroll', register, true);
    return () => { mutations.disconnect(); observer.disconnect(); document.removeEventListener('scroll', register, true); };
  }, [isSettings, status.collapsed, probe.confirmationRequired, status.canvasSetup?.active]);

  const action = (id: LocalActionID): void => run(() => window.steady.localAction(id));
  const feedback = status.nativeFault ?? error ?? status.fault;
  const { voice, keySource } = useVoice();
  if (isSettings) return <Settings status={status} probe={probe} setup={setup} feedback={feedback} run={run} channel={channelRef} voice={<VoiceSettings voice={voice} keySource={keySource} run={run} />} />;
  return <Panel status={status} probe={probe} setup={setup} feedback={feedback} action={action} previewRef={previewRef} voice={<VoiceStrip voice={voice} />} />;
}

/** The panel renderer owns camera and microphone capture. */
function Panel({ status, probe, setup, feedback, action, previewRef, voice }: { status: ProbeStatus; probe: ProbeReport; setup: SetupSnapshot | null; feedback: string | null; action: (id: LocalActionID) => void; previewRef: React.RefObject<HTMLCanvasElement | null>; voice: React.ReactNode }): React.JSX.Element {
  useVoiceCapture();
  return <main className={`panel ${status.collapsed ? 'collapsed' : ''}`}>
    <header className="panel-header">
      <strong>Steady</strong>
      <button data-action="pause" onClick={() => action('pause')} aria-label="Pause input">Pause</button>
      <button data-action="openSettings" onClick={() => action('openSettings')} aria-label="Open settings">⚙</button>
      <button data-action="togglePanel" onClick={() => action('togglePanel')} aria-label={status.collapsed ? 'Expand panel' : 'Collapse panel'}>{status.collapsed ? '+' : '−'}</button>
      <button data-action="quit" onClick={() => action('quit')} aria-label="Quit Steady">×</button>
    </header>
    <div className="compact-status" role="status">{status.native?.state ?? 'Connecting'} · {status.realInput ? 'Real input' : 'Fake input'} · Mic {status.microphoneEnabled ? 'on' : 'off'}</div>
    {voice}
    <canvas ref={previewRef} width={280} height={140} hidden={status.collapsed} aria-label="Mirrored local camera preview" className="camera-preview" />
    {!status.collapsed && <div className="panel-content">
      <section className="health" aria-label="Probe status">
        <p>{status.native?.reason ?? 'Starting local helper…'}</p>
        <p>{probe.message} · {probe.frames} frames{probe.delegate ? ` · ${probe.delegate}` : ''}</p>
        {feedback && <p role="alert" className="error">{feedback}</p>}
      </section>
      {setup?.position && <p>Mapped probe: {Math.round(setup.position.x)}, {Math.round(setup.position.y)}</p>}
      {probe.confirmationRequired && <button data-action="confirmHand" onClick={() => action('confirmHand')}>Confirm selected hand</button>}
      <p role="status">{status.canvasSetup?.message ?? (status.canvasConfirmed ? 'Canvas confirmed · Resume required' : 'Canvas confirmation required')}</p>
      <div className="settings-actions"><button data-action="beginCanvas" onClick={() => action('beginCanvas')}>Set canvas</button><button data-action="cancelCanvas" onClick={() => action('cancelCanvas')} disabled={!status.canvasSetup?.active}>Cancel canvas</button></div>
      <div className="actions">{actionLabels.map(([id, label]) => <button key={id} data-action={id} onClick={() => action(id)}>{label}</button>)}</div>
      <p className="hint">F8: {status.canvasSetup?.active ? 'mark corner' : 'pen toggle'} · F9: pause<br />Use Fn with function keys if macOS requires it. Confirm calibration and canvas before Resume.</p>
    </div>}
  </main>;
}

function Settings({ status, probe, setup, feedback, run, channel, voice }: { status: ProbeStatus; probe: ProbeReport; setup: SetupSnapshot | null; feedback: string | null; run: (work: () => Promise<void>) => void; channel: React.RefObject<BroadcastChannel | null>; voice: React.ReactNode }): React.JSX.Element {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState(status.settings?.cameraId ?? '');
  const [mode, setMode] = useState<Mode>(status.settings?.mode ?? 'head');
  useEffect(() => { if (status.settings) { setCameraId(status.settings.cameraId); setMode(status.settings.mode); } }, [status.settings?.cameraId, status.settings?.mode]);
  const send = (type: string, extra: Record<string, unknown> = {}): void => channel.current?.postMessage({ type, ...extra });
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [probeConfirmed, setProbeConfirmed] = useState(false);
  const [nativeProbeRunning, setNativeProbeRunning] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const refresh = useCallback((): void => { void navigator.mediaDevices.enumerateDevices().then(devices => setCameras(devices.filter(device => device.kind === 'videoinput'))).catch(cause => setDeviceError(String(cause))); }, []);
  useEffect(() => { refresh(); navigator.mediaDevices.addEventListener('devicechange', refresh); return () => navigator.mediaDevices.removeEventListener('devicechange', refresh); }, [refresh]);
  const start = (): void => run(async () => { await window.steady.selectCamera(cameraId, mode); channel.current?.postMessage({ type: 'start', cameraId, mode }); });
  const stop = (): void => run(async () => {
    try { await window.steady.action('pause'); }
    finally { channel.current?.postMessage({ type: 'stop' }); }
  });
  const nativeProbe = (): void => {
    if (!probeConfirmed || nativeProbeRunning) return;
    setNativeProbeRunning(true);
    setCountdown(5);
    run(async () => {
      const timer = setInterval(() => setCountdown(value => Math.max(0, value - 1)), 1000);
      try {
        await window.steady.runNativeProbe();
        // Main resolves once the supervised probe is scheduled; keep the
        // operator's countdown visible until that scheduling interval ends.
        await new Promise<void>(resolve => setTimeout(resolve, 5000));
      }
      finally { clearInterval(timer); setNativeProbeRunning(false); setCountdown(0); setProbeConfirmed(false); }
    });
  };
  const permissions = status.native?.permissions;
  return <main className="settings">
    <h1>Steady tracking setup</h1>
    <p>Opening settings pauses input. Closing settings keeps input paused. Camera capture continues in the companion panel while it is collapsed or unfocused.</p>
    <section aria-labelledby="camera-heading">
      <h2 id="camera-heading">Local camera and tracking</h2>
      <label>Mode<select value={mode} onChange={event => { stop(); setMode(event.target.value as Mode); run(() => window.steady.selectCamera(cameraId, event.target.value as Mode)); }}><option value="head">Head</option><option value="palm">Palm</option></select></label>
      <label>Camera<select value={cameraId} onChange={event => { stop(); setCameraId(event.target.value); run(() => window.steady.selectCamera(event.target.value, mode)); }}><option value="">Default camera</option>{cameras.map((camera, index) => <option key={camera.deviceId || index} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}</select></label>
      <div className="settings-actions"><button onClick={start}>Start camera probe</button><button onClick={stop}>Stop camera probe</button><button onClick={refresh}>Refresh cameras</button></div>
      <p role="status">{probe.message} · {probe.frames} frames{probe.delegate ? ` · ${probe.delegate}` : ''}</p>
      <p>Actual: {probe.width ?? '—'}×{probe.height ?? '—'} at {probe.frameRate ?? '—'} fps · valid {probe.validFrames ?? 0} · stale {probe.staleFrames ?? 0} · inference p95 {probe.inferenceMsP95?.toFixed(1) ?? '—'} ms</p>
      <p>Selected model hand: {probe.selectedHand ?? 'none'} · {probe.confirmationRequired ? 'Confirmation required after loss' : 'Continuity accepted'}. This is a conservative continuity heuristic.</p>
      <button disabled={mode !== 'palm' || !probe.running} onClick={() => run(() => window.steady.localAction('confirmHand'))}>Confirm selected hand</button>
      <p>The panel shows a mirrored preview. Move within comfortable bounds; anchors are mirrored exactly once.</p>
      <p>Requests 640×480 at 30 fps. One frame in flight; local models only. GPU initialization falls back to CPU once. Inference errors require explicit restart. No recordings are saved.</p>
      {deviceError && <p role="alert" className="error">{deviceError}</p>}
    </section>
    <section aria-labelledby="calibration-heading">
      <h2 id="calibration-heading">Five-position calibration</h2>
      <p>Neutral → comfortable left → right → up → down. Take as long as needed to reach each position, then Capture holds a two-second window. Each capture needs at least 40 valid frames and 80% validity. Small movement bounds require a retry.</p>
      <p role="status" data-testid="setup-message">{setup?.message ?? 'Start the camera to begin.'}</p>
      <p>Current step: {setup?.step ?? 'none'}{setup?.active ? ' · sampling' : ''}</p>
      <div className="settings-actions"><button disabled={!probe.running || setup?.active} onClick={() => send('calibrate')}>Begin five-position calibration</button><button disabled={!setup?.calibrating || setup.active} onClick={() => send('capture')}>Capture / Retry</button><button onClick={() => send('cancel')}>Cancel calibration</button><button disabled={!setup?.calibration || setup.active || !probe.running} onClick={() => send('recenter')}>Recenter neutral</button></div>
      {setup?.calibration && <>
        <p>Calibration saved for {setup.calibration.mode} / {setup.calibration.cameraId.slice(0, 12)}. Neutral jitter (scaled MAD): {setup.calibration.jitter.x.toFixed(5)}, {setup.calibration.jitter.y.toFixed(5)}.</p>
        <label>Gain<input aria-label="Gain" type="range" min="0.5" max="3" step="0.1" value={setup.calibration.gain} onChange={event => send('tuning', { gain: Number(event.target.value), smoothing: setup.calibration!.smoothing })} /></label><p>Gain {setup.calibration.gain}</p>
        <label>Smoothing<input aria-label="Smoothing" type="range" min="0" max="100" value={setup.calibration.smoothing} onChange={event => send('tuning', { gain: setup.calibration!.gain, smoothing: Number(event.target.value) })} /></label><p>Smoothing {setup.calibration.smoothing}; min cutoff {(4 - .034 * setup.calibration.smoothing).toFixed(2)} Hz, beta 1, derivative cutoff 1 Hz.</p>
      </>}
      <div className="mapping-preview" aria-label="Mapped pointer probe">{setup?.position && (() => { const bounds = status.displays.find(d => d.id === status.selectedDisplayId)?.bounds; return bounds && <span style={{ left: `${100 * (setup.position.x - bounds.x) / bounds.width}%`, top: `${100 * (setup.position.y - bounds.y) / bounds.height}%` }} />; })()}</div>
      <p>Camera/mode changes and recentering release input and leave it paused. Mark the canvas after calibration; remap whenever the Krita document area moves or changes size.</p>
    </section>
    <section aria-labelledby="baseline-heading">
      <h2 id="baseline-heading">Tracking performance baseline</h2>
      <button disabled={!setup?.calibration || !probe.running} onClick={() => send('baseline')}>Start 10s warmup + 60s baseline</button>
      <p data-testid="baseline-status">{setup?.baseline ?? 'idle'} · {setup?.metrics.mappingHz.toFixed(1) ?? '0'} mapped updates/s · {Math.round((setup?.metrics.elapsedMs ?? 0) / 1000)}s measured</p>
      <p>Renderer receipt-to-map p95 {setup?.metrics.receiptToMappedP95Ms?.toFixed(2) ?? '—'} ms. This is processing time; it excludes smoothing delay and native event latency. This metric excludes native output.</p>
      <pre data-testid="tracking-diagnostics">{JSON.stringify({ cameraId: status.settings?.cameraId, mode: status.settings?.mode, probe, baseline: setup?.baseline, metrics: setup?.metrics }, null, 2)}</pre>
    </section>
    {voice}
    <section aria-labelledby="native-heading"><h2 id="native-heading">Native status</h2>
      {status.nativeFault && <p role="alert" className="error">Native helper fault: {status.nativeFault}. Recover starts a fresh helper session and remains paused; camera Stop remains available.</p>}
      <p>{status.realInput ? 'Real input enabled for this session' : 'Fake input backend'} · {status.native?.state ?? 'Connecting'} · {status.native?.reason}</p>
      <dl><dt>Accessibility</dt><dd>{permissions?.accessibility ? 'Granted' : 'Not granted'}</dd><dt>Camera</dt><dd>{permissions?.camera ?? 'Unknown'}</dd><dt>Microphone</dt><dd>{permissions?.microphone ?? 'Unknown'}</dd><dt>Speech</dt><dd>{permissions?.speech ?? 'Unknown'}</dd></dl>
      <label>Display<select value={status.selectedDisplayId??''} onChange={event=>run(()=>window.steady.selectDisplay(Number(event.target.value)))} disabled={!status.displays.length}>{status.displays.map(display=><option key={display.id} value={display.id}>Display {display.id}{display.builtIn?' · built-in':''}{display.primary?' · primary':''}</option>)}</select></label>
      <p>Display geometry is reported by the helper in logical points.</p><ul>{status.displays.map(display => <li key={display.id}>Display {display.id}: {display.bounds.width}×{display.bounds.height} at ({display.bounds.x}, {display.bounds.y}){display.builtIn ? ' · built-in' : ''}{display.primary ? ' · primary' : ''}</li>)}</ul>
    </section>
    <DrawingSetup status={status} run={run} />
    <CommandSettings status={status} run={run} />
    <section aria-labelledby="input-probe-heading">
      <h2 id="input-probe-heading">Bounded real-input probe</h2>
      <p>This probe moves the pointer and briefly presses and releases the mouse button. Open a disposable Krita document on the selected display, then switch to Krita during the five-second countdown. Place the physical pointer inside its canvas with at least 12 points of clear space to the right. Krita must stay foreground for input. F9 cancels the probe and releases input.</p>
      <label className="confirmation"><input type="checkbox" checked={probeConfirmed} disabled={nativeProbeRunning} onChange={event => setProbeConfirmed(event.target.checked)} />I have a disposable Krita document open and will switch to Krita during the five-second countdown</label>
      <div className="settings-actions"><button disabled={!probeConfirmed || nativeProbeRunning} onClick={nativeProbe}>Run bounded real-input probe</button><button onClick={() => run(() => window.steady.releaseInput())}>Emergency release input</button></div>
      {nativeProbeRunning && <p role="status">{countdown > 0 ? `Switch to Krita now. Probe starts in ${countdown} seconds.` : 'Probe running. Keep Krita foreground.'}</p>}
    </section>
    {feedback && <p role="alert" className="error">{feedback}</p>}
    <button onClick={() => run(() => window.steady.closeSettings())}>Close settings</button>
  </main>;
}


function DrawingSetup({ status, run }: { status: ProbeStatus; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const [confirmed, setConfirmed] = useState(false);
  return <section aria-labelledby="drawing-heading">
    <h2 id="drawing-heading">Krita drawing and canvas</h2>
    <p>Prepare a disposable Krita 5.3.4 document. Native control requires Accessibility permission. Steady never switches applications for you. Text entry and modal dialogs are handled while paused.</p>
    <label className="confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I have a disposable Krita document ready for real pointer input</label>
    <div className="settings-actions">
      <button disabled={!confirmed || status.realInput} onClick={() => run(async () => { await window.steady.setRealInput(true); setConfirmed(false); })}>Enable real input</button>
      <button disabled={!status.realInput} onClick={() => run(() => window.steady.setRealInput(false))}>Use fake input</button>
      <button onClick={() => run(() => window.steady.recover())}>Recover native helper</button>
      <button onClick={() => run(() => window.steady.releaseInput())}>Emergency pause / release</button>
    </div>
    <p role="status">{status.canvasSetup?.message ?? (status.canvasConfirmed ? 'Canvas confirmed; Resume is required.' : 'Canvas confirmation required each launch.')}</p>
    <p>Complete calibration and select a display. Close Settings, switch to Krita, then choose Set canvas on the companion panel or use a configured Set canvas binding. Hover at the top-left corner and press F8, then hover at the bottom-right and press F8 again. Corners must form at least 100 × 100 logical points and exclude this panel. Capture always ends paused. Move the panel first if it overlaps the desired canvas.</p>
    <div className="settings-actions"><button onClick={() => run(() => window.steady.closeSettings())}>Close settings to set canvas</button><button disabled={!status.canvasSetup?.active} onClick={() => run(() => window.steady.cancelCanvas())}>Cancel canvas setup</button><button onClick={() => run(() => window.steady.closeSettings())}>Close settings before Resume</button></div>
    {status.canvas && <p>Canvas: {status.canvas.width.toFixed(0)} × {status.canvas.height.toFixed(0)} at ({status.canvas.x.toFixed(0)}, {status.canvas.y.toFixed(0)}).</p>}
    <p>Display changes, camera/mode changes, foreground changes, sleep and tracking loss release input. Return to Krita and Resume explicitly. Palm loss also requires Confirm selected hand. Moving or resizing the Krita document area requires Set canvas again.</p>
  </section>;
}

function CommandSettings({ status, run }: { status: ProbeStatus; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const [bindings, setBindings] = useState<GlobalBindings>(status.bindings ?? defaultBindings());
  const [profile, setProfile] = useState<ShortcutProfile>(status.profile ?? kritaProfile());
  // IPC clones configuration objects on every status update. Resynchronize a
  // draft only when saved values change, so live tracking cannot erase typing.
  const savedBindings = JSON.stringify(status.bindings ?? defaultBindings());
  const savedProfile = JSON.stringify(status.profile ?? kritaProfile());
  useEffect(() => { setBindings(JSON.parse(savedBindings) as GlobalBindings); }, [savedBindings]);
  useEffect(() => { setProfile(JSON.parse(savedProfile) as ShortcutProfile); }, [savedProfile]);
  const generic = profile.targetBundleId !== 'org.krita' || profile.name !== 'Krita';
  return <section aria-labelledby="commands-heading">
    <h2 id="commands-heading">Commands and global bindings</h2>
    <p>F8 toggles the pen, or marks corners during canvas setup. F9 pauses. Other bindings begin unassigned. macOS may require Fn with function keys; configure keys or an external switch here. Conflicts remain visible and require a different binding.</p>
    {status.bindingConflicts?.length ? <p role="alert" className="error">Global binding conflicts: {status.bindingConflicts.join('; ')}</p> : null}
    <div className="binding-grid">{ALL_CONTROLS.map(id => <label key={id}>{actionLabels.find(([action]) => action === id)?.[1] ?? ({openSettings:'Open settings',togglePanel:'Collapse / expand',quit:'Quit',beginCanvas:'Set canvas',cancelCanvas:'Cancel canvas',recover:'Recover helper',confirmHand:'Confirm hand'} as Record<string,string>)[id]}<input aria-label={`Binding ${id}`} value={bindings[id] ?? ''} placeholder="Unassigned" onChange={event => setBindings(current => ({ ...current, [id]: event.target.value }))} /></label>)}</div>
    <button onClick={() => run(() => window.steady.saveBindings(bindings))}>Save global bindings</button>
    <h3>Target shortcut profile</h3>
    <label>Profile<select value={generic ? 'generic' : 'krita'} onChange={event => setProfile(event.target.value === 'krita' ? kritaProfile() : { ...kritaProfile(), name: 'Generic', targetBundleId: 'org.example.editor' })}><option value="krita">Krita 5.3.4 defaults · manual verification required</option><option value="generic">Generic · unverified configuration preview</option></select></label>
    {generic && <><p className="error">Generic profiles are unverified configuration previews. Native input is available only with the fixed Krita profile in this phase.</p><label>Name<input value={profile.name} onChange={event => setProfile(current => ({ ...current, name: event.target.value }))} /></label><label>Bundle ID<input value={profile.targetBundleId} onChange={event => setProfile(current => ({ ...current, targetBundleId: event.target.value }))} /></label></>}
    {Object.entries(profile.shortcuts).map(([id, key]) => <label key={id}>{actionLabels.find(([action]) => action === id)?.[1] ?? id}<input aria-label={`Target shortcut ${id}`} readOnly={!generic} value={key} onChange={event => setProfile(current => ({ ...current, shortcuts: { ...current.shortcuts, [id]: event.target.value } }))} /></label>)}
    <button onClick={() => run(() => window.steady.saveProfile(profile))}>Save shortcut profile</button>
    <p>Krita defaults: Command-Z, Command-Shift-Z, B, E, ], [. Verify actual undo, redo, brush, eraser toggle and size changes in the disposable document. Erase is a toggle; Steady does not infer its state.</p>
  </section>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);
