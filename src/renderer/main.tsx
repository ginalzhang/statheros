import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActionID, Mode, ProbeStatus } from '../shared/contracts';
import { ALL_CONTROLS, defaultBindings, kritaProfile, type GlobalBindings, type LocalActionID, type ShortcutProfile } from '../main/commands';
import { CameraProbe, type ProbeReport } from './probe';
import './style.css';
import { SetupController, type SetupSnapshot } from './setup-controller';
import { useVoice, useVoiceCapture, VoiceSettings, VoiceStrip } from './voice-ui';
import { BunnyMark } from './logo';
import { Icon, type IconName } from './icons';
import { activePreset, gainFromPercent, sensitivityPercent, STROKE_PRESETS } from './stroke-presets';
import { edgeHint, rejectionHint } from './tracking';
import { orientationFor } from '../shared/settings';
import { CanvasOutline, CanvasOverlay } from './canvas-overlay';

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
        if (message?.type === 'auto-capture' && typeof message.enabled === 'boolean') controller.setAutoCapture(message.enabled);
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
    probeRef.current?.setOrientation(orientationFor(status.settings, status.settings?.cameraId ?? ''));
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
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'data-action', 'hidden', 'open'] });
    const observer = new ResizeObserver(register);
    observer.observe(document.body);
    document.addEventListener('scroll', register, true);
    return () => { mutations.disconnect(); observer.disconnect(); document.removeEventListener('scroll', register, true); };
  }, [isSettings, status.collapsed, probe.confirmationRequired, status.canvasSetup?.active]);

  const action = (id: LocalActionID): void => run(() => window.steady.localAction(id));
  const feedback = status.nativeFault ?? error ?? status.fault;
  const { voice, keySource } = useVoice();
  if (isSettings) return <Settings status={status} probe={probe} setup={setup} feedback={feedback} run={run} channel={channelRef} voice={<VoiceSettings voice={voice} keySource={keySource} run={run} />} />;
  // Stroke/motion modes reuse the calibration's gain and smoothing (no new engine).
  const tune = (gain: number, smoothing: number): void => { const calibration = setupRef.current?.state.calibration; if (calibration) run(() => window.steady.tuneCalibration({ ...calibration, gain, smoothing })); };
  return <Panel status={status} probe={probe} setup={setup} feedback={feedback} action={action} previewRef={previewRef} voice={<VoiceStrip voice={voice} />} tune={tune} />;
}

/** The panel renderer owns camera and microphone capture. */
function Panel({ status, probe, setup, feedback, action, previewRef, voice, tune }: { status: ProbeStatus; probe: ProbeReport; setup: SetupSnapshot | null; feedback: string | null; action: (id: LocalActionID) => void; previewRef: React.RefObject<HTMLCanvasElement | null>; voice: React.ReactNode; tune: (gain: number, smoothing: number) => void }): React.JSX.Element {
  useVoiceCapture();
  const native = status.native?.state;
  const calibration = setup?.calibration ?? null;
  const palm = (status.settings?.mode ?? 'head') === 'palm';
  const penDown = Boolean(status.native?.buttonDown);
  // Never show a false Active/Connected (handoff §04): status comes from the helper and the live feed.
  const guide = setup?.calibrating && !setup.active ? setup.guide : null;
  const hint = !probe.running ? null : edgeHint(probe.edge ?? null, palm ? 'palm' : 'head') ?? rejectionHint(probe.rejection, palm ? 'palm' : 'head')
    ?? (guide ? (guide.wrongWay ? `${stepLabel(guide.step)} registers the opposite way — turn on ${flipForStep(guide.step) === 'flipY' ? 'Flip up/down' : 'Flip left/right'} in Settings` : guide.farEnough ? `${stepLabel(guide.step)}: hold still${guide.auto ? ` · ${Math.min(1, guide.steadyMs / 1000).toFixed(1)} s` : ''}` : guide.step === 'neutral' ? 'Neutral: show your hand' : `${stepLabel(guide.step)}: keep going a little`) : null);
  const tracking: [string, string] = !native ? ['Connecting', 'muted'] : native === 'FAULT' ? ['Unavailable', 'bad'] : native === 'PAUSED' ? ['Paused', 'good strong'] : native === 'SETUP' ? ['Setting canvas', 'cyan'] : !probe.running ? ['No camera', 'bad']
    : probe.confirmationRequired ? ['Hand lost', 'bad'] : probe.rejection ? [palm ? 'No hand' : 'No face', 'muted'] : ['Active', 'good'];
  const paused = !native || native === 'PAUSED' || native === 'FAULT';
  // Quick pause/resume beside the tracking status and in the (collapsible) header; Resume still needs its usual prerequisites.
  const trackingToggle: { id: 'pause' | 'resume'; label: string } | null = native === 'PAUSED' ? { id: 'resume', label: 'Resume' } : native === 'HOVER' || native === 'DRAWING' ? { id: 'pause', label: 'Pause' } : null;
  const preset = activePreset(calibration);
  const chips = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState({ left: 0, width: 1 });
  const measure = (): void => { const el = chips.current; if (el) setScroll({ left: el.scrollLeft / Math.max(1, el.scrollWidth - el.clientWidth), width: el.clientWidth / el.scrollWidth }); };
  useEffect(measure, []);
  return <main className={`panel ${status.collapsed ? 'collapsed' : ''}`}>
    <header className="panel-header">
      <BunnyMark size={22} />
      <strong>Statheros</strong>
      {trackingToggle && <button className="icon" data-action={trackingToggle.id} onClick={() => action(trackingToggle.id)} aria-label={`${trackingToggle.label} tracking`} title={`${trackingToggle.label} tracking`}><Icon name={trackingToggle.id === 'resume' ? 'resumeTracking' : 'pauseTracking'} size={18} /></button>}
      {!status.collapsed && <button className="icon" data-action="openSettings" onClick={() => action('openSettings')} aria-label="Open settings" title="Settings"><Icon name="gear" size={18} /></button>}
      <button className="icon" data-action="togglePanel" onClick={() => action('togglePanel')} aria-label={status.collapsed ? 'Expand panel' : 'Collapse panel'} title={status.collapsed ? 'Expand' : 'Minimize'}><Icon name={status.collapsed ? 'chevronDown' : 'chevronUp'} size={16} /></button>
      {!status.collapsed && <button className="icon" data-action="quit" onClick={() => action('quit')} aria-label="Quit Steady" title="Quit"><Icon name="close" size={16} /></button>}
    </header>
    <div className="panel-content" hidden={status.collapsed}>
      <section className="panel-section" aria-labelledby="tracking-title">
        <h2 id="tracking-title">Tracking</h2>
        <div className="row"><span>{palm ? 'Hand Tracking' : 'Head Tracking'}</span>
          <span className="row-actions"><span className={`value ${tracking[1]}`} role="status">{tracking[0]}</span>
            {trackingToggle && <button className="link" data-action={trackingToggle.id} onClick={() => action(trackingToggle.id)} aria-label={`${trackingToggle.label} tracking`}>{trackingToggle.label}</button>}</span>
        </div>
        <div className="row"><span>Camera</span><span className={`value ${probe.running ? 'good' : 'muted'}`}>{probe.running ? 'Connected' : 'Off'}</span></div>
        <div className="row"><span>Canvas</span>
          {status.canvasSetup?.active && status.canvasSetup.mode === 'legacy'
            ? <span className="row-actions"><button className="link" data-action="markCorner" onClick={() => action('markCorner')}>Mark corner</button><button className="link" data-action="cancelCanvas" onClick={() => action('cancelCanvas')}>Cancel</button></span>
            : <span className="row-actions"><span className={`value ${status.canvasConfirmed ? 'good' : 'muted'}`}>{status.canvasConfirmed ? 'Set' : 'Not set'}</span><button className="link" data-action="beginCanvas" onClick={() => action('beginCanvas')}>Set canvas</button></span>}
        </div>
        {status.canvasSetup?.active && <p className="secondary" role="status">{status.canvasSetup.message}</p>}
        <button className="link" data-action="openSettings" onClick={() => action('openSettings')}>Recalibrate Tracking</button>
        {feedback && <p role="alert" className="error">{feedback}</p>}
      </section>
      <div className="preview-wrap"><section className="preview-card" aria-label={palm ? 'Hand Preview' : 'Head Preview'}>
        <h3>{palm ? 'Hand Preview' : 'Head Preview'}</h3>
        <canvas ref={previewRef} width={268} height={150} aria-label="Mirrored local camera preview" className="camera-preview" />
        {!probe.running && <p className="preview-empty">{probe.message}</p>}
        <footer><span className={`dot ${tracking[1].startsWith('good') && !paused ? 'on' : ''}`} />{paused ? 'Tracking Paused' : tracking[0] === 'Active' ? 'Tracking Active' : tracking[0]}<span className="divider" /><span className="muted">{penDown ? 'Pen Down' : 'Pen Up'}</span></footer>
      </section>
        {hint && <p className={`preview-hint${probe.confirmationRequired ? ' warn' : ''}`} role="status">{hint}</p>}
        {probe.confirmationRequired && <button className="confirm-hand" data-action="confirmHand" onClick={() => action('confirmHand')}>Confirm selected hand{probe.selectedHand ? ` (${probe.selectedHand})` : ''}</button>}
      </div>
      <section className="panel-section" aria-labelledby="input-title">
        <h2 id="input-title">Input</h2>
        <p className="label">Drawing State</p>
        <div className="segmented" role="group" aria-label="Drawing state">
          <button data-action="penUp" aria-pressed={!penDown} onClick={() => action('penUp')}>Pen Up</button>
          <button data-action="penDown" aria-pressed={penDown} onClick={() => action('penDown')}>Pen Down</button>
        </div>
      </section>
      <section className="panel-section" aria-labelledby="stroke-title">
        <h2 id="stroke-title">Stroke Assistance</h2>
        <div className="chips" ref={chips} onScroll={measure} role="radiogroup" aria-label="Stroke assistance">
          {STROKE_PRESETS.map(item => <button key={item.id} role="radio" aria-checked={preset?.id === item.id} className="chip" disabled={!calibration} onClick={() => tune(item.gain ?? calibration!.gain, item.smoothing)}>{item.label}</button>)}
        </div>
        <div className="scroll-indicator" aria-hidden="true"><span style={{ width: `${scroll.width * 100}%`, left: `${scroll.left * (1 - scroll.width) * 100}%` }} /></div>
        <div className="stroke-preview"><svg width="42" height="22" viewBox="0 0 42 22" aria-hidden="true"><path d={(preset ?? STROKE_PRESETS[1]!).preview} /></svg><span>{preset?.label ?? (calibration ? 'Custom' : 'Calibrate to choose a mode')}</span></div>
      </section>
      <section className="panel-section" aria-labelledby="motion-title">
        <h2 id="motion-title">Motion Assistance</h2>
        <Slider label="Tremor Smoothing" value={calibration?.smoothing ?? 50} disabled={!calibration} onCommit={value => calibration && tune(calibration.gain, value)} />
        <Slider label="Movement Sensitivity" value={sensitivityPercent(calibration?.gain ?? 1)} disabled={!calibration} onCommit={value => calibration && tune(gainFromPercent(value), calibration.smoothing)} />
        {!calibration && <p className="secondary">Calibrate in Settings to adjust these.</p>}
      </section>
      {voice}
      <section className="panel-section" aria-labelledby="canvas-title">
        <h2 id="canvas-title">Canvas</h2>
        <p role="status">{status.canvasSetup?.message ?? (status.canvasConfirmed ? 'Canvas confirmed · Resume required' : 'Canvas confirmation required')}</p>
        <div className="settings-actions">
          <button data-action="beginCanvas" onClick={() => action('beginCanvas')}>Detect canvas</button>
          {status.canvasSetup?.workspaceSuggestion && <button data-action="reviewWorkspace" onClick={() => action('reviewWorkspace')}>Review suggested workspace</button>}
          <button data-action="selectCanvas" onClick={() => action('selectCanvas')}>Select with mouse</button>
          <button data-action="cancelCanvas" onClick={() => action('cancelCanvas')} disabled={!status.canvasSetup?.active}>Cancel canvas</button>
        </div>
        <CanvasDetectionStatus status={status} />
        <details className="advanced-canvas"><summary>Advanced canvas setup</summary><p>Use tracking and F8 to mark corners.</p><button data-action="beginLegacyCanvas" onClick={() => action('beginLegacyCanvas')}>Mark corners with tracking</button></details>
      </section>
      <section className="panel-section" aria-labelledby="actions-title">
        <h2 id="actions-title">Actions</h2>
        <div className="action-pair">
          {paused
            ? <button className="primary" data-action="resume" onClick={() => action('resume')}>Resume Tracking</button>
            : <button className="primary" data-action="pause" onClick={() => action('pause')} aria-label="Pause input">Pause Tracking</button>}
          <button className="outline" data-action="recenter" onClick={() => action('recenter')}>Recalibrate</button>
        </div>
      </section>
      <nav className="toolbar" aria-label="Krita commands">
        {toolbar.map((item, index) => item === '|' ? <span key={index} className="divider" /> : <button key={item[0]} className={`tool${item[0] === 'penToggle' && penDown ? ' selected' : ''}`} data-action={item[0]} onClick={() => action(item[0])} aria-label={item[1]} title={item[1]}><Icon name={item[2]} size={18} /></button>)}
        <span className="divider" />
        <button className="tool" disabled title="AI Assist is not available in Steady" aria-label="AI Assist (unavailable)"><Icon name="sparkle" size={18} /></button>
        <span className={`dot ${tracking[0] === 'Active' && !paused ? 'on' : ''}`} title={tracking[0]} />
      </nav>
      <p className="hint">F8 {status.canvasSetup?.mode === 'legacy' && status.canvasSetup.active ? 'marks a corner' : 'toggles the pen'} · F9 pauses · {status.realInput ? 'real input' : 'fake input'}</p>
    </div>
  </main>;
}

/** Floating-toolbar order (Figma §2): select · pen · eraser | brush · smaller · bigger | undo · redo. */
const toolbar: ([ActionID, string, IconName] | '|')[] = [['click', 'Click', 'cursor'], ['penToggle', 'Pen toggle', 'penDown'], ['toggleErase', 'Toggle erase', 'eraser'], '|', ['brush', 'Brush', 'brush'], ['smaller', 'Smaller brush', 'smaller'], ['bigger', 'Bigger brush', 'bigger'], '|', ['undo', 'Undo', 'undo'], ['redo', 'Redo', 'redo']];

/** Continuous 0–100 % slider: the percentage follows the thumb; the engine setting is applied on release. */
function Slider({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (value: number) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => { if (draft !== value) onCommit(draft); };
  return <label className="slider">
    <span className="slider-label"><span>{label}</span><span className="value cyan">{draft}%</span></span>
    <input type="range" min={0} max={100} step={1} value={draft} disabled={disabled} aria-valuetext={`${draft}%`} style={{ '--fill': `${draft}%` } as React.CSSProperties}
      onChange={event => setDraft(Number(event.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
  </label>;
}

const stepLabel = (step: string): string => step[0]!.toUpperCase() + step.slice(1);

/** Live "far enough" meter + hold countdown + edge warning for the current calibration step. */
/** Which camera axis to flip when the hand registers the opposite way on a step. */
const flipForStep = (step: string): 'flipX' | 'flipY' => step === 'left' || step === 'right' ? 'flipX' : 'flipY';
function WrongWay({ step, status, run }: { step: string; status: ProbeStatus; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const axis = flipForStep(step), cameraId = status.settings?.cameraId ?? '';
  const current = orientationFor(status.settings, cameraId);
  const opposite = { left: 'right', right: 'left', up: 'down', down: 'up' }[step] ?? '';
  return <div className="wrong-way" role="alert">
    <p>Your hand is moving {opposite} in the camera view. The camera is probably mounted {axis === 'flipY' ? 'facing back toward you' : 'mirrored'}.</p>
    <button disabled={!cameraId} onClick={() => run(() => window.steady.setCameraOrientation(cameraId, axis === 'flipX' ? !current.flipX : current.flipX, axis === 'flipY' ? !current.flipY : current.flipY))}>Turn on {axis === 'flipY' ? 'Flip up/down' : 'Flip left/right'} (recalibrate after)</button>
  </div>;
}
function CalibrationGuideView({ setup, probe, mode, status, run }: { setup: SetupSnapshot; probe: ProbeReport; mode: Mode; status: ProbeStatus; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const guide = setup.guide;
  const edge = edgeHint(probe.edge ?? null, mode);
  const fraction = guide?.offset != null && guide.target ? Math.max(0, Math.min(1, guide.offset / guide.target)) : guide?.step === 'neutral' && guide.farEnough ? 1 : 0;
  return <div className="calibration-guide" role="status">
    <div className={`meter${guide?.farEnough ? ' ok' : ''}`} aria-label="Distance from neutral"><span style={{ width: `${fraction * 100}%` }} /></div>
    <p>{setup.active ? 'Capturing — keep holding…' : !guide ? 'Show your hand to the camera.' : guide.farEnough ? `Far enough — hold still${guide.auto ? ` (${Math.min(1, guide.steadyMs / 1000).toFixed(1)} / 1.0 s)` : ', then press Capture'}` : guide.step === 'neutral' ? 'Show your hand and rest it in a comfortable middle position.' : `${stepLabel(guide.step)}: keep going a little — a short move is enough`}</p>
    {edge && <p className="error">{edge}</p>}
    {guide?.wrongWay && <WrongWay step={guide.step} status={status} run={run} />}
  </div>;
}

/** Camera mount orientation (e.g. an overhead tripod). Changing it requires recalibration. */
function Orientation({ status, run }: { status: ProbeStatus; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const cameraId = status.settings?.cameraId ?? '';
  const current = orientationFor(status.settings, cameraId);
  const set = (flipX: boolean, flipY: boolean): void => run(() => window.steady.setCameraOrientation(cameraId, flipX, flipY));
  return <div className="orientation">
    <label className="confirmation"><input type="checkbox" disabled={!cameraId} checked={current.flipX} onChange={event => set(event.target.checked, current.flipY)} />Flip left/right (the preview moves opposite to your hand)</label>
    <label className="confirmation"><input type="checkbox" disabled={!cameraId} checked={current.flipY} onChange={event => set(current.flipX, event.target.checked)} />Flip up/down (camera mounted upside down or looking back at you)</label>
    <p className="secondary">Changing orientation pauses input and clears this camera's calibration.</p>
  </div>;
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
    <header className="settings-title"><BunnyMark size={30} /><h1>Statheros settings</h1></header>
    <p>Opening settings pauses input. Closing settings keeps input paused. Camera capture continues in the companion panel while it is collapsed or unfocused.</p>
    <section aria-labelledby="camera-heading">
      <h2 id="camera-heading">Local camera and tracking</h2>
      <label>Mode<select value={mode} onChange={event => { stop(); setMode(event.target.value as Mode); run(() => window.steady.selectCamera(cameraId, event.target.value as Mode)); }}><option value="head">Head</option><option value="palm">Palm</option></select></label>
      <label>Camera<select value={cameraId} onChange={event => { stop(); setCameraId(event.target.value); run(() => window.steady.selectCamera(event.target.value, mode)); }}><option value="">Default camera</option>{cameras.map((camera, index) => <option key={camera.deviceId || index} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}</select></label>
      <div className="settings-actions"><button onClick={start}>Start camera probe</button><button onClick={stop}>Stop camera probe</button><button onClick={refresh}>Refresh cameras</button></div>
      <Orientation status={status} run={run} />
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
      <p>Neutral → comfortable left → right → up → down. Each direction needs only a short move from neutral; never reach for the frame edge. Hold still for a second and it captures automatically (or press Capture), then keep holding for the two-second window. Each capture needs at least 40 valid frames and 80% validity. Small movement bounds require a retry.</p>
      <p role="status" data-testid="setup-message">{setup?.message ?? 'Start the camera to begin.'}</p>
      <p>Current step: {setup?.step ?? 'none'}{setup?.active ? ' · sampling' : ''}</p>
      {setup?.calibrating && <CalibrationGuideView setup={setup} probe={probe} mode={mode} status={status} run={run} />}
      <label className="confirmation"><input type="checkbox" checked={setup?.autoCapture ?? true} onChange={event => send('auto-capture', { enabled: event.target.checked })} />Auto-capture when I hold still for 1 second (Capture still works manually)</label>
      <div className="settings-actions"><button disabled={!probe.running || setup?.active} onClick={() => send('calibrate')}>Begin five-position calibration</button><button disabled={!setup?.calibrating || setup.active} onClick={() => send('capture')}>Capture / Retry</button><button onClick={() => send('cancel')}>Cancel calibration</button><button disabled={!setup?.calibration || setup.active || !probe.running} onClick={() => send('recenter')}>Recenter neutral</button></div>
      {setup?.calibration && <>
        <p>Calibration saved for {setup.calibration.mode} / {setup.calibration.cameraId.slice(0, 12)}. Neutral jitter (scaled MAD): {setup.calibration.jitter.x.toFixed(5)}, {setup.calibration.jitter.y.toFixed(5)}.</p>
        <label>Gain<input aria-label="Gain" type="range" min="0.5" max="3" step="0.1" value={setup.calibration.gain} onChange={event => send('tuning', { gain: Number(event.target.value), smoothing: setup.calibration!.smoothing })} /></label><p>Gain {setup.calibration.gain}</p>
        <label>Smoothing<input aria-label="Smoothing" type="range" min="0" max="100" value={setup.calibration.smoothing} onChange={event => send('tuning', { gain: setup.calibration!.gain, smoothing: Number(event.target.value) })} /></label><p>Smoothing {setup.calibration.smoothing}; min cutoff {(4 - .034 * setup.calibration.smoothing).toFixed(2)} Hz, beta 1, derivative cutoff 1 Hz.</p>
      </>}
      <div className="mapping-preview" aria-label="Mapped pointer probe">{setup?.position && (() => { const bounds = status.displays.find(d => d.id === status.selectedDisplayId)?.bounds; return bounds && <span style={{ left: `${100 * (setup.position.x - bounds.x) / bounds.width}%`, top: `${100 * (setup.position.y - bounds.y) / bounds.height}%` }} />; })()}</div>
      <p>Camera/mode changes and recentering release input and leave it paused. Canvas detection and mouse selection are available without camera capture or calibration; drawing still requires calibration and Resume.</p>
    </section>
    <section aria-labelledby="baseline-heading">
      <h2 id="baseline-heading">Tracking performance baseline</h2>
      <button disabled={!setup?.calibration || !probe.running} onClick={() => send('baseline')}>Start 10s warmup + 60s baseline</button>
      <p data-testid="baseline-status">{setup?.baseline ?? 'idle'} · {setup?.metrics.mappingHz.toFixed(1) ?? '0'} mapped updates/s · {Math.round((setup?.metrics.elapsedMs ?? 0) / 1000)}s measured</p>
      <p>Renderer receipt-to-map p95 {setup?.metrics.receiptToMappedP95Ms?.toFixed(2) ?? '—'} ms. This is processing time; it excludes smoothing delay and native event latency. This metric excludes native output.</p>
      <pre data-testid="tracking-diagnostics">{JSON.stringify({ cameraId: status.settings?.cameraId, mode: status.settings?.mode, probe, baseline: setup?.baseline, metrics: setup?.metrics }, null, 2)}</pre>
    </section>
    {voice}
    <section aria-labelledby="appearance-heading">
      <h2 id="appearance-heading">Appearance</h2>
      <label className="confirmation"><input type="checkbox" checked={(status.panelOpacity ?? 1) < 1} onChange={event => run(() => window.steady.setPanelOpacity(event.target.checked ? 0.7 : 1))} />Transparent overlay (70% opacity) so Krita shows through. Leave off for a fully opaque, high-contrast panel.</label>
    </section>
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


function CanvasDetectionStatus({ status }: { status: ProbeStatus }): React.JSX.Element {
  const [copying, setCopying] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const report = status.canvasDiagnostics;
  const diagnostics = report?.current?.diagnostics;
  const copyDiagnostics = (): void => {
    if (copying || !report?.current) return;
    setCopying(true); setCopyFeedback(null);
    void window.steady.copyCanvasDiagnostics().then(() => {
      setCopyFeedback({ message: 'Canvas diagnostics copied. You can paste them into the chat.', error: false });
    }).catch(cause => {
      setCopyFeedback({ message: `Could not copy canvas diagnostics: ${String(cause)}`, error: true });
    }).finally(() => setCopying(false));
  };
  return <div className="canvas-detection-status">
    {status.canvasSetup?.detection && <p role="status">{status.canvasSetup.detection.reason}</p>}
    {status.canvasSetup?.source === 'viewport' && <p>Using the drawing viewport, which may include gray workspace around the document.</p>}
    {status.canvasSetup?.source === 'manual' && <p>Manual bounds stay fixed on screen. Select again after zooming or panning when those changes cannot be observed.</p>}
    {status.canvasSetup?.workspaceSuggestion && <p>A suggested workspace is available for review. It may include document tabs, rulers, or scrollbars. Choose Review suggested workspace on the panel to inspect it or drag a replacement before Use canvas.</p>}
    {status.canvasSetup?.detection?.availability === 'unavailable' && <p>Use Select with mouse to choose the canvas. No screen capture or Krita plugin is used.</p>}
    <details className="canvas-diagnostics">
      <summary>Canvas diagnostics</summary>
      <p>Copy window geometry and Accessibility structure to help troubleshoot detection or unexpected canvas changes. The report contains no screenshots or document text.</p>
      {diagnostics && <p>{diagnostics.inspected} elements inspected{diagnostics.complete ? '; search complete' : '; search incomplete'}{diagnostics.truncated ? '; structural sample limited' : ''}.</p>}
      {report?.lastInvalidation && <p>Last canvas change: {report.lastInvalidation.reason}</p>}
      <button onClick={copyDiagnostics} disabled={copying || !report?.current}>{copying ? 'Copying…' : 'Copy canvas diagnostics'}</button>
      {!report?.current && <p>Waiting for canvas observations before diagnostics can be copied.</p>}
      {copyFeedback && <p role={copyFeedback.error ? 'alert' : 'status'} className={copyFeedback.error ? 'error' : undefined}>{copyFeedback.message}</p>}
    </details>
  </div>;
}

function DrawingSetup({ status, run }: { status: ProbeStatus; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const [confirmed, setConfirmed] = useState(false);
  return <section aria-labelledby="drawing-heading">
    <h2 id="drawing-heading">Krita drawing and canvas</h2>
    <p>Prepare a disposable Krita 5.3.4 document. Native control requires Accessibility permission. Mouse selection shows controls at the Steady panel's location while an overlay captures selection clicks, and returns focus to Krita when it closes. Handle text entry and modal dialogs while paused.</p>
    <label className="confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I have a disposable Krita document ready for real pointer input</label>
    <div className="settings-actions">
      <button disabled={!confirmed || status.realInput} onClick={() => run(async () => { await window.steady.setRealInput(true); setConfirmed(false); })}>Enable real input</button>
      <button disabled={!status.realInput} onClick={() => run(() => window.steady.setRealInput(false))}>Use fake input</button>
      <button onClick={() => run(() => window.steady.recover())}>Recover native helper</button>
      <button onClick={() => run(() => window.steady.releaseInput())}>Emergency pause / release</button>
    </div>
    <p role="status">{status.canvasSetup?.message ?? (status.canvasConfirmed ? 'Canvas confirmed; Resume is required.' : 'Canvas confirmation required each launch.')}</p>
    <p>Select a display, close Settings, and switch to Krita. Choose Detect canvas or Select with mouse on the companion panel. If a workspace suggestion is available, close Settings and choose Review suggested workspace on the panel. Inspect the highlight, which may include tabs, rulers, or scrollbars, or drag to replace it before Use canvas. For mouse selection, drag in either direction, review the rectangle, then Use canvas. Retry clears it for redrawing; Cancel or Escape leaves input paused. The rectangle must be at least 100 × 100 logical points and exclude this panel.</p>
    <CanvasDetectionStatus status={status} />
    <div className="settings-actions"><button onClick={() => run(() => window.steady.closeSettings())}>Close settings to set canvas</button><button disabled={!status.canvasSetup?.active} onClick={() => run(() => window.steady.cancelCanvas())}>Cancel canvas setup</button><button onClick={() => run(() => window.steady.closeSettings())}>Close settings before Resume</button></div>
    {status.canvas && <p>Canvas: {status.canvas.width.toFixed(0)} × {status.canvas.height.toFixed(0)} at ({status.canvas.x.toFixed(0)}, {status.canvas.y.toFixed(0)}).</p>}
    <p>Canvas setup always ends paused. Complete calibration and explicitly Resume to draw. Display changes, camera/mode changes, foreground changes, sleep and tracking loss release input. Palm loss also requires Confirm selected hand. Advanced canvas setup retains tracked corner marking with F8.</p>
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
    <p>F8 toggles the pen, or marks corners during advanced tracked setup. F9 pauses. Detect canvas and Select with mouse also have configurable bindings. Other bindings begin unassigned. macOS may require Fn with function keys; configure keys or an external switch here. Conflicts remain visible and require a different binding.</p>
    {status.bindingConflicts?.length ? <p role="alert" className="error">Global binding conflicts: {status.bindingConflicts.join('; ')}</p> : null}
    <div className="binding-grid">{ALL_CONTROLS.map(id => <label key={id}>{actionLabels.find(([action]) => action === id)?.[1] ?? ({openSettings:'Open settings',togglePanel:'Collapse / expand',quit:'Quit',beginCanvas:'Detect canvas',selectCanvas:'Select with mouse',reviewWorkspace:'Review suggested workspace',beginLegacyCanvas:'Tracked corner setup',cancelCanvas:'Cancel canvas',recover:'Recover helper',confirmHand:'Confirm hand'} as Record<string,string>)[id]}<input aria-label={`Binding ${id}`} value={bindings[id] ?? ''} placeholder="Unassigned" onChange={event => setBindings(current => ({ ...current, [id]: event.target.value }))} /></label>)}</div>
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
const view = new URLSearchParams(location.search).get('view');
if (view === 'canvas-overlay' || view === 'canvas-outline') document.documentElement.classList.add('canvas-window');
createRoot(root).render(<StrictMode>{view === 'canvas-overlay' ? <CanvasOverlay /> : view === 'canvas-outline' ? <CanvasOutline /> : <App />}</StrictMode>);
