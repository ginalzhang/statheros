import { useCallback, useEffect, useState } from 'react';
import type { Mode, ProbeStatus } from '../shared/contracts';
import type { VoiceSelfTest, VoiceSnapshot } from '../shared/voice';
import type { ProbeReport } from './probe';
import type { SetupSnapshot } from './setup-controller';
import { CALIBRATION_STEPS } from './engine/calibration';
import { BunnyMark } from './logo';
import { Icon } from './icons';
import { Slider } from './controls';
import { activePreset, gainFromPercent, sensitivityPercent, STROKE_PRESETS } from './stroke-presets';
import { cameraState, type StateTone } from './utilities';

type Tab = 'motion' | 'voice' | 'appearance';
const TABS: [Tab, string][] = [['motion', 'Motion'], ['voice', 'Voice'], ['appearance', 'Appearance']];
const STEP_LABELS: Record<typeof CALIBRATION_STEPS[number], string> = { neutral: 'Hold Still', left: 'Move Left', right: 'Move Right', up: 'Move Up', down: 'Move Down' };

/** macOS authorization → permission pill. Reads the helper's report; never asserts access it has not seen. */
function permission(value: string | undefined): { label: string; tone: StateTone } {
  return value === 'authorized' ? { label: 'Allowed', tone: 'active' } : value === 'denied' || value === 'restricted' ? { label: 'Not allowed', tone: 'failed' }
    : value === 'notDetermined' ? { label: 'Not asked yet', tone: 'connecting' } : { label: 'Unknown', tone: 'paused' };
}
const Pill = ({ label, tone }: { label: string; tone: StateTone }): React.JSX.Element => <span className={`pill tone-bg-${tone}`}>{label}</span>;

/** Statheros 2 Settings modal (~860 × 690): Motion, Voice and Appearance tabs over Krita, beside the compact panel.
 * Every control drives existing behavior; the camera stays owned by the panel renderer. */
export function SettingsModal({ status, probe, setup, feedback, run, channel, voice, keySource }: { status: ProbeStatus; probe: ProbeReport; setup: SetupSnapshot | null; feedback: string | null; run: (work: () => Promise<void>) => void; channel: React.RefObject<BroadcastChannel | null>; voice: VoiceSnapshot; keySource: 'env' | 'settings' | null }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('motion');
  const select = (event: React.KeyboardEvent): void => {
    const index = TABS.findIndex(([id]) => id === tab), step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step) { event.preventDefault(); setTab(TABS[(index + step + TABS.length) % TABS.length]![0]); }
  };
  return <main className="utility settings-modal" aria-labelledby="settings-title">
    <header className="modal-header">
      <BunnyMark size={22} /><h1 id="settings-title">Settings</h1>
      <div className="tabs" role="tablist" aria-label="Settings sections" onKeyDown={select}>
        {TABS.map(([id, label]) => <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`pane-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <button className="icon close" onClick={() => run(() => window.steady.closeSettings())} aria-label="Close settings" title="Close"><Icon name="close" size={16} /></button>
    </header>
    <section className="modal-body" role="tabpanel" id={`pane-${tab}`} aria-labelledby={`tab-${tab}`}>
      {tab === 'motion' && <MotionTab status={status} probe={probe} setup={setup} run={run} channel={channel} />}
      {tab === 'voice' && <VoiceTab status={status} voice={voice} keySource={keySource} run={run} />}
      {tab === 'appearance' && <AppearanceTab status={status} run={run} />}
    </section>
    <footer className="modal-footer">
      {feedback ? <p role="alert" className="error">{feedback}</p> : <span />}
      <button className="link" onClick={() => run(() => window.steady.openAdvanced())}>Advanced settings…</button>
    </footer>
  </main>;
}

function MotionTab({ status, probe, setup, run, channel }: { status: ProbeStatus; probe: ProbeReport; setup: SetupSnapshot | null; run: (work: () => Promise<void>) => void; channel: React.RefObject<BroadcastChannel | null> }): React.JSX.Element {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback((): void => { void navigator.mediaDevices.enumerateDevices().then(devices => setCameras(devices.filter(device => device.kind === 'videoinput'))).catch(() => undefined); }, []);
  useEffect(() => { refresh(); navigator.mediaDevices.addEventListener('devicechange', refresh); return () => navigator.mediaDevices.removeEventListener('devicechange', refresh); }, [refresh]);
  const cameraId = status.settings?.cameraId ?? '', mode: Mode = status.settings?.mode ?? 'head';
  const camera = cameraState(probe), access = permission(status.native?.permissions.camera);
  // Choosing a source or mode (re)starts capture in the panel; the main process pauses input and asks for the canvas again.
  const connect = (id: string, next: Mode): void => run(async () => { await window.steady.selectCamera(id, next); channel.current?.postMessage({ type: 'start', cameraId: id, mode: next }); });
  const calibration = setup?.calibration ?? null, preset = activePreset(calibration);
  const tune = (gain: number, smoothing: number): void => { if (calibration) run(() => window.steady.tuneCalibration({ ...calibration, gain, smoothing })); };
  const penDown = Boolean(status.native?.buttonDown);
  const current = setup?.calibrating ? setup.step : null, currentIndex = current ? CALIBRATION_STEPS.indexOf(current) : -1;
  const send = (type: string): void => { channel.current?.postMessage({ type }); };
  return <>
    <p className="modal-intro">Configure your camera, tracking method, and movement controls.</p>
    <div className="modal-group">
      <h2>Camera Access</h2>
      <div className="modal-row"><span>Camera permission</span><Pill {...access} /></div>
    </div>
    <div className="modal-group">
      <h2>Camera &amp; Tracking</h2>
      <div className="modal-grid">
        <div className="field"><span className="field-label" id="mode-label">Tracking Mode</span>
          <div className="segmented" role="group" aria-labelledby="mode-label">
            <button aria-pressed={mode === 'palm'} onClick={() => connect(cameraId, 'palm')}>Palm</button>
            <button aria-pressed={mode === 'head'} onClick={() => connect(cameraId, 'head')}>Head</button>
          </div>
        </div>
        <label className="field"><span className="field-label">Camera Source</span>
          <select value={cameraId} onChange={event => connect(event.target.value, mode)}>
            <option value="">Default camera</option>
            {cameras.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
          </select>
          <span className={`field-status tone-${camera.tone}`} role="status">{camera.label === 'Disconnected' && probe.message !== 'Camera off' ? probe.message : `Camera ${camera.label}`}
            {!probe.running && <button className="link" onClick={() => connect(cameraId, mode)}>Connect</button>}</span>
        </label>
        <div className="field"><span className="field-label" id="pen-label">Drawing State</span>
          <div className="segmented" role="group" aria-labelledby="pen-label">
            <button aria-pressed={!penDown} onClick={() => run(() => window.steady.localAction('penUp'))}>Pen Up</button>
            {/* Opening Settings pauses input, and pointer actions are refused while it is open. */}
            <button aria-pressed={penDown} disabled title="Close Settings to put the pen down">Pen Down</button>
          </div>
        </div>
        <label className="field"><span className="field-label">Stroke Assistance</span>
          <select value={preset?.id ?? ''} disabled={!calibration} onChange={event => { const item = STROKE_PRESETS.find(entry => entry.id === event.target.value); if (item && calibration) tune(item.gain ?? calibration.gain, item.smoothing); }}>
            {!preset && <option value="">{calibration ? 'Custom' : 'Calibrate to choose a mode'}</option>}
            {STROKE_PRESETS.map(item => <option key={item.id} value={item.id} disabled={item.available === false}>{item.label}{item.available === false ? ' (not available yet)' : ''}</option>)}
          </select>
        </label>
        <Slider label="Tremor Smoothing" value={calibration?.smoothing ?? 50} disabled={!calibration} onCommit={value => calibration && tune(calibration.gain, value)} />
        <Slider label="Movement Sensitivity" value={sensitivityPercent(calibration?.gain ?? 1)} disabled={!calibration} onCommit={value => calibration && tune(gainFromPercent(value), calibration.smoothing)} />
      </div>
    </div>
    <div className="modal-group">
      <h2>Motion Calibration</h2>
      <p className="field-hint">Follow each direction to help Statheros map your movements.</p>
      <ol className="calibration-steps">
        {CALIBRATION_STEPS.map((step, index) => <li key={step} className={index === currentIndex ? 'current' : index < currentIndex ? 'done' : ''} aria-current={index === currentIndex ? 'step' : undefined}><span>{index + 1}</span>{STEP_LABELS[step]}</li>)}
      </ol>
      <div className="calibration-actions">
        <p role="status" className="field-hint">{setup?.calibrating || setup?.calibration ? setup.message : probe.running ? 'Ready to calibrate.' : 'Connect a camera to calibrate.'}</p>
        {setup?.calibrating
          ? <><button className="outline" disabled={setup.active} onClick={() => send('capture')}>Capture</button><button className="outline" onClick={() => send('cancel')}>Cancel</button></>
          : <button className="mint" disabled={!probe.running} onClick={() => send('calibrate')}>Start Calibration</button>}
      </div>
    </div>
  </>;
}

function VoiceTab({ status, voice, keySource, run }: { status: ProbeStatus; voice: VoiceSnapshot; keySource: 'env' | 'settings' | null; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const [key, setKey] = useState(''), [show, setShow] = useState(false), [test, setTest] = useState<VoiceSelfTest | null>(null), [testing, setTesting] = useState(false);
  const off = voice.state === 'MUTED' || voice.state === 'DISABLED';
  const result = testing ? { label: 'Testing…', tone: 'connecting' as const } : !test ? { label: 'Not Tested', tone: 'paused' as const } : test.ok ? { label: 'Working', tone: 'active' as const } : { label: 'Not working', tone: 'failed' as const };
  return <>
    <p className="modal-intro">Manage microphone access, voice commands, and AI voice configuration.</p>
    <div className="modal-group">
      <h2>Microphone Access</h2>
      <div className="modal-row"><span>Microphone permission</span><Pill {...permission(status.native?.permissions.microphone)} /></div>
    </div>
    <div className="modal-group">
      <h2>Voice Controls</h2>
      {/* Shows actual activation (capture open), not only the request. Voice never stops camera or motion. */}
      <div className="modal-row"><span id="voice-commands-label">Voice Commands</span><button className="switch" role="switch" aria-checked={!off} aria-labelledby="voice-commands-label" disabled={voice.state === 'DISABLED'} onClick={() => run(() => window.steady.microphone(off))}><span /></button></div>
    </div>
    <div className="modal-group">
      <h2>Cartesia Voice AI</h2>
      {keySource === 'env'
        ? <p className="field-hint">Using the key from the CARTESIA_API_KEY environment variable.</p>
        : <>
          <label className="field"><span className="field-label">API Key</span>
            <span className="key-row">
              <input type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={voice.keyPresent ? '•••• •••• •••• •••• ••••' : 'Paste your Cartesia API key'} value={key} onChange={event => setKey(event.target.value)} />
              <button className="outline" onClick={() => setShow(value => !value)} disabled={!key}>{show ? 'Hide Key' : 'Show Key'}</button>
              <button className="mint" disabled={!key.trim()} onClick={() => run(async () => { await window.steady.setVoiceKey(key); setKey(''); setShow(false); })}>Save Key</button>
            </span>
          </label>
          <p className="field-hint">Stored securely by the app{voice.keyPresent ? '; a key is saved' : ''}. A saved key is never displayed.</p>
        </>}
    </div>
    <div className="modal-group">
      <h2>Microphone Test</h2>
      <p className="field-hint">Check that your microphone and voice recognition can hear you.</p>
      <div className="modal-row start">
        <button className="selected-button" disabled={testing} onClick={() => run(async () => { setTesting(true); try { setTest(await window.steady.voiceSelfTest()); } finally { setTesting(false); } })}>Test Microphone</button>
        <Pill {...result} />
      </div>
      {test && <p className={`field-hint${test.ok ? '' : ' error'}`} role="status">{test.message}</p>}
    </div>
  </>;
}

function AppearanceTab({ status, run }: { status: ProbeStatus; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const transparent = (status.panelOpacity ?? 1) < 1;
  return <>
    <p className="modal-intro">Customize how the Statheros overlay appears over Krita.</p>
    <div className="modal-group">
      <h2>Transparency</h2>
      <div className="modal-row"><span id="transparency-label">Transparency Mode</span><button className="switch" role="switch" aria-checked={transparent} aria-labelledby="transparency-label" onClick={() => run(() => window.steady.setPanelOpacity(transparent ? 1 : 0.7))}><span /></button></div>
      <p className="field-hint">Allow the Krita workspace to remain visible through the Statheros overlay. Off keeps it fully opaque for the highest contrast.</p>
    </div>
  </>;
}
