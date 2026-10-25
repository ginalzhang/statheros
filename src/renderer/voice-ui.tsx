import { useEffect, useRef, useState } from 'react';
import { initialVoiceSnapshot, type VoiceLatencyReport, type VoiceSelfTest, type VoiceSnapshot } from '../shared/voice';
import { Earcons, VoiceCapture } from './voice-capture';
import { Icon } from './icons';

/** Subscribes to the main-process voice snapshot (the module never draws; the app renders it). */
export function useVoice(): { voice: VoiceSnapshot; keySource: 'env' | 'settings' | null } {
  const [state, setState] = useState<{ voice: VoiceSnapshot; keySource: 'env' | 'settings' | null }>({ voice: initialVoiceSnapshot(), keySource: null });
  useEffect(() => {
    void window.steady.voiceStatus().then(({ snapshot, keySource }) => { if (snapshot) setState({ voice: snapshot, keySource }); }).catch(() => undefined);
    return window.steady.onVoice((snapshot, keySource) => { if (snapshot) setState({ voice: snapshot, keySource }); });
  }, []);
  return state;
}

/** The panel owns the single microphone stream and the earcon output. */
export function useVoiceCapture(): void {
  useEffect(() => {
    const capture = new VoiceCapture(
      pcm => window.steady.voiceFrame(pcm),
      reason => window.steady.voiceReport({ type: 'failed', reason }),
      () => window.steady.voiceReport({ type: 'opened' }),
      () => window.steady.voiceReport({ type: 'deviceChanged' }),
    );
    const earcons = new Earcons(playId => window.steady.voiceReport({ type: 'earconStarted', playId }), playId => window.steady.voiceReport({ type: 'earconStopped', playId }));
    const off = window.steady.onVoiceCapture(command => {
      if (command.type === 'open') void capture.open();
      if (command.type === 'close') capture.close();
      if (command.type === 'earcon') earcons.play(command.name, command.playId);
      if (command.type === 'stopPlayback') earcons.stopAll();
    });
    return () => { off(); capture.close(); };
  }, []);
}

export const voiceLabel = (voice: VoiceSnapshot): string => {
  switch (voice.state) {
    case 'DISABLED': return 'Voice unavailable';
    case 'MUTED': return 'Mic off';
    case 'PASSIVE': return voice.inFlight ? 'Working…' : voice.wakeReady ? 'Listening for commands' : 'Push-to-talk ready';
    case 'WAKING': case 'LISTENING': return 'Listening…';
    case 'PTT_ACTIVE': return 'Speak · press again to send';
    case 'PROCESSING': return 'Thinking…';
    case 'EXECUTING': return voice.working ? 'Working…' : 'Got it';
    case 'FEEDBACK': return 'Done';
    case 'ERROR': return voice.lastError ?? 'Voice error';
  }
};
const listening = (voice: VoiceSnapshot): boolean => ['WAKING', 'LISTENING', 'PTT_ACTIVE'].includes(voice.state);
const shortcut = (accelerator: string): string => accelerator.replace('CommandOrControl', '⌘').replace('Shift', '⇧').replace('Space', 'Space').replace(/\+/g, '');

/** Panel Voice section (Figma: "Voice Commands" switch) plus the live indicator the voice module needs:
 * state, red cloud dot while audio leaves the Mac, transcript line (click cancels) and toasts. */
export function VoiceStrip({ voice }: { voice: VoiceSnapshot }): React.JSX.Element {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; long: boolean } | null>(null);
  const [toast, setToast] = useState<VoiceSnapshot['toast']>(null);
  const [transcriptVisible, setTranscriptVisible] = useState(false);
  useEffect(() => {
    if (!voice.toast) return;
    setToast(voice.toast);
    const timer = setTimeout(() => setToast(current => current?.id === voice.toast?.id ? null : current), 4000);
    return () => clearTimeout(timer);
  }, [voice.toast?.id]);
  useEffect(() => {
    if (voice.transcript) setTranscriptVisible(true);
    if (voice.state === 'FEEDBACK' || voice.state === 'PASSIVE') { const timer = setTimeout(() => setTranscriptVisible(false), 3000); return () => clearTimeout(timer); }
    return undefined;
  }, [voice.transcript, voice.state]);
  const off = voice.state === 'MUTED' || voice.state === 'DISABLED';
  const down = (): void => { press.current = { long: false, timer: setTimeout(() => { if (press.current) { press.current.long = true; window.steady.voiceButton('longpress'); } }, 600) }; };
  const up = (): void => { const current = press.current; press.current = null; if (!current) return; clearTimeout(current.timer); if (!current.long) window.steady.voiceButton('press'); };
  return <section className={`panel-section voice-strip state-${voice.state.toLowerCase()}`} aria-labelledby="voice-title">
    <h2 id="voice-title">Voice</h2>
    <div className="row"><span id="voice-switch-label">Voice Commands</span>
      {/* Shows actual activation (capture open), not only the request (handoff §02). */}
      <button className="switch" role="switch" aria-checked={!off} aria-labelledby="voice-switch-label" disabled={voice.state === 'DISABLED'} onClick={() => void window.steady.microphone(off)}><span /></button>
    </div>
    {!off && <div className="voice-live">
      <button className={`mic-button${listening(voice) ? ' live' : ''}`} aria-label={listening(voice) ? 'Stop listening' : 'Push to talk'}
        title={`Push to talk (${shortcut(voice.hotkey)}). Right-click or hold to mute (${shortcut(voice.muteHotkey)}).`}
        onPointerDown={down} onPointerUp={up} onPointerLeave={() => { if (press.current) { clearTimeout(press.current.timer); press.current = null; } }}
        onContextMenu={event => { event.preventDefault(); window.steady.voiceButton('longpress'); }}>
        <Icon name={listening(voice) ? 'micOn' : 'micOff'} size={18} />
      </button>
      <div className="voice-text">
        <p className="voice-state" role="status">{voiceLabel(voice)}{voice.cloudOn && <span className="cloud-dot" title="Audio is streaming to Cartesia" aria-label="Streaming to Cartesia" />}</p>
        {transcriptVisible && voice.transcript
          ? <p className={`voice-transcript${voice.transcriptFinal ? ' final' : ''}`} onClick={() => window.steady.voiceCancel()} title="Click to cancel">{voice.transcript}</p>
          : <p className="voice-hint">Just say “undo”, “brush”, “eraser”… · heard on this Mac; nothing leaves it until the red dot shows</p>}
      </div>
    </div>}
    {off && <p className="voice-hint">Off. Turn this on ({shortcut(voice.muteHotkey)}), then just say commands like “undo” or “brush”.</p>}
    {toast && <p className={`voice-toast ${toast.level}`} role="alert">{toast.message}</p>}
  </section>;
}

export function VoiceSettings({ voice, keySource, run }: { voice: VoiceSnapshot; keySource: 'env' | 'settings' | null; run: (work: () => Promise<void>) => void }): React.JSX.Element {
  const [key, setKey] = useState('');
  const [selfTest, setSelfTest] = useState<VoiceSelfTest | null>(null);
  const [latency, setLatency] = useState<VoiceLatencyReport | null>(null);
  const ms = (value: { median: number | null; max: number | null }): string => value.median === null ? '—' : `${value.median} ms median · ${value.max} ms max`;
  return <section aria-labelledby="voice-heading">
    <h2 id="voice-heading">Voice commands</h2>
    <p>With the microphone on, just say a command (“undo”, “redo”, “brush”, “eraser”, “pen down”, “bigger”, “pause”…), even inside a sentence like “switch to the brush”. Command words are recognized on this Mac and run at once. Anything else you say (“get rid of that last line”) is sent to Cartesia while the red dot shows, then read by Claude when an Anthropic key is set. {shortcut(voice.hotkey)} also sends one utterance. Mute the mic when you don't want to be heard.</p>
    <p role="status">{voiceLabel(voice)} · wake word {voice.wakeReady ? 'ready' : 'unavailable'} · VAD {voice.vad} · Cartesia key {voice.keyPresent ? (keySource === 'env' ? 'from CARTESIA_API_KEY' : 'saved in Keychain') : 'missing'}{voice.sttDisabled ? ' · speech-to-text disabled' : ''}</p>
    <dl><dt>Push to talk</dt><dd>{shortcut(voice.hotkey)} (toggle)</dd><dt>Mute</dt><dd>{shortcut(voice.muteHotkey)} or right-click the mic</dd><dt>Cancel</dt><dd>“cancel”, or click the transcript</dd></dl>
    {keySource !== 'env' && <div className="settings-actions">
      <label className="key-field">Cartesia API key<input type="password" autoComplete="off" spellCheck={false} placeholder={voice.keyPresent ? 'Saved — paste to replace' : 'sk_car_…'} value={key} onChange={event => setKey(event.target.value)} /></label>
      <button disabled={!key.trim()} onClick={() => run(async () => { await window.steady.setVoiceKey(key); setKey(''); })}>Save key</button>
      {voice.keyPresent && <button onClick={() => run(() => window.steady.setVoiceKey(null))}>Remove key</button>}
    </div>}
    <div className="settings-actions">
      <button onClick={() => run(() => window.steady.microphone(voice.state === 'MUTED'))}>{voice.state === 'MUTED' ? 'Turn microphone on' : 'Turn microphone off'}</button>
      <button onClick={() => run(async () => setSelfTest(await window.steady.voiceSelfTest()))}>Run mic self-test</button>
      <button onClick={() => run(async () => setLatency(await window.steady.voiceLatency()))}>Show latency</button>
    </div>
    {selfTest && <p role="status" className={selfTest.ok ? '' : 'error'}>Self-test: {selfTest.message}</p>}
    {latency && <p role="status">{latency.utterances} utterances · wake→first byte {ms(latency.wakeToFirstByte)} · speech end→final {ms(latency.speechEndToFinal)} · final→dispatch {ms(latency.finalToDispatch)} · inference {latency.inferenceMeanMs ?? '—'} ms/frame</p>}
  </section>;
}
