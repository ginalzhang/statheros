# Implementation prompt: "Hey Cartesia" voice input (passive wake word + push-to-talk) via Cartesia Ink STT

> Historical implementation specification. Its wake-word flow and milestone requirements describe the original design. The current command-word/open-mic behavior is documented in [README.md](README.md).

> **How to use.** Paste into Claude Code (or any coding agent) opened at the root of the app repo. Fill in the three `<<PLACEHOLDERS>>` in §1 first. Follow the rest as written.
> **Scope line.** Milestones M0–M2b (§15) are the deliverable. Nothing in the "Later" list may be started until M2b's live smoke test passes.
> Cartesia facts (Appendix A) were verified against docs.cartesia.ai on 2026-10-24. If the live docs disagree, the docs win; say so in your final report.
> **Source of truth for behavior:** §5.0 (timers) + §5.1 (state table) + §5.2 (rules) + §8 (PTT sub-table) + §4.5 (abort path). Prose elsewhere explains; if it ever conflicts, §5 wins. For numbers, §12 wins over prose.

---

## 1. Mission

Add a **voice input layer** so a user can drive this desktop app by speaking:

1. **Passive mode ("Hey Google" style).** Listen *locally* for the wake phrase. The instant it is heard, give immediate visual + audible acknowledgement, stream the user's speech to Cartesia speech-to-text (STT), turn the result into a command string, and hand it to the app's existing command/computer-control layer. "hey cartesia, open chrome" in one breath must work. So must "hey cartesia … (pause) … open chrome".
2. **Explicit mode.** Hold a hotkey, tap it to toggle, or press the existing on-screen mic button. No wake word needed.

Placeholders:
- `<<WAKE_PHRASE>>` — default `hey cartesia`.
- `<<COMMAND_ENTRYPOINT>>` — the function/class that already executes a text command (find it in §3 if unknown).
- `<<HOTKEY>>` — default `ctrl+shift+space` (pynput: `<ctrl>+<shift>+space`; Electron: `CommandOrControl+Shift+Space`). Mute/panic hotkey defaults to `ctrl+shift+m`.

**Non-goals.** Do not rebuild the UI, camera/head/palm tracking, or computer-control actions. No Apple frameworks (no AVFoundation, Speech.framework, CoreAudio via Swift/pyobjc). No LLM inside this layer. Deliverable = a self-contained voice module, its integration points, tests, and a short README.

---

## 2. Stack decision table

Determine the stack in §3, then use the matching column everywhere below. Once §3 confirms one stack, ignore the other column.

| Concern | Python | Electron / Node |
|---|---|---|
| Capture | tap the existing `sounddevice`/`pyaudio` callback (§7) | renderer `getUserMedia` → `AudioWorklet` → 16 kHz int16 frames → `ipcRenderer.send('voice:frame')`; attach to an existing stream via `ctx.createMediaStreamSource(existingStream).connect(workletNode)` |
| Resample to 16 kHz mono | `soxr.ResampleStream(in_rate, 16000, 1, dtype='int16')` (stateful; dtype and channel count are fixed at construction, so downmix and cast **before** resampling) | `new AudioContext({sampleRate:16000})`; verify `ctx.sampleRate`, else stateful polyphase in the worklet |
| Wake word | sherpa-onnx KWS *or* openWakeWord ONNX via `onnxruntime` (§6) | `sherpa-onnx` npm KWS (`createKws`) |
| Local VAD | `silero-vad` pip, or sherpa-onnx `VoiceActivityDetector` (Silero model file downloaded separately) | sherpa-onnx `createVad` + `silero_vad.onnx` (separate download) |
| Inference thread | `threading.Thread`, ORT `intra_op_num_threads=1` | `worker_threads` in **main** process |
| Event loop | `asyncio` on a dedicated `VoiceRuntime` thread if the app's main loop is sync (OpenCV/MediaPipe) | Electron main process |
| STT socket | `websockets` (raw) | `ws` (raw) |
| Hotkey | `pynput` (hold + toggle; needs Accessibility, no prompt) | `globalShortcut` (toggle only, key-down only; **no hold-to-talk, no hold barge-in**) |
| Mute at OS level | `stream.close()` | `track.stop()` on every track + close the `AudioContext` |
| Mic permission | TCC attaches to the host process (§7) | `systemPreferences.getMediaAccessStatus('microphone')` → `not-determined|granted|denied|restricted|unknown`; `askForMediaAccess('microphone')` → `Promise<boolean>` (macOS only) |
| Earcon playback | persistent pre-opened `sounddevice.OutputStream` with preloaded int16 buffers | pre-decoded `AudioBuffer`s on a persistent `AudioContext` |
| Secrets | app's existing mechanism; else env `CARTESIA_API_KEY` | main process only; never the renderer |
| Tests | `pytest -q` | `npm test` (vitest/jest) |

Electron topology: renderer = dumb capture + earcon output only. Main owns ring buffer, wake+VAD worker, state machine, socket, hotkey, API key. No access-token minting is needed with this topology.

---

## 3. Discovery first (≤30 min, before code)

Write `docs/voice/DISCOVERY.md` (≤40 lines, file:line refs):

1. Stack, version, package manager, async model.
2. **Existing mic capture**: library, sample rate, channels, dtype, block size, where frames are delivered. You must **tap this stream, not open a second one**. If none exists, say so and create one (§7).
3. **Existing audio output**: how sounds/speech are played; whether the app ever speaks (TTS) and whether the spoken text is available before playback. You need "playback started/stopped" hooks.
4. `<<COMMAND_ENTRYPOINT>>`: exact signature, sync or async, **typical and worst-case duration** (sets `timers.command_s`), whether it has an abort/cancel hook (sets `ctx.abort_supported`), whether it returns **after the action completes** or fires and forgets (if the latter and no completion callback exists, run in **degraded mode**: `abort_supported=False`, `CommandDone` means "sent" and the toast says "Sent", and "stop" can only be a plain command), whether it already confirms destructive actions, whether it returns a human-readable result string, and whether it is LLM-backed (sets the `dispatch_low_confidence` default, §9.6).
5. UI surface for a state indicator + one transcript line, and whether it stays visible when the command layer focuses another app (always-on-top); what the mic button does today; whether it supports long-press/right-click.
6. Head/palm tracking: process/thread, approximate CPU; whether it exposes "user facing screen" or "palm raised" signals and how (§6.4).
7. Secrets convention. 8. Platform(s) and packaging. 9. Whether a previous instance of the app could still be running (§4.5 PID lock).

Unanswerable → state the assumption and proceed. Do not stop to ask.

---

## 4. Architecture and runtime contract

```
 mic stream ──▶ AudioTap (int16, downmix, resample, re-block 1280) ──┬──▶ RingBuffer.append (≈5 s; 0.5 s used as pre-roll)
 (existing)                                                           └──▶ frame queue (bounded)
                                     inference thread ◀──────────────────────┘
                                     ├─ LocalVad.process(frame)      → VadSpeechStart/End events
                                     └─ WakeWordDetector.process()   → WakeDetected(phrase) events
                                                 │
            Hotkey / Button / Esc / Mute ──▶ event queue ──▶ VoiceStateMachine.handle(ev, ctx, now) → [Action]
            Playback hooks / Camera hints ─▶   (runtime drops Stt* events with a stale session_id)
                                                 ┌─────────────────────┼──────────────────────┐
                                                 ▼                     ▼                      ▼
                                           Forwarder ──▶ SttSession   Feedback (earcon, UI)   Dispatch → <<COMMAND_ENTRYPOINT>>
                                           (only code that sends audio; checks cloud_gate)    (single-worker executor)
```

### 4.1 Interfaces (shapes matter, names are suggestions)

```python
Frame = (pcm_int16: bytes, n_samples: 1280, ts_mono: float)   # ts_mono = time.monotonic() at callback entry (same clock as hotkey/wake ts), NOT PortAudio's inputBufferAdcTime

class AudioTap:          def subscribe(cb: Callable[[Frame], None]) -> Unsubscribe
class LocalVad:          def process(frame) -> VadEvent | None     # SpeechStart(ts) | SpeechEnd(ts, speech_ms)
                         @property is_active: bool      # incl. hangover
                         @property raw_active: bool     # this frame above threshold
class WakeWordDetector:  def process(frame) -> WakeResult | None   # (phrase, score|None, ts); phrase ∈ {wake.phrase, "stop"}
                         def reset(); def set_enabled(bool)
class RingBuffer:        def read_from(ts) -> Iterator[bytes]      # 3200-byte chunks; one reader: the Forwarder
class SttSession:        # one per utterance; owns the transcript builder for its endpoint
    session_id: int
    async def open(); async def send_audio(pcm); async def finalize(); async def close(); async def abort()
    events: AsyncIterator[SttEvent]        # every event carries session_id
    # Connected:         EXACTLY ONCE, when the WebSocket handshake completes (both endpoints). The Auto
    #                    server's `connected` message is log-only. open() performs connect retries internally
    #                    and ends in Connected or Error; the machine never sees retries.
    # SpeechStart:       Auto turn.start.
    # Partial(text, eager): display-only. Auto: turn.update (eager=False) / turn.eager_end (eager=True), cumulative.
    #                    Manual: builder's accumulated is_final:true text + current is_final:false text.
    # TurnResume:        Auto turn.resume (server retracted an eager end).
    # Final(text):       at most once per finalize/turn, COMPLETE utterance text. Auto: on turn.end.
    #                    Manual: on flush_done (or on done/close if flush_done never arrives), verbatim concat of
    #                    all is_final:true deltas; the builder then resets so the next finalize yields only new text.
    # FinalizeRejected:  Manual `error` whose message indicates finalize-while-speaking; not an Error.
    # Error(code, msg, permanent): permanent=True for 401/403. 429 / other 4xx: permanent=False, not retried.
    # Closed:            socket closed (by us or the server).
class VoiceStateMachine: def handle(ev: Event, ctx: Context, now: float) -> list[Action]   # pure, sync, no I/O
```

### 4.2 Events (the only inputs to `handle`)

`WakeDetected(phrase, ts, score)`, `VadSpeechStart(ts)`, `VadSpeechEnd(ts, speech_ms)`, `HotkeyDown(ts)`, `HotkeyUp(ts)`, `HotkeyToggle`, `ButtonPressed`, `ButtonLongPress`, `MuteHotkey`, `Cancel(reason: esc|click)`, `Mute`, `Unmute`, `AppFocused`, `SttConnected`, `SttSpeechStart`, `SttPartial(text, eager)`, `SttTurnResume`, `SttFinal(text)`, `SttFinalizeRejected`, `SttError(code, msg, permanent)`, `SttClosed` (all `Stt*` carry `session_id`), `PlaybackStarted(kind: earcon|tts, text|None, play_id)`, `PlaybackStopped(play_id)`, `ProbeResult(ok, code)`, `CaptureFailed(reason)`, `DeviceChanged`, `AttentionHint(facing_screen, ts)`, `GestureHint(palm_raised, ts)`, `TimerFired(name, stamp)`, `CommandDone(cmd_id, result_text|None)`, `CommandFailed(cmd_id, msg)`, `Shutdown`.

### 4.3 Actions (the only outputs)

`OpenStt(kind: auto|manual)`, `StartForwarding(from_ts | None)`, `StopForwarding`, `SendFinalize`, `SendClose`, `AbortStt`, `SetCloudGate(bool)`, `SetWakeEnabled(bool)`, `ResetWake`, `PlayEarcon(name)`, `StopPlayback`, `ShowState(state)`, `ShowTranscript(text, final)`, `Toast(msg, level: info|warn)`, `Dispatch(CommandEvent)`, `AbortCommand(cmd_id, spoken_text|None)`, `SetTimer(name, seconds, stamp)`, `CancelTimer(name)`, `OpenCapture`, `CloseCapture`, `PadZeros(seconds)` (pad_then_close only), `Log(level, fields)`.

Every "toast" in this prompt is the `Toast` action. `ShowState` changes the indicator glyph only.

### 4.4 Context (the only mutable state; owned by `handle` except the two VAD mirror fields; readable via `snapshot()`)

`state, gen, session_id, source (wake|ptt), endpoint (auto|manual), ptt_mode (hold|toggle), hotkey_down_ts, release_deferred, detection_ts, last_wake_ts, vad_active (mirror, incl. hangover), vad_raw_active (mirror, above threshold right now), last_vad_end_ts, speech_ms (None until a VadSpeechEnd this utterance), last_partial, last_partial_eager, pending_prefix, remnant_turns (counter, for logs), close_sent, cmd_counter, in_flight_cmd, abort_supported (from §3.4), barge_in, wake_gated_until, live_playbacks (set), gating_play_id, playback_active (= bool(live_playbacks)), timers (dict name → (deadline, stamp); maintained by `handle` on every `SetTimer`/`CancelTimer` it emits and every `TimerFired` it accepts; "<timer> is live" everywhere in §5/§8 means name ∈ ctx.timers; state-exit cancellation iterates it), stt_disabled, device_swap_until, muted_reason, last_attention_ts`.

### 4.5 Runtime rules

- **Generations and stamps.** `ctx.gen` is the **utterance generation**: incremented on `OpenStt` and on entering `PASSIVE`, `MUTED`, or `ERROR`; never on other transitions (`WAKING→LISTENING`, `LISTENING→PROCESSING→LISTENING`, `PROCESSING→EXECUTING→FEEDBACK` keep it). `SetTimer` stamps the current `gen`; `TimerFired` with `stamp ≠ ctx.gen` is ignored. Exception: the `command` timer is stamped with `cmd_id` and ignored iff `cmd_id ≠ ctx.in_flight_cmd`. Second exception: `wake_gate_tail` and `gate_cap` are **unstamped** — never ignored by the `gen` rule and never cancelled by a state exit; `wake_gate_tail` is cancelled only by a `PlaybackStarted` that re-gates wake, `gate_cap` only by its own `PlaybackStopped`. On entering `ERROR`/`PASSIVE`/`MUTED` the `gen` bump happens before any entry timer is armed (`error_clear` carries the new `gen`). `SetTimer(name)` on a live timer replaces it. State-scoped timers are additionally cancelled on exit from their state: `handle` emits `CancelTimer` for every live state-scoped timer on exit (the traces elide these).
- **Sessions and the utterance reset.** `OpenStt` assigns `ctx.session_id`, increments `gen`, and performs the **utterance reset**: `last_partial = None`, `last_partial_eager = False`, `speech_ms = None`, `pending_prefix = None`, `remnant_turns = 0`, `close_sent = False`, `barge_in = False`, `release_deferred = False` (the wake rule from `EXECUTING` and `tap_decide` set `barge_in = True` *after* this reset). The runtime drops any `Stt*` event whose `session_id ≠ ctx.session_id` before calling `handle`. `AbortStt` clears `ctx.session_id` immediately (so the aborted socket's `Closed`/`Error` never reaches the machine). After `SendClose`, `session_id` persists until the next `OpenStt`, and `SttClosed` for it is log-only **except in `PROCESSING` before a `Final`, where it is treated as `forced_end` firing (§5.2 Global)**. **"Session open"** = `state ∈ {WAKING, LISTENING, PTT_ACTIVE, PROCESSING}`. **Gate invariant:** `AbortStt` and `SendClose` always imply `SetCloudGate(False)`, `StopForwarding` immediately before them (`handle` emits them; traces elide where already shown). `cloud_gate` is therefore False in every state except `LISTENING`/`PTT_ACTIVE` (and during a `pad_then_close` pad, §5.0), and the red cloud dot never outlives a session.
- **VAD mirror fields.** `ctx.vad_active` and `ctx.vad_raw_active` are written by the runtime on every frame from `LocalVad.is_active`/`raw_active` before draining the event queue; this is the one sanctioned exception to "only `handle` mutates `Context`". `speech_ms` and `last_vad_end_ts` are set by `handle` on `VadSpeechEnd` in every state.
- **Forwarder.** One task on the event loop owns the socket's write side. `StartForwarding(from_ts)` may be issued before `SttConnected`: until the socket is open, chunks are queued in RAM (not sent). `StartForwarding(None)` = from the newest ring-buffer frame; any `from_ts` older than the ring buffer's oldest frame is clamped to it. `StartForwarding` while already forwarding is a no-op (idempotent; (b) re-entry relies on this). Once open, it writes 3200-byte (100 ms) chunks: the first 1 s of backlog back-to-back, any remaining backlog at 2× real time, then live at real-time pace. Never drop audio while forwarding with the gate on; never burst more than 1 s. Every binary write checks `cloud_gate`; a chunk that reaches the write site while the gate is off is discarded, never held. `StopForwarding` discards any queued-but-unsent backlog and stops reading the ring buffer, so control frames enqueued after it go out immediately (on a forced end the unsent catch-up backlog is intentionally dropped). `SendFinalize`/`SendClose` are enqueued behind pending audio; if `open()` failed they are dropped. This is the only code path that sends audio. Once an utterance has started, keep sending (zeros if the mic vanished, until the machine's `ERROR` transition closes the socket) because stopping makes the server stall rather than infer silence. Pacing uses an injectable clock so integration tests can run faster than real time.
- **Frame queue.** `RingBuffer.append` happens in `voice_tap.push` (deque under a lock, sub-ms), so the pre-roll and live forwarding never have holes. The capture→inference queue is separate and bounded (`audio.frame_queue_max` 25 frames = 2 s); on overflow drop the oldest frame and `Log(warn, "inference behind N frames")` (tracking and inference contend for CPU; only detection may fall behind).
- **Threads → state machine.** Producers post events: Python `loop.call_soon_threadsafe(queue.put_nowait, ev)`; Node `parentPort.postMessage`. One consumer drains the queue, calls `handle`, executes actions in order. Never run inference or network on the capture callback. Never block the loop > 5 ms.
- **Dispatch.** `handle()` assigns `cmd_id = ++ctx.cmd_counter`, sets `ctx.in_flight_cmd`, and emits `Dispatch(CommandEvent)`. The runtime runs `<<COMMAND_ENTRYPOINT>>` on a **single-worker executor** (`run_in_executor` if sync, `create_task` if async) and posts `CommandDone(cmd_id, result_text)` / `CommandFailed(cmd_id, msg)`. Commands never run concurrently; a second `Dispatch` queues behind the first (its `command` timer still starts at `Dispatch`; accepted). There is no "interrupt" command: a spoken "stop" reaches the command layer only through `AbortCommand(cmd_id, spoken_text)`, which the runtime delivers **directly** to the cancel hook (never via the executor, where it would arrive too late). `CommandDone/Failed` with `cmd_id ≠ ctx.in_flight_cmd` → `Log` only. Matching: clear `in_flight_cmd`, `CancelTimer(command)`; in `EXECUTING` → `FEEDBACK`/`ERROR`; elsewhere → `Toast` (result text truncated to 80 chars).
- **Abort path** (invoked by: hotkey tap / `HotkeyToggle` / `ButtonPressed` / `Cancel` in `EXECUTING`; `Cancel` in the other active states or `PASSIVE` when `in_flight_cmd`; §9 outcome (a); local "stop"; outcome (d) barge-in; the `command` timer). The abort path never changes state by itself; the caller does.
  - **With a hook** (`abort_supported=True`): `AbortCommand(cmd_id, spoken_text)`, clear `in_flight_cmd`, `CancelTimer(command)`; the runtime calls the hook and later posts `CommandFailed(cmd_id, "aborted")`, which is unmatched → `Log` only. Callers in `EXECUTING` (tap/Toggle/Button/`Cancel`, local "stop") then `PlayEarcon(cancel)` → `PASSIVE` (local "stop" also `Toast("stopped")`).
  - **Without a hook** (`abort_supported=False`): `Toast("Can't stop that one")`, no `AbortCommand`, **no cancel earcon anywhere on this path**, `in_flight_cmd` stays set; the command runs to completion and any later `Dispatch` queues behind it. Callers in `EXECUTING`/`PASSIVE` stay in their state (the tap also `CancelTimer(tap_decide)`). `Cancel` (Esc/click) in `WAKING`/`LISTENING`/`PTT_ACTIVE`/`PROCESSING` and outcome (a) still cancel the *utterance* exactly as written (`AbortStt`/`SendClose`, `PASSIVE`); the cancel earcon plays there for a `Cancel` event, for always-interrupts (`cancel`/`never mind`), or when an `AbortCommand` was actually issued — never for a plain "stop" transcript without a hook. `Cancel` in `PASSIVE` with `in_flight_cmd`: earcon only if an `AbortCommand` was issued. Outcome (d) with a no-hook command in flight toasts `"Will run after the current command"` instead of "Can't stop that one" (`spoken_text=None`). The running command's eventual `CommandDone/Failed` surfaces per the matching rule.
  - **`command` timer fire**: `Toast("That took too long")` only (no second toast); with a hook → `AbortCommand`; without → **orphan** it: clear `in_flight_cmd`, `Log(warn, "executor still busy")`, its eventual `CommandDone/Failed` is unmatched → `Log`. If `EXECUTING` → `PASSIVE`.
- **Default rule.** Any (event, state) pair not covered by §5 → `Log(debug)`, no-op. `Stt*` events in states other than `WAKING`, `LISTENING`, `PTT_ACTIVE`, `PROCESSING` → `Log` only (covers the `turn.end` that follows an eager commit). `SttConnected` in `PTT_ACTIVE` → `CancelTimer(connect)` and the `forced_end` restart in §8; in `WAKING` it is the §5.2 transition; a duplicate in `LISTENING`/`PROCESSING` → log (the Forwarder flushes its queue). "Active state" = `WAKING`, `LISTENING`, `PTT_ACTIVE`, `PROCESSING`, `EXECUTING`.
- **Hotkeys.** The hotkey adapter MUST suppress OS auto-repeat (pynput `HotKey` does; raw listeners track key state). A non-repeat `HotkeyDown` sets `hotkey_down_ts = ts`; `HotkeyUp` clears it. `MuteHotkey` is edge-triggered and debounced (`ptt.mute_hotkey_debounce_ms` 500). The **gesture adapter** (not `handle`) owns palm timing: it posts `HotkeyToggle` only when `snapshot().state == PASSIVE`, only on a **rising edge** after `ptt.palm_dwell_ms` (1000) of continuous raise, only after the palm has been down for `ptt.palm_release_ms` (300) since the last trigger (use an otherwise unbound pose since palms already drive this app), and, if a facing-screen signal exists, only while facing the screen (gesturing at an audience must not open PTT). `handle` treats `GestureHint` as log-only. `AttentionHint` is kept in `last_attention_ts`; "facing the screen" = within `wake.attention_window_ms` (1500).
- **Capture.** `CloseCapture` also zeroes the ring buffer and stops the inference thread (§11.2). "Cancel earcon" = `PlayEarcon(cancel)`; barge-in into app playback = `StopPlayback`.
- **UI.** The module never draws. It exposes `snapshot() -> {state, transcript, cloud_on, level_dbfs, last_error, stt_disabled, in_flight}` and emits `state.changed`; the app's existing render loop polls or subscribes. `voice.enabled: false` → the module attaches nothing and reports `state == DISABLED`.
- **Playback.** Anything the app plays must bracket itself with `PlaybackStarted(kind, text)`/`PlaybackStopped` (wire the hook from §3.3; the module's own earcons do this automatically). `handle` tracks `playback_active`.
- **Startup.** Check `CARTESIA_API_KEY` is present; if not, `Toast("CARTESIA_API_KEY is missing")` once and set `ctx.stt_disabled=True` (wake/VAD still run). If present, **probe**: open one Manual socket and `close` it (no audio; deadline = `stt.connect_timeout_s`); on 401/403 → `stt_disabled` + the key-rejected toast; on 429 → `Toast("Cartesia busy (concurrency limit)")`; on 5xx/DNS/TLS/timeout → `Toast("Can't reach Cartesia — check network")` (both not sticky). The probe posts `ProbeResult(ok, code)` and a Global rule applies the above (so `handle` stays the only mutator; the key-presence check runs before the first `handle` call and is exempt). Nobody should learn about a bad key or venue Wi-Fi at the first wake on stage. Take a PID lockfile (`~/.cache/<app>/voice.lock`); if held by a live PID, refuse to start the voice module and `Toast("voice already running in another instance")`.

---

## 5. State machine

### 5.0 Timers

| Timer | Config key / value | Scope | Armed | On fire |
|---|---|---|---|---|
| `watchdog` | `timers.watchdog_s` (75; > `max_utterance_ptt_s` + `forced_end_wait_s`; `command_s` is irrelevant because it is cancelled on entering `EXECUTING`) | utterance | `OpenStt`; **cancelled on entering `EXECUTING`** | `AbortStt`, `PASSIVE`, log |
| `connect` | derived: `stt.connect_timeout_s + 1` (5) | state (`WAKING` or `PTT_ACTIVE`); also cancelled by `SttConnected` | `OpenStt` (backstop; `open()`'s own 4 s deadline normally fails first) | `AbortStt`, `ERROR` "Couldn't reach Cartesia" |
| `no_speech` | `timers.no_speech_s` (6) | LISTENING | entry unless `vad_active`; after a text-less `VadSpeechEnd`; **re-armed** (not cancelled) by `SttSpeechStart`; cancelled by `VadSpeechStart` and by any non-remnant `SttPartial` | `SetCloudGate(F)`, `StopForwarding`, `SendClose`, `close_sent=True`, `PASSIVE`, silent |
| `ptt_no_speech` | `ptt.no_speech_s` (8) | PTT_ACTIVE (both modes) | entry (and on tap→toggle switch, and on a toggle blip per §8) unless `vad_active`; cancelled by `VadSpeechStart` and by a non-empty `SttPartial` | `AbortStt`, `Toast("Didn't catch that")`, `PASSIVE` |
| `max_utterance` | `timers.max_utterance_s` (15) in LISTENING; `timers.max_utterance_ptt_s` (60) in PTT_ACTIVE | state | entry from another state (`WAKING→LISTENING`, PTT entry). **Never re-armed within an utterance**: the text-less pause rule does not touch it, and the synchronous `LISTENING→PROCESSING→LISTENING` round-trip of (b) does not count as leaving `LISTENING` (the original deadline stands). Bounds every wait below, including `pending_prefix` and all (b) re-entries | forced end |
| `stt_final` | derived: `turn.end_timeout_ms/1000 + 1.0 − vad.hangover_ms/1000` (= 1.9) | LISTENING, Auto only | `VadSpeechEnd` with non-empty stripped `last_partial`; the lag-corrective arm; cancelled by `VadSpeechStart`/`SttFinal` | forced end |
| `eager_commit` | `stt.eager_commit_ms` (300) | LISTENING, Auto only, if `stt.eager_commit` | `SttPartial(eager=True)` when `not vad_active` **and the text strips to non-empty**; or `VadSpeechEnd` (non-empty stripped `last_partial`) when `last_partial_eager`; cancelled by `VadSpeechStart`/`SttTurnResume`/`SttFinal` | **commit**: `SendClose`, `close_sent=True`, then the normal end path with text = `pending_prefix + " " + last_partial` (whichever exist), `confidence="high"` ((b) impossible because `close_sent`) |
| `manual_end` | `stt.manual_end_silence_ms` (150) | LISTENING, Manual only | same arming as `stt_final` | soft end |
| `prefix_timeout` | `stt.prefix_timeout_ms` (1000) | LISTENING | `pending_prefix` set (and re-armed, if not live, by a `VadSpeechEnd` while the prefix is pending); cancelled by non-remnant `SttPartial`/`SttFinal` | if `vad_active` (user mid-word, no partial yet) → re-arm (bounded by `max_utterance` and by the next partial/`Final`); else normal end path with text = `pending_prefix`, `confidence="high"` |
| `tap_decide` | `ptt.tap_max_ms` (250) | EXECUTING | `HotkeyDown`; **cancelled by `HotkeyUp`** (explicit, because a no-hook tap stays in `EXECUTING`) | PTT barge-in: → `PTT_ACTIVE` (hold) with `StartForwarding(hotkey_down_ts)`, `barge_in=True` |
| `release_grace` | `ptt.release_grace_ms` (400): effective 400 if `speech_ms is None` (no `VadSpeechEnd` this utterance) else `max(0, 400 − ms since last_vad_end_ts)` | PTT_ACTIVE (hold) | `HotkeyUp` (held ≥ `tap_max_ms`) | if `vad_active` → `release_deferred=True`, `SetTimer(release_cap)`; else soft end |
| `release_cap` | `ptt.release_speech_cap_s` (1.5) | LISTENING (Manual) / PTT_ACTIVE (both) | deferred release or `SttFinalizeRejected` while `vad_active`; cancelled when the deferred soft end happens | soft end regardless of VAD |
| `hold_silence` | `ptt.hold_silence_s` (6) | PTT_ACTIVE (hold) | `VadSpeechEnd` when no release is deferred; cancelled by `VadSpeechStart`/`HotkeyUp` | treat as release (lost `HotkeyUp`): soft end |
| `ptt_auto_end` | `ptt.auto_end_silence_ms` (400) | PTT_ACTIVE (toggle) | `VadSpeechEnd`; a non-empty `SttPartial` while `ptt_no_speech` is live and `not vad_active` (§8); an Electron `HotkeyToggle` hand-off from `WAKING`/`LISTENING`/`PROCESSING` with `not vad_active` (§5.2); cancelled by `VadSpeechStart` | soft end |
| `forced_end` | `timers.forced_end_wait_s` (1) | utterance | any forced or soft end that awaits a `Final` (if armed by a soft end before `SttConnected`, the countdown starts at `SttConnected`); a second soft end while one is pending is a no-op; cancelled by any `SttFinal`; cancelled by `SttFinalizeRejected` **only in `LISTENING`/`PTT_ACTIVE`** (which re-arm it) | `SetCloudGate(F)`, `StopForwarding`; text = `pending_prefix + " " + last_partial` (whichever exist); if any → §9 with `confidence="low"`; else outcome (c) |
| `command` | `timers.command_s` (derived: 2× worst-case from §3.4, min 30) | command (stamped `cmd_id`) | `Dispatch` | abort path's `command` branch (§4.5) |
| `executing_spinner` | `timers.spinner_delay_ms` (400) | EXECUTING | entry | add the "working…" label (text is shown from entry; only the label waits) |
| `feedback_min` | `timers.feedback_min_ms` (700) | FEEDBACK | entry | `PASSIVE` |
| `error_clear` | `timers.error_clear_s` (3) | ERROR | entry | `PASSIVE` |
| `wake_gate_tail` | `wake.playback_gate_tail_ms` (200) | none (unstamped; survives all states and generations) | `PlaybackStopped` of the gating `play_id`; cancelled by a `PlaybackStarted` that gates wake | `SetWakeEnabled(True)`, `ResetWake`, `wake_gated_until = now` |
| `gate_cap` | `wake.gate_cap_s` (earcon 1, tts 30) | none (unstamped) | a gating `PlaybackStarted`; cancelled by its `PlaybackStopped` | as `wake_gate_tail` fire; also remove `gating_play_id` from `live_playbacks` and set it `None` (a lost `PlaybackStopped` cannot leave wake dead or `playback_active` stuck) |

Scope "state": cancelled on exit from that state. Scope "utterance": cancelled on entering `PASSIVE`, `MUTED`, or `ERROR`, or on `SttClosed`. Scope "command": cancelled only by a matching `CommandDone/Failed` or by the abort path.

**End paths (the only three ways an utterance's audio stops):**
- **Normal end path** (used by `SttFinal`'s dispatch branch, `prefix_timeout`, the `VadSpeechEnd`-with-`pending_prefix` branch, and the `eager_commit` commit) = `SetCloudGate(F)`, `StopForwarding`, `pending_prefix = None`, `ShowState(PROCESSING)`, run §9 on the given text with the given confidence, outcome per **PROCESSING** (a)–(d). `close_sent` is set only by forced end, `eager_commit`, and `no_speech`; the normal end path leaves it as is, so (a)/(c)/(d) issue the `SendClose` when needed.
- **Soft end** (`manual_end`, `release_grace`, `release_cap`, `hold_silence`, `ptt_auto_end`, toggle second press, lost-`HotkeyUp` recovery, `HotkeyToggle`/`ButtonPressed` in `PTT_ACTIVE`) = `SendFinalize`, `SetTimer(forced_end)`; stay in the current state, gate on, forwarding continues until `SttFinal` or `forced_end`.
- **Forced end** (`max_utterance`, `stt_final`) = `SetCloudGate(F)`, `StopForwarding`, then Auto: `SendClose`, `ctx.close_sent=True` (if M2b finds that `close` does not flush a trailing `turn.end`, set `stt.auto_forced_end: pad_then_close`: the Auto forced end still sets `ctx.close_sent=True` immediately (so (b) stays unreachable) but defers the actual `SendClose`: the Forwarder sends **zero frames only** for `forced_end_wait_s` (`PadZeros(seconds)` action), then `SetCloudGate(F)`, `StopForwarding`, `SendClose`; any `StopForwarding` during the pad ends it and emits the `close`; §11.1 is relaxed to "zeros only" in `PROCESSING` for this mode and the red dot stays on during the pad); Manual: `SendFinalize` **then `SendClose`, `ctx.close_sent=True`** (A.1: `close` flushes buffered audio; the builder emits its single `Final` on `flush_done`/`done`); → `PROCESSING`, `SetTimer(forced_end)`. A `Final` arriving in `PROCESSING` cancels `forced_end` and takes the normal end path. Because every forced end sets `close_sent`, outcome (b) is unreachable after one; a remnant-only `Final` after a forced end is (c).

**Text-less pause rule** (replaces any "remnant cap"; wake source only): on `VadSpeechEnd` in `LISTENING`, if `last_partial` is `None` or strips to empty under §9.2 → nothing commandable was said yet (wake-phrase tail, cough, audience noise): `remnant_turns += 1` (log only), `speech_ms = None`, `last_partial = None`, `SetTimer(no_speech)` unless `vad_active` (re-arm if already live); do **not** arm `stt_final`/`manual_end`; keep forwarding. Bounded by the utterance's original `max_utterance` deadline. "Already counted" is mechanically `speech_ms is None` after a `VadSpeechEnd` this turn.
**Lag-corrective arm**: any non-remnant `SttPartial` that arrives while `no_speech` or `prefix_timeout` is live and `not vad_active` → cancel it, arm `stt_final` (Auto) / `manual_end` (Manual). Covers partials that lag a real short command (including after a `pending_prefix`).

### 5.1 States

| State | Audio → cloud | `WakeDetected(wake)` | `WakeDetected("stop")` | Hotkey / button | Exit events | Indicator |
|---|---|---|---|---|---|---|
| `PASSIVE` | No | → `WAKING` | if `in_flight_cmd`: local abort (§5.2) | Down/Toggle/Button → `PTT_ACTIVE` | wake, hotkey, button, mute; `Cancel` with `in_flight_cmd` → abort path, stay | dim |
| `WAKING` | No (socket opening; ring buffer still fills) | ignore | if `barge_in` and `in_flight_cmd`: local abort (§5.2) | Down/Toggle → `AbortStt`, `PTT_ACTIVE` silently (no earcon of any kind; forwards from `detection_ts − preroll_ms` when `source == wake`); Button → `Cancel` (users tap the mic to stop) | `SttConnected`→`LISTENING`; `SttError`/`connect`→`AbortStt`,`ERROR` | same glyph as LISTENING |
| `LISTENING` | **Yes** | ignore | if `barge_in` and `in_flight_cmd`: local abort (§5.2) | Down/Toggle → `AbortStt`, `PTT_ACTIVE` silently (forwards from `detection_ts − preroll_ms` when `source == wake`); Button → `Cancel` | `SttFinal`→normal end path; forced end→`PROCESSING`; soft end→stay; `forced_end`/`eager_commit`/`prefix_timeout`→§9 outcomes; `no_speech`→`PASSIVE`; `SttError`/`SttClosed`→`AbortStt`,`ERROR`; `Cancel`→`PASSIVE` | pulsing + live transcript + **red cloud dot** |
| `PTT_ACTIVE` | **Yes** | ignore | ignore | see §8 sub-table | `SttFinal`→normal end path; `max_utterance`→forced end; `forced_end`→§9 outcomes; `ptt_no_speech`→`PASSIVE`; `connect`→`AbortStt`,`ERROR`; `SttError`/`SttClosed`→`AbortStt`,`ERROR`; `Cancel`→`PASSIVE` | "release / press again to send" + live transcript + cloud dot |
| `PROCESSING` | No (only control frames) | `AbortStt`, then as `PASSIVE` (the user re-said the phrase during the ≤1 s wait) | ignore | as `LISTENING` | §9 → `EXECUTING` / `PASSIVE` / `LISTENING` (b); `forced_end`→§9 outcomes | unchanged |
| `EXECUTING` | No | → `WAKING`, `barge_in=True` (command keeps running) | local abort | Down → `SetTimer(tap_decide)`; Up while `tap_decide` is live → abort path (tap); Up with no live `tap_decide` → no-op (e.g. the real key-up after `hold_silence` already dispatched); Toggle/Button → as abort tap (toggle-only inputs cannot barge-in) | `CommandDone`→`FEEDBACK`; `CommandFailed`→`ERROR`; `Cancel`→abort path; `tap_decide`→`PTT_ACTIVE`; abort path with hook→`PASSIVE`; `command` timer→`PASSIVE` (§4.5) | understood text; "working…" label after 400 ms |
| `FEEDBACK` | No | → `WAKING` | ignore | Down/Toggle/Button → `PTT_ACTIVE` | `feedback_min`→`PASSIVE`; `Cancel`→`PASSIVE` (no earcon) | toast with result |
| `ERROR` | No | as `PASSIVE` | ignore | as `PASSIVE` (non-permanent) | `error_clear`→`PASSIVE` | amber + message |
| `MUTED` | No; capture closed at OS level | n/a (no frames) | n/a | `Toast("unmute first")` | `Unmute`/`MuteHotkey`→`PASSIVE` | slash |

The wake detector and VAD consume every frame in every state except `MUTED`. Whether a `WakeDetected` does anything is decided by this table. `SetWakeEnabled(False)` is used *only*: (1) while the app plays an **earcon** plus `playback_gate_tail_ms`, then `ResetWake`; (2) while the app plays **TTS whose text contains any detector keyword** (the last word of `wake.phrase`, or `stop` when `local_stop_keyword` is on; from `PlaybackStarted(tts, text)`); other TTS leaves wake on so "hey cartesia, stop" works while the app speaks.

### 5.2 Rules

- **Wake** (`PASSIVE`/`EXECUTING`/`FEEDBACK`/`ERROR` on `WakeDetected(wake)`): if within `refractory_s` of `last_wake_ts`, or inside a wake-gated window, or (`wake.require_attention` and no `AttentionHint(true)` in the last 1.5 s) → ignore, log. If `stt_disabled` → `Toast` (the startup/permanent-error message), stay. Else `last_wake_ts = detection_ts = ts`, `source = wake`, if `playback_active` → `StopPlayback`, `PlayEarcon(wake)`, `ShowState(WAKING)`, `OpenStt(auto)` (or `manual` if `stt.wake_endpoint: manual`; the utterance reset happens here), then `barge_in = True` if coming from `EXECUTING`, `SetTimer(watchdog)`, `SetTimer(connect)`.
- **`WAKING → LISTENING` on `SttConnected`**: `SetCloudGate(True)`, `StartForwarding(detection_ts − preroll_ms)`, `ShowState(LISTENING)`, `SetTimer(max_utterance)`; `SetTimer(no_speech)` only if `vad_active` is false. This design waits for the handshake so `WAKING` is provably cloud-silent (§11.1); Cartesia does not require waiting for its `connected` message, and we don't.
- **`LISTENING`**: `VadSpeechStart` → cancel `no_speech`, `stt_final`, `manual_end`, `eager_commit`. `SttSpeechStart` → re-arm `no_speech` if live (a text-less server `turn.start` for the remnant must not unbound the pause). `SttPartial(text, eager)` → `last_partial = text`, `last_partial_eager = eager`, `ShowTranscript(§9.1–2 of text, false)`; if the stripped text is non-empty: if `prefix_timeout` or `no_speech` is live → cancel it and, if `not vad_active`, apply the lag-corrective arm; if `eager` and `not vad_active` and `stt.eager_commit` and stripped non-empty → `SetTimer(eager_commit)`. `SttTurnResume` → `last_partial_eager = False`, cancel `eager_commit`. `VadSpeechEnd(speech_ms)` → `speech_ms = …`, `last_vad_end_ts = ts`; if `release_deferred` → cancel `release_cap`, clear the flag, soft end; else if `pending_prefix` set and (`last_partial is None` or strips to empty) → `SetTimer(prefix_timeout)` if not live (let the timer dispatch: partials lag VAD by 200–500 ms and "chrome" may still be in flight); else apply the **text-less pause rule** if it matches; else Auto: `SetTimer(stt_final)` and, if `last_partial_eager` and `stt.eager_commit`, `SetTimer(eager_commit)`; Manual: `SetTimer(manual_end)`. `SttFinal(text)`: `last_partial = None`, `last_partial_eager = False`, cancel `forced_end`; let `s` = §9.1–2 of `text`; if `s` is empty and `pending_prefix` is set → normal end path with text = `pending_prefix`, `confidence="high"`; else if `s` is empty → outcome (b)/(c) directly (never a prefix); else if `vad_raw_active` (above threshold right now, hangover excluded) and `s` has ≤1 word → `pending_prefix = (pending_prefix + " " + s) if pending_prefix else s`, `SetTimer(prefix_timeout)`, stay (user resumed within one RTT of `turn.end`); else normal end path with text = `pending_prefix + " " + s` if set else `text`. `SttFinalizeRejected` → cancel `forced_end`, log, `release_deferred = True`, `SetTimer(release_cap)` (never re-send `finalize` synchronously: a speaker below the VAD threshold would ping-pong at RTT pace; the `VadSpeechEnd` handler or the 1.5 s cap re-sends it). `SttError`/`SttClosed` → `AbortStt`, `ERROR` "Lost connection, say that again" (no mid-utterance reconnect).
- **`PROCESSING`** (run §9): (a) **interrupt** → `SendClose` unless `close_sent`; if `in_flight_cmd` → abort path with `spoken_text`; `PlayEarcon(cancel)` only if this is an always-interrupt or an `AbortCommand` was issued; if `barge_in` and nothing in flight (the command finished meanwhile) → drop; `PASSIVE`. (b) **remnant-only / empty**, `source == wake`, `not close_sent`: if `speech_ms is None` (already counted, or no `VadSpeechEnd` yet — the rule will run when it arrives) → log; else count now (same resets as the text-less pause rule). Then `SetCloudGate(True)`, `StartForwarding(None)`, → `LISTENING` (`max_utterance` keeps its original deadline; `SetTimer(no_speech)` unless `vad_active`, re-arming it if already live; `StartForwarding` is idempotent) on the **same socket** (Auto sockets are multi-turn; Manual accepts repeated `finalize`). Bounded by the original `max_utterance`. (c) **dropped** (empty with `close_sent`, PTT empty, blocklist, length filter) → `SendClose` unless `close_sent`; wake: silent `PASSIVE`; PTT: `Toast("Didn't catch that")`, `PASSIVE`. (d) **command** → `SendClose` unless `close_sent` (teardown in the background), `ShowTranscript(text, true)`; if `in_flight_cmd` → abort path first (queues behind if no hook); assign `cmd_id`, `Dispatch`, `SetTimer(command)`, `CancelTimer(watchdog)`, `ShowState(EXECUTING)`, `SetTimer(executing_spinner)`. `SttPartial(text, _)` in `PROCESSING` → `last_partial = text`, `ShowTranscript(§9.1–2 of text, false)`, arms nothing (keeps `forced_end`'s fallback text fresh). `SttFinal(text)` in `PROCESSING` → cancel `forced_end`; `s` = §9.1–2 of `text`; normal end path with text = `pending_prefix + " " + s` if set else `text` (the ≤1-word prefix branch does not apply: forwarding has stopped). `SttFinalizeRejected`/non-permanent `SttError` in `PROCESSING` → `Log`; `forced_end` keeps running (the forwarder has stopped; re-sending `finalize` is pointless).
- **`EXECUTING`**: `CommandDone(cmd_id, result)` matching → `ShowState(FEEDBACK)`, `Toast(result[:80] or "Done")`, `SetTimer(feedback_min)`. `CommandFailed` matching → `ERROR` with a non-technical message. `Cancel`/tap/Toggle/Button → abort path (§4.5 decides stay vs `PASSIVE`). `WakeDetected(wake)` → wake rule with `barge_in=True`. **Local abort** (`WakeDetected("stop")`, sherpa engines only; in `EXECUTING`, in `PASSIVE` with `in_flight_cmd`, or in `WAKING`/`LISTENING` with `barge_in` and `in_flight_cmd`): abort path with `spoken_text="stop"`; with a hook → `AbortStt` if a session is open, `PlayEarcon(cancel)`, `Toast("stopped")`, `PASSIVE` (do not keep listening: any continuation would transcribe as "stop …" and be dispatched); without a hook → toast only, stay; without `in_flight_cmd` → ignore. If `wake.require_attention` is on, the local "stop" is gated by attention too (presenter narration "…and then it will stop" must not abort a demo command).
- **PTT entry** (`HotkeyDown`/`HotkeyToggle`/`ButtonPressed` per §5.1; `tap_decide` from `EXECUTING`): if `stt_disabled` → `Toast`, stay. Else `source = ptt`, `ptt_mode = hold` for `HotkeyDown`/`tap_decide`, `toggle` otherwise; `OpenStt(manual)` (utterance reset), `barge_in = True` if from `tap_decide`, `SetCloudGate(True)`, `StartForwarding(from)` where `from` = `hotkey_down_ts` from `tap_decide`, `detection_ts − preroll_ms` on a hand-off from `WAKING`/`LISTENING`/`PROCESSING` **when `source` was `wake`** (the user pressed the key because connect was slow; do not lose the words already spoken; the ring buffer holds ≈5 s, clamp to its oldest frame), else `None` (the Forwarder queues until connected), if `playback_active` → `StopPlayback`; `PlayEarcon(wake)` for toggle/palm entry and for a tap→toggle switch (hold is walkie-talkie; the glyph suffices; the earcon is in the forwarded stream, which is acceptable and guarded in §8), `SetTimer(watchdog)`, `SetTimer(connect)`, `SetTimer(max_utterance)`, `SetTimer(ptt_no_speech)` unless `vad_active`, `ShowState(PTT_ACTIVE)`. From `WAKING`/`LISTENING`/`PROCESSING` the hand-off plays no earcon of any kind (the user just heard the wake earcon and is mid-sentence); if that hand-off is a `HotkeyToggle` (Electron) and `not vad_active`, arm `ptt_auto_end` instead of `ptt_no_speech` (no `VadSpeechEnd` will come for speech that already ended). A pynput tap is still `hold` at entry: the §8 `HotkeyUp` switch row arms `ptt_no_speech`, and the toggle `SttPartial` row converts it to `ptt_auto_end` when the pre-roll's partials arrive. Key handling inside `PTT_ACTIVE` is the §8 sub-table.
- **Global**: `Cancel` from any active state → `AbortStt` if a session is open; then in `EXECUTING` → abort path (§4.5 decides stay vs `PASSIVE`); in the other four → abort path if `in_flight_cmd`, `PlayEarcon(cancel)`, `PASSIVE`. `Cancel` in `PASSIVE` with `in_flight_cmd` → abort path, stay. `Mute`/`MuteHotkey`/`ButtonLongPress` → `AbortStt`, `CloseCapture`, `muted_reason = user`, `MUTED`. `Unmute`/`MuteHotkey` in `MUTED` → `OpenCapture`, `ResetWake`, `PASSIVE`. `AppFocused` in `MUTED` with `muted_reason == permission` → `OpenCapture` retry. `CaptureFailed` anywhere → `AbortStt`, `muted_reason = permission`, `MUTED`, permission toast. `DeviceChanged` with a session open → `AbortStt`, `ERROR` "mic changed, say that again"; otherwise `device_swap_until = now + skip_after_device_swap_ms`. `SttError(permanent=True)` anywhere → `stt_disabled=True`, `AbortStt`, `ERROR` toast once ("Cartesia key rejected — check CARTESIA_API_KEY"), then `error_clear` → `PASSIVE`; wake/VAD keep running; cleared only on restart. `SttClosed` in `PROCESSING` before a `Final` → as `forced_end` firing. **Playback**: `PlaybackStarted(kind, text, play_id)` → add `play_id` to `live_playbacks` (`playback_active = bool(live_playbacks)`); if `kind == earcon`, or `kind == tts` and `text` contains a detector keyword → `CancelTimer(wake_gate_tail)`, `SetWakeEnabled(False)`, `wake_gated_until = +inf`, `gating_play_id = play_id`, `SetTimer(gate_cap)`. `PlaybackStopped(play_id)` → remove from `live_playbacks`; if `play_id == gating_play_id` → `gating_play_id = None`, `CancelTimer(gate_cap)`, `SetTimer(wake_gate_tail)`. `gate_cap` fire → as `wake_gate_tail` fire (a lost `PlaybackStopped` must not leave wake dead). "Inside a wake-gated window" in the Wake rule = `ts ≤ wake_gated_until`. **Probe**: `ProbeResult(ok=False, 401|403)` → `stt_disabled=True` + key toast; `429` → busy toast; other → network toast. `watchdog` → `AbortStt`, `PASSIVE`, log. `Shutdown` → `CloseCapture`, `SendClose`, cancel all timers; ≤2 s.

### 5.3 Interrupt words (cloud path)

After §9 steps 1–2, a transcript matching `^((cancel|never ?mind|forget it)[,. ]*){1,3}(that|it)?$` (case-insensitive, trailing punctuation ignored; panicked repetition "cancel cancel" counts) **always** aborts the current flow and is never forwarded. A transcript matching `^(stop[,. ]*){1,3}(it|that)?$` is an interrupt **only if** `in_flight_cmd` is set (a command is running, including when this utterance arrived as a barge-in): then the abort path with `spoken_text` so the command layer's cancel hook can stop its own action. If it arrived as a barge-in but the command has since finished → dropped (not forwarded as a command). With nothing in flight and no barge-in, `stop` / `stop the video` are forwarded as normal commands. Note: voice "cancel" cannot click a Cancel button in the demo; say so in the README. Esc cancels only while the overlay/app window has focus (the command layer often focuses other apps, so the hotkey tap is the reliable abort).

### 5.4 Happy-path trace (wake mode, Auto endpoint, one breath; the t=1.60 `eager_commit` line applies only when `stt.eager_commit: true` — M0 tests this trace with the flag off, i.e. without that line)

```
t=0.00  WakeDetected(wake, ts=0)       → PlayEarcon(wake) ShowState(WAKING) OpenStt(auto) [utterance reset; gen=1, session=1] SetTimer(watchdog,75) SetTimer(connect,5)
t=0.26  SttConnected                   → SetCloudGate(T) StartForwarding(from=-0.5) ShowState(LISTENING) SetTimer(max_utterance,15)
                                          # vad_active is True (one breath) → no_speech NOT armed
t=0.50  SttSpeechStart                 → (no no_speech live → log)
t=0.90  SttPartial("sia open", F)      → last_partial; ShowTranscript("open", false)        # displayed stripped
t=1.30  VadSpeechEnd(speech=1600ms)    → speech_ms=1600; last_partial strips to "open" (non-empty) → SetTimer(stt_final,1.9)
t=1.60  SttPartial("sia open chrome",T)→ last_partial_eager=T; not vad_active, strips non-empty → SetTimer(eager_commit,0.3)
t=1.80  SttFinal("sia open chrome")    → last_partial=None; vad_raw_active=F → CancelTimer(eager_commit, stt_final) → normal end path: SetCloudGate(F) StopForwarding ShowState(PROCESSING)
t=1.80  §9 → "open chrome"             → (d): SendClose ShowTranscript("open chrome", true) Dispatch(cmd_1) SetTimer(command,30,cmd_1) CancelTimer(watchdog) ShowState(EXECUTING) SetTimer(executing_spinner,0.4)
t=2.15  CommandDone(cmd_1,"Opened Chrome") → CancelTimer(command, executing_spinner) ShowState(FEEDBACK) Toast("Opened Chrome") SetTimer(feedback_min,0.7)
t=2.85  TimerFired(feedback_min)       → ShowState(PASSIVE)   # gen=2
```

### 5.5 Other traces

```
# A. turn.end never arrives
... LISTENING, VadSpeechEnd at t=1.3 → SetTimer(stt_final,1.9)
t=3.20  TimerFired(stt_final) → forced end: SetCloudGate(F) StopForwarding SendClose close_sent=T → PROCESSING SetTimer(forced_end,1)
t=3.50  SttFinal("open chrome") → CancelTimer(forced_end) → normal end path, confidence="high"
   -or-
t=4.20  TimerFired(forced_end) → §9 on last_partial "open chro", confidence="low" → dispatch_low_confidence decides (ptt_only: Toast("Heard 'open chro' — try again with '<phrase>'"), (c) PASSIVE; always: (d))

# B. pause after the wake phrase, server never emits a Final for the fragment
t=0.26  LISTENING; pre-roll contains "…sia"; user is silent
t=0.80  VadSpeechEnd(speech=900) → last_partial None → text-less pause rule: remnant_turns=1, speech_ms=None, SetTimer(no_speech,6); max_utterance untouched; keep forwarding
t=1.10  SttSpeechStart (server saw "sia") → no_speech re-armed, not cancelled
t=3.10  VadSpeechStart → CancelTimer(no_speech) … user says "open chrome" … VadSpeechEnd → rule does not apply (last_partial "open chrome") → SetTimer(stt_final) → SttFinal → normal end path
   # If the server emits SttFinal("sia") at t≈2.3 → last_partial=None → s="" → (b): speech_ms is None → already counted → StartForwarding(None) → LISTENING re-entry
   # If partials lag and "open chrome" arrives as SttPartial while not vad_active → lag-corrective arm: cancel no_speech, SetTimer(stt_final)
   # A cough at t=5.0 (2nd text-less VadSpeechEnd) → rule applies again (no cap): re-arm no_speech; bounded by max_utterance at t=15.26

# C. hold-to-talk (Manual)
t=0.00  HotkeyDown(ts=0)   → OpenStt(manual) [reset] SetCloudGate(T) StartForwarding(None) SetTimer(watchdog) SetTimer(connect,5) SetTimer(max_utterance,60) SetTimer(ptt_no_speech,8) ShowState(PTT_ACTIVE)   # frames queue in RAM
t=0.22  SttConnected       → CancelTimer(connect); Forwarder flushes the queue, continues live
t=0.40  VadSpeechStart     → CancelTimer(ptt_no_speech) … user says "scroll down" (speech ends ≈1.50)
t=2.10  VadSpeechEnd(1100) → posted after the 600 ms hangover; speech_ms=1100; last_vad_end_ts=2.1; SetTimer(hold_silence,6)
t=2.30  HotkeyUp(ts=2.3)   → CancelTimer(hold_silence); held 2300 ms > tap_max → SetTimer(release_grace, max(0, 0.4−0.2)=0.2)
t=2.50  TimerFired(release_grace) → not vad_active → soft end: SendFinalize SetTimer(forced_end,1); stay PTT_ACTIVE, forwarding continues
t=2.85  SttFinal("scroll down") → CancelTimer(forced_end) → normal end path → (d): SendClose Dispatch(cmd_2) → EXECUTING …
   # Variant: HotkeyUp while still speaking → release_grace fires with vad_active → release_deferred=T SetTimer(release_cap,1.5); VadSpeechEnd → soft end (or at the cap)

# D. abort tap during a long command
t=0.00  EXECUTING(cmd_3); HotkeyDown → SetTimer(tap_decide,0.25)
t=0.12  HotkeyUp → CancelTimer(tap_decide); abort path:
          abort_supported=True  → AbortCommand(cmd_3) in_flight_cmd=None CancelTimer(command) PlayEarcon(cancel) → PASSIVE; later CommandFailed(cmd_3,"aborted") → unmatched → log only
          abort_supported=False → Toast("Can't stop that one"), stay EXECUTING, no earcon; cmd_3 finishes → CommandDone → FEEDBACK as usual
   -or-
t=0.25  TimerFired(tap_decide) → PTT_ACTIVE(hold, barge_in) with StartForwarding(from=0.0) while cmd_3 keeps running
          … user says "stop", HotkeyUp → release_grace → soft end (SendFinalize) → SttFinal("stop") → §9 → (a): in_flight_cmd set → abort path (AbortCommand(cmd_3,"stop") delivered directly to the hook) → PASSIVE
          … or user says "open slack" → (d): abort path first (no hook → queues behind cmd_3), Dispatch(cmd_4) → EXECUTING
```

---

## 6. Wake word, local VAD, multimodal hooks (all local, no network)

Cartesia has **no wake-word or keyword-spotting API** (Appendix A). Detection is local.

### 6.1 Engine choice (decide in M0, timebox 45 min; run the false-accept test on a WAV faster than real time)

1. **Try sherpa-onnx keyword spotting first.** Open-vocabulary, no training. Python: `pip install sherpa-onnx`; model `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (English). Generate the keyword file from plain text with `sherpa-onnx-cli text2token --tokens tokens.txt --tokens-type bpe --bpe-model bpe.model keywords_raw.txt keywords.txt`; each output line is BPE pieces plus optional `:boost` and `#threshold` with no space before the number (e.g. `▁HE LL O ▁WORLD :1.5 #0.35`; the pieces for "cartesia" come from the BPE model, do not hand-write them). Put respellings in `keywords_raw.txt`: `hey cartesia`, `hey car tee zha`, `hey car tee zee uh`, `hey kartesia`; plus, when `wake.local_stop_keyword` is on, a separate line `stop` with a **higher** threshold (`#0.5`) since it is one short common word. If "stop" shares BPE pieces with the respellings, raise `num_trailing_blanks` (default 1; docs suggest up to 8 for overlapping keywords). API: `kws = sherpa_onnx.KeywordSpotter(tokens=, encoder=, decoder=, joiner=, keywords_file=, keywords_score=1.0, keywords_threshold=0.25, num_trailing_blanks=1, num_threads=1, provider="cpu")`; `s = kws.create_stream()`; `s.accept_waveform(16000, frame_float32)` where `frame_float32 = int16 / 32768.0` (any length is fine); `while kws.is_ready(s): kws.decode_stream(s)`; `r = kws.get_result(s)` (returns the keyword text, no score); **`kws.reset_stream(s)` after every hit**. Node: `sherpa_onnx.createKws({modelConfig:{transducer:{encoder,decoder,joiner}, tokens}, keywords: "<tokenized lines as one string>"})`, `stream.acceptWaveform(16000, Float32Array)`. Accept the engine if ≥8/10 normal utterances at 1 m fire and a 10-minute podcast WAV yields 0 wake false fires (count "stop" fires separately; ≤2 is acceptable because it is gated by `in_flight_cmd`). Then `<<WAKE_PHRASE>>` works on day one.
2. **Else openWakeWord-format ONNX** with the bundled pretrained `hey_jarvis` model (CC BY-NC-SA, fine for a demo) via `onnxruntime` (`inference_framework="onnx"`; the default `"tflite"` needs `ai-edge-litert`, which openWakeWord installs on macOS/Linux, and falls back to onnx automatically). Frames must be multiples of 1280 samples; `vad_threshold=0.5`; detection threshold 0.5. **Set `wake.phrase: "hey jarvis"`** so the remnant regex, keyterms, logs, and smoke test match what the model actually detects. The local "stop" keyword is unavailable on this path (cloud "stop" still works). A teammate trains the custom `<<WAKE_PHRASE>>` model in parallel (M3a) with `livekit-wakeword` (Apache-2.0, openWakeWord-compatible) or the patched `alfiedennen/openwakeword-colab-2026` notebook (the official notebook is broken on current Python/torch).

Not allowed: Picovoice Porcupine (free tier ended 2026-06-30, paid key required), Snowboy (dead), continuous cloud STT as a wake detector (streams every word in the room; ~2.6M credits/month).

### 6.2 Detection behavior (mandatory)

- Fires 80–240 ms after the phrase ends; pre-roll (`preroll_ms` 500) compensates, and §9 strips the remnant.
- Refractory `wake.refractory_s` (1.0 s: it only absorbs the detector's own double fire; state gating ignores wakes in `WAKING`/`LISTENING`); keep feeding frames during it (pausing re-triggers on buffered audio).
- Earcon gating (rules in §5.2 Global "Playback"): `SetWakeEnabled(False)` on `PlaybackStarted(earcon)`; `wake_gate_tail` (200 ms, unstamped) after `PlaybackStopped`, then `SetWakeEnabled(True)` + `ResetWake`. Also drop any detection whose ts falls inside a gated window (`wake_gated_until`). TTS: gated only if its text contains a detector keyword (§5.1).
- Skip detections until `device_swap_until` after a device swap.
- Log every detection (phrase, ts, state, outcome) to a rotating local log. Never log audio by default.
- Detector crash or missing model → `Toast`; PTT keeps working; app never exits.

### 6.3 Local VAD (required; drives timers and filters, never gates the cloud)

Silero VAD via onnxruntime on the inference thread. The model requires exactly **512-sample** chunks at 16 kHz and is stateful: keep its `state` (shape `(2, 1, 128)`) and the 64-sample context from the previous chunk across calls; reset both on utterance boundaries. Re-block the 1280-sample frames into 512s (1280 = 2×512 + 256 carried into the next frame). Per 1280-frame prob = max over its 512 chunks. `VadSpeechStart` when prob > `vad.threshold` (0.5) for 2 consecutive frames; `VadSpeechEnd(speech_ms)` when prob < threshold for `vad.hangover_ms` (600) after a start, where `speech_ms` = start → last frame above threshold (hangover excluded). Expose `is_active` (incl. hangover) and `raw_active` (this frame above threshold); the runtime mirrors both into ctx on every frame. If Silero fails to load, fall back to RMS energy (−35 dBFS, same hysteresis) and warn.

### 6.4 Multimodal hooks

The app tracks head and palms. Define the events now so the tracking code can post them: `AttentionHint(facing_screen)` and `GestureHint(palm_raised)`. If §3.6 shows a palm signal already exists, wire `ptt.palm_toggle` in M2a (palm raised for `ptt.palm_dwell_ms` = `HotkeyToggle`, edge-triggered per §4.5; it is the app's thesis and ~20 lines). If §3.6 shows a facing-screen signal, wire `wake.require_attention` in M2a as well (the rule is already in §5.2; ~20 lines) but keep its default **off** until venue false accepts justify it.

---

## 7. Audio pipeline

- **One capture stream.** Attach with one line at the top of the existing callback: `voice_tap.push(indata, ts)`. Do not change the existing stream's rate/blocksize/dtype. Inside `push` (sub-millisecond, allowed in the callback): downmix by averaging, cast to int16, `soxr.ResampleStream.resample_chunk` to 16 kHz, re-block to 1280 samples, `ring.append(frame)` (under the ring lock; §4.5), `queue.put_nowait(frame)`. If no capture exists, create `sounddevice.InputStream(device=<preferred>, samplerate=None, channels=1, dtype='int16', blocksize=0, callback=...)` (`None` = device default rate) with the same tap; `audio.preferred_input: default_unless_hfp` keeps the system default (a USB/lavalier stage mic) unless that default is a Bluetooth HFP headset mic (8/16 kHz, halves wake recall), in which case it picks the built-in mic. Never resample by dropping samples.
- **Ring buffer.** `ceil((stt.connect_timeout_s + wake.preroll_ms/1000 + 0.5) / 0.08)` frames (= 63 frames ≈ 5 s with defaults), a `deque(maxlen=…)` under a lock (lock-free not required). RAM only, zeroed on `CloseCapture`. Only reader: the Forwarder. Sized so the pre-roll survives the worst-case connect.
- **Device changes / zero input.** Sequence: 2 s of exactly-zero samples or a stream error → `DeviceChanged`, close and reopen the *default* (or preferred) device (PortAudio's device list is stale after hot-plug; Electron: `navigator.mediaDevices.ondevicechange`). Still zero after 3 s cumulative → `CaptureFailed(permission)`. Reopen attempts back off 1/2/4 s with one toast, not a loop.
- **Permissions (macOS TCC).** Mic permission attaches to the *host process* (Terminal/iTerm/VS Code for a Python script; `Electron` in dev). Toast "Microphone permission needed for <host app>" with deep link `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`; re-check on `AppFocused`. README: `tccutil reset Microphone <bundle-id>` for stuck prompts; packaged apps need `NSMicrophoneUsageDescription` + `com.apple.security.device.audio-input`.
- **Mute** = `stream.close()` (discards pending buffers; `abort()` first is harmless) so the OS mic indicator disappears within 100 ms. Mute is reachable three ways, none depending on pynput: mute hotkey, mic-button long-press/right-click (`ButtonLongPress`), and the tooltip toggle.
- **Earcons** play from a persistent, pre-opened output stream with preloaded buffers; a cold `sd.play()` costs 50–200 ms and misses the 50 ms target. Reopen the output stream on an output-device change (projector HDMI steals the default) or write error; an earcon failure is logged, never raised.
- **Self-test at startup** (`voice selftest`): run 1 s of captured audio from the actual device through the tap and assert 16000 ± 1 % output samples/s; log the device name, native rate, and peak dBFS, and warn if peak < −45 dBFS (a quiet stage interface kills wake recall silently); with `debug.dump_outgoing_pcm` write 3 s of outgoing PCM to `dump.raw`, checkable with `ffplay -f s16le -ar 16000 -ac 1 dump.raw`. Wrong rate is **not** rejected by Cartesia; you would get silent garbage. Also pre-resolve `api.cartesia.ai` DNS at startup and every 5 min.

---

## 8. Explicit mode

All explicit modes use the **Manual** endpoint (`finalize` on end). Wake mode uses **Auto** unless `stt.wake_endpoint: manual`.

**Key handling inside `PTT_ACTIVE`:**

| Input | `ptt_mode=hold` | `ptt_mode=toggle` |
|---|---|---|
| `HotkeyDown` (non-repeat; the adapter suppresses OS repeat) | lost-`HotkeyUp` recovery → soft end; the following `HotkeyUp` is ignored | second press → soft end; the following `HotkeyUp` is ignored |
| `HotkeyUp` | if `forced_end` is live or `release_deferred` → ignore (this is the Up that follows a recovery/second-press Down); else cancel `hold_silence`; held < `tap_max_ms` and not `barge_in` → switch to `toggle` (`PlayEarcon(wake)`; keep listening; `SetTimer(ptt_no_speech)` unless `vad_active`); otherwise → `SetTimer(release_grace)` (`barge_in` taps are normally unreachable because `tap_decide` already fired; if one arrives, treat as a release) | ignore |
| `HotkeyToggle` / `ButtonPressed` | soft end | same |
| `VadSpeechEnd` | `speech_ms = …`, `last_vad_end_ts`; if `release_deferred` → cancel `release_cap`, clear the flag, soft end (do not arm `hold_silence`); else `SetTimer(hold_silence)` | if `release_deferred` → cancel `release_cap`, clear, soft end; else if `last_partial` is `None`/strips empty **and** `speech_ms < 250` → earcon/click blip: log, `SetTimer(ptt_no_speech)` unless `vad_active`; else `SetTimer(ptt_auto_end)` |
| `VadSpeechStart` | cancel `hold_silence`, `ptt_no_speech` | cancel `ptt_auto_end`, `ptt_no_speech` |
| `SttFinalizeRejected` | cancel `forced_end`, log, `release_deferred = True`, `SetTimer(release_cap)` (never re-send synchronously; the `VadSpeechEnd` row or the cap re-sends) | same |
| `SttFinal` | `CancelTimer(forced_end)`, normal end path | same |
| `SttConnected` | `CancelTimer(connect)`; if `forced_end` is live (a soft end was issued before connect) → `SetTimer(forced_end)` afresh so its countdown starts now; log (Forwarder flushes its queue) | same |
| `SttPartial(text, eager)` | `last_partial = text`, `last_partial_eager = False` (Manual never sets eager), `ShowTranscript(§9.1–2 of text, false)`; if the stripped text is non-empty and `ptt_no_speech` is live → `CancelTimer(ptt_no_speech)` (a quiet speaker below the VAD threshold must not be cut off); arms nothing else | same, plus: if `ptt_no_speech` was live and `not vad_active` → `SetTimer(ptt_auto_end)` |
| `SttSpeechStart` / `SttTurnResume` | `Log` (Manual does not emit them) | same |

A soft end leaves the state `PTT_ACTIVE` with `cloud_gate` on and forwarding running until `SttFinal` or `forced_end` (needed so a rejected early `finalize` can be re-sent).

- **Hold** (Python/pynput only): `HotkeyDown` → PTT entry (§5.2). Release → `release_grace`; if the user is still speaking at that moment, `finalize` is deferred to `VadSpeechEnd` (cap `release_speech_cap_s` 1.5) because a mid-speech `finalize` produces transcription errors.
- **Toggle** (Electron `globalShortcut` is key-down only; pynput tap; mic button; palm from `PASSIVE` only): first press starts; ends on second press, `ptt_auto_end` (400 ms after `VadSpeechEnd`; the VAD hangover already supplies 600 ms), or `max_utterance` (60 s). Both modes end on `ptt_no_speech` (8 s with no speech → "Didn't catch that"; prevents an accidental tap or a silent hold with a lost key-up from streaming 60 s of billed silence).
- **Wake on Manual** (fallback flag) reuses `manual_end` (150 ms after `VadSpeechEnd`).
- pynput cannot swallow the chord: `<<HOTKEY>>` still reaches the focused app. `ctrl+shift+space` is fine on macOS (VS Code binds ⌘⇧Space there); on Windows/Linux VS Code binds it, so pick another chord there. Avoid `ctrl+alt+space` (macOS input-source switch). Document whichever you ship. pynput needs Accessibility (and often Input Monitoring) for the host app on macOS and does **not** prompt: check `listener.IS_TRUSTED`; if false, show setup instructions once and fall back to the on-screen button. macOS Secure Input (a password field focused) silently eats global key events; document it and keep the button. `globalShortcut.register` returning false → toast "shortcut taken by another app".
- Mute/panic hotkey `ptt.mute_hotkey` (`ctrl+shift+m`) → `MuteHotkey` (edge-triggered, 500 ms debounce). Same pass-through caveat: it is VS Code's Problems toggle; pick another if VS Code is on stage.
- PTT bypasses wake, refractory, and `no_speech`; it obeys `max_utterance` (60 s), `watchdog`, cancel, and the cloud dot.

---

## 9. Transcript post-processing → `CommandEvent`

Order matters. Never act on partials; the eager commit (§5.0) is this prompt's own judgment, not a Cartesia recommendation, and runs only after local speech end.

1. Normalize whitespace; strip surrounding punctuation.
2. **Strip the wake phrase.** Full-phrase pattern built from `wake.phrase`, e.g. `hey[,.!?;:—–-]?\s+cartesia[,.!?;:—–-]?\s*` (`IGNORECASE`; the punctuation class must include dashes and colons: "Hey Cartesia—open chrome"). If it occurs anywhere, keep only the text after its **last** occurrence (handles "sia open chrome hey cartesia open chrome" when the user did not hear the earcon); if that leaves nothing, fall back to the text before it. Then strip a leading remnant: `^(hey[,.!?;:—–-]?\s+)?(cartesia|artesia|rtesia|tesia|esia|sia)[,.!?;:—–-]?(\s+|$)` (full phrase, each word, every trailing substring ≥3 chars of the last word). No fuzzy matching (it would strip "cartesian"); instead `wake.remnant_aliases` (default empty) lists exact real-word mishearings observed in M2a logs ("Asia", "see ya") to add to the leading-remnant alternatives. A transcript that is entirely remnant becomes empty → §5.2 outcome (b)/(c). The first `stt.keyterms` entry is always the title-cased last word of `wake.phrase`, inserted at startup, so the remnant comes back spelled consistently.
3. **Interrupt check** (§5.3) → abort path or drop; never dispatched.
4. **Drop filter**: empty; or exact match in `hallucination_blocklist`; or a bracketed non-speech tag (`^\[.*\]$`, `^\(.*\)$`: "[Applause]", "(laughter)"); or (< 2 words **and** `ctx.speech_ms` is set **and** `speech_ms` < 150). If `speech_ms` is `None` (no VAD end observed), never drop on length.
5. **Dictation prefix**: `^(type|write|dictate)\s+(.+)$` → `kind="dictation"`, `text=` the remainder; else `kind="command"`.
6. **Confidence**: `high` from `Final`, eager commit, or prefix dispatch; `low` from a forced partial. `voice.dispatch_low_confidence: ptt_only|always|never`. Default `always` if §3.4 found an LLM-backed command layer (it can handle "open chro"; a silent drop after 3 s of pulsing is the worse demo outcome), else `ptt_only`: a low-confidence wake result shows `Toast("Heard '<text>' — try again with '<wake.phrase>'")` (a statement, not a question; there is no follow-up window) and is dropped; PTT dispatches because the user is waiting. The command layer decides whether to confirm. Do not build a yes/no voice dialog.
7. Emit `CommandEvent(cmd_id, text, kind ∈ {command, dictation}, source="wake"|"ptt", confidence, utterance_gen, session_id, request_id, t_wake, t_speech_end, t_final)`. Interrupts never become a `CommandEvent`; they travel as `AbortCommand(cmd_id, spoken_text)`. No text-based debounce (refractory already prevents double triggers; "scroll down, scroll down" is legitimate).

---

## 10. Feedback and UX

- **Earcons** (bundled WAVs, ≤150 ms, non-speech so they cannot retrigger wake): `wake`, `cancel`. Errors are toasts only. Play `wake` within 50 ms of `WakeDetected` from the pre-opened output stream.
- **Indicator** glyph per state (§5.1). `WAKING` and `LISTENING` render identically. `EXECUTING` shows the understood text immediately and the "working…" label only after 400 ms, so a fast command goes text → toast without flicker. The label persists while `snapshot().in_flight` is set even if the state is `PASSIVE` (a barge-in that ended in a drop must not hide a still-running command). A separate **red cloud dot** is on for the entire time any audio byte leaves the machine. Do not rely on the OS orange mic dot. First-run copy: "The mic is open locally for the wake word; nothing leaves this computer until the red dot appears."
- **Transcript line**: partials grey (displayed after §9.1–2 stripping so the projector never shows "sia open"), final white, max 2 lines, auto-hide 3 s after `FEEDBACK`. Clicking it cancels. Indicator and toasts must be always-on-top (§3.5) because the command layer focuses other apps.
- No-speech timeout fades out silently. PTT with empty result → "Didn't catch that" once.
- Tooltip shows hotkey, mute hotkey, mute toggle. Snooze timers are Later.
- Spoken "Yes?" (Appendix A.6) is **Later**; the earcon is faster.

---

## 11. Hard rules: privacy, security, cost

1. **Zero audio bytes to the cloud in `PASSIVE`, `WAKING`, `PROCESSING`, `EXECUTING`, `FEEDBACK`, `ERROR`, `MUTED`.** `cloud_gate` is checked at the single binary-write site; it governs binary frames only (text/JSON control frames `close`/`finalize`/`config` are always allowed so sockets can be torn down). Queued-but-unsent frames in `PTT_ACTIVE` before `SttConnected` are not sends. Test: mock socket, assert zero binary sends in those states.
2. Mute closes capture at the OS level, zeroes the ring buffer, stops inference.
3. Pre-roll is RAM only. Audio never hits disk in this version (recording is Later).
4. Logs: state transitions, latencies, `request_id`s. Raw transcripts only at DEBUG, never in crash reports.
5. API key via the app's secret mechanism; never in git, logs, or the Electron renderer. Refuse `ws://`.
6. The command layer receives `CommandEvent` only, never raw socket messages.
7. Sockets are per utterance (a remnant pause may extend one). Assert no socket outlives its utterance by > 2 s (idle sockets count against the concurrency limit; silence is billed).

---

## 12. Configuration

```yaml
voice:
  enabled: true
  dispatch_low_confidence: "ptt_only"   # ptt_only | always | never; set to always if §3.4 found an LLM-backed command layer
  audio: { preferred_input: "default_unless_hfp", frame_queue_max: 25 }  # preferred_input: default_unless_hfp | builtin | default; only used when this module creates the stream
  wake:
    engine: "sherpa_kws"            # sherpa_kws | openwakeword
    phrase: "<<WAKE_PHRASE>>"       # MUST match what the model detects ("hey jarvis" on the placeholder path)
    model_dir: "models/wake/"
    keywords_file: "models/wake/keywords.txt"   # sherpa_kws only; generated by text2token
    threshold: 0.5                  # openwakeword; sherpa thresholds live in the keywords file / API (0.25 default, 0.5 for "stop")
    vad_threshold: 0.5              # openwakeword only
    refractory_s: 1.0               # only absorbs the detector's own double fire; state gating handles the rest
    preroll_ms: 500
    playback_gate_tail_ms: 200
    gate_cap_s: { earcon: 1, tts: 30 }   # backstop if PlaybackStopped never arrives
    skip_after_device_swap_ms: 500
    local_stop_keyword: true        # sherpa_kws only
    remnant_aliases: []             # exact real-word mishearings of the remnant, from M2a logs
    require_attention: false        # Later
    attention_window_ms: 1500
  vad: { threshold: 0.5, hangover_ms: 600 }
  stt:
    model: "ink-2"
    wake_endpoint: "auto"           # auto | manual (M2b measurement step)
    eager_commit: false             # M2b flips to true if the auto+eager column measures faster without truncation
    eager_commit_ms: 300
    prefix_timeout_ms: 1000
    auto_forced_end: "close"        # close | pad_then_close (M2b verifies whether close flushes a trailing turn.end)
    manual_end_silence_ms: 150
    sample_rate: 16000
    chunk_ms: 100
    keyterms: ["open", "close", "scroll", "click", "type", "Chrome", "Slack"]   # last word of wake.phrase is prepended at startup
    turn: { start_threshold: 0.7, eager_end_threshold: 0.6, end_threshold: 0.4, end_timeout_ms: 1500 }   # M2b may raise end_timeout to 2000
    connect_timeout_s: 4            # outer deadline for open(); attempt 1 up to 3.0 s; attempt 2 only if attempt 1 failed fast (<1 s) and gets the remaining budget. Machine backstop timer = this + 1
    connect_attempts: 2
  timers:
    no_speech_s: 6
    max_utterance_s: 15
    max_utterance_ptt_s: 60
    # stt_final_s is derived: turn.end_timeout_ms/1000 + 1.0 - vad.hangover_ms/1000  (= 1.9)
    forced_end_wait_s: 1
    command_s: 30                   # derived at startup: max(30, 2 × worst-case duration from DISCOVERY §3.4); ≥ 60 if the command layer shows its own confirm dialogs
    spinner_delay_ms: 400
    feedback_min_ms: 700
    error_clear_s: 3
    watchdog_s: 75                  # > max_utterance_ptt_s + forced_end_wait_s; cancelled on entering EXECUTING
  ptt:
    hotkey: "<<HOTKEY>>"
    mute_hotkey: "ctrl+shift+m"
    tap_max_ms: 250
    release_grace_ms: 400           # effective = max(0, 400 - ms since VadSpeechEnd); full 400 if no VadSpeechEnd yet
    release_speech_cap_s: 1.5       # hold released while still speaking: finalize at VadSpeechEnd or this cap
    hold_silence_s: 6               # hold with no release after speech ended = lost HotkeyUp (4 s thinking pauses are normal)
    auto_end_silence_ms: 400
    no_speech_s: 8
    mute_hotkey_debounce_ms: 500
    palm_toggle: false              # enable in M2a if §3.6 found a palm signal
    palm_dwell_ms: 1000
    palm_release_ms: 300
  interrupts: { always: "^((cancel|never ?mind|forget it)[,. ]*){1,3}(that|it)?$", in_flight_only: "^(stop[,. ]*){1,3}(it|that)?$" }
  hallucination_blocklist: ["thank you", "thanks for watching", "you", "bye", "um", "uh"]   # exact match; kept because it is 6 lines and zero risk
  debug: { dump_outgoing_pcm: false }
```

Environment: `CARTESIA_API_KEY` (required; checked at startup). The API version `2026-08-14` is a constant in code (the SDKs do not read an env var for it).

---

## 13. Edge-case checklist (tick each in your report; all are M1–M2b scope)

**Wake**
- [ ] Phrase + command in one breath → pre-roll + remnant strip → correct command; `no_speech` not armed because VAD was active.
- [ ] Phrase, 2 s pause, command → text-less pause rule (no server `Final` needed) → stays `LISTENING` → correct command; a late server `Final("sia")` is a no-op; a cough during the pause does not end the utterance.
- [ ] Phrase twice within 1 s → exactly one utterance; phrase 1.5 s after a fast "cancel" is accepted. Phrase repeated mid-utterance → text after the last occurrence.
- [ ] User resumes speaking as `turn.end` lands with ≤1 word → `pending_prefix`, joined to the next `Final`; a fast one-word command ("undo") with no resumption dispatches within `prefix_timeout_ms`, never dropped.
- [ ] Second wake utterance right after the first (smoke test 3 after 1) → utterance reset; no stale partial, no stale `barge_in`.
- [ ] Wake during `LISTENING`/`PTT_ACTIVE` ignored; during `EXECUTING` = barge-in; barge-in "stop" aborts the running command; non-interrupt barge-in aborts then dispatches (never two commands at once).
- [ ] Local "stop" keyword (sherpa path) aborts an in-flight command within ~300 ms with earcon + toast, including during a barge-in `LISTENING` (which it ends); ignored when nothing is in flight. Without an abort hook, every abort path says "Can't stop that one" and stays honest (no cancel earcon).
- [ ] App's own earcon at full volume 20× → 0 detections (gating + reset). TTS not containing the wake word leaves wake enabled.
- [ ] Missing model / detector crash → toast, PTT still works.

**Audio**
- [ ] Permission denied, no mic, all-zero input → reopen once, then `MUTED` with the permission toast; recovers on `AppFocused` after granting.
- [ ] The actual device's native rate (44.1 k/48 k, mono or stereo) produces 16000 ± 1 % samples/s (self-test).
- [ ] Default device changes mid-utterance → `ERROR` "mic changed", next wake works on the new device; reopen backs off, no toast spam.
- [ ] Mute hotkey and mic-button long-press → OS mic indicator off < 100 ms; ring buffer zeroed; in-flight STT aborted.
- [ ] Second app instance → voice module refuses to start (PID lock). Missing API key → toast at startup, wake/PTT show the key toast.

**Cartesia / network**
- [ ] 401/403 → one toast, `stt_disabled`, no retry loop; later wakes and PTT show the toast without connecting.
- [ ] 429 / other 4xx on connect → toast, not sticky, `PASSIVE`.
- [ ] 5xx/transport failure **on connect** → up to 2 attempts inside `open()` within `connect_timeout_s` (second only after a fast failure); mid-utterance drop → `ERROR`, no reconnect.
- [ ] Earcon ends and a `gen` bump follows within 200 ms (fast 429, Cancel, hand-off) → wake is still re-enabled (`wake_gate_tail` is unstamped). 20 back-to-back earcons → gated throughout, enabled 200 ms after the last. A lost `PlaybackStopped` → `gate_cap` re-enables wake. Non-gating TTS never leaves `playback_active` stuck.
- [ ] PTT utterance longer than 5 s does not trip the `connect` backstop (cancelled on `SttConnected`). A quiet speaker whose partials arrive without a VAD start is not cut off by `ptt_no_speech`.
- [ ] Wake phrase during the ≤1 s `PROCESSING` wait → old session aborted, new wake accepted with earcon.
- [ ] Connect takes 3.5 s → pre-roll still intact (ring buffer ≈5 s); backlog sent 1 s burst then 2× real time; transcript correct.
- [ ] `turn.end` withheld → `stt_final` → forced end → `Final` or low-confidence partial (trace A); wake-source low confidence asks instead of executing.
- [ ] `turn.eager_end` after local speech end → commit within 300 ms; the following `turn.end` is log-only (no double dispatch); `turn.resume` cancels the commit.
- [ ] Aborted wake session's `Closed`/`Error` never reaches the new PTT session (session_id filter).
- [ ] Auto cumulative vs Manual delta transcript builders both unit-tested with recorded sequences; Manual `Final` emitted once on `flush_done` and the builder resets.
- [ ] `finalize` while still speaking → `SttFinalizeRejected` cancels `forced_end`, re-sent after `VadSpeechEnd`. Hold released while still speaking → `finalize` deferred to `VadSpeechEnd` (cap 1.5 s).
- [ ] Socket closed after every utterance; `close` awaited ≤2 s in the background; `SttClosed` after our `close` is log-only (except in `PROCESSING` before a `Final`, §4.5).
- [ ] PTT shows live partials and a `forced_end` in PTT dispatches the last partial at low confidence (`SttPartial` is handled in `PTT_ACTIVE`, §8).

**Commands**
- [ ] `cancel`/`never mind`/`cancel that`/`cancel cancel` never reach the command layer as commands; `stop` with nothing in flight does; `stop` with a command in flight reaches the cancel hook directly via `AbortCommand(cmd_id, "stop")`, never through the executor.
- [ ] Manual wake session: `max_utterance` forced end followed by a remnant-only `Final` → (c) `PASSIVE`, not a (b) re-entry (socket closed within 2 s). Applause cycling the VAD during a false wake ends at the original 15 s deadline, never later.
- [ ] Red cloud dot is off in every state except `LISTENING`/`PTT_ACTIVE` (gate invariant; `pad_then_close` pad excepted), including after `ptt_no_speech`, `watchdog`, `Cancel`, and `DeviceChanged`.
- [ ] Startup probe: wrong key or no network is reported at launch, not at the first wake.
- [ ] Command layer raises → `ERROR` with non-technical message; voice keeps running. Command exceeds `command_s` → aborted (with a hook) or orphaned (without) with one toast.
- [ ] Command takes 10 s → text shown at once, "working…" after 400 ms; hotkey tap aborts (trace D); hotkey hold starts a PTT barge-in (pynput only); a stray `HotkeyUp` with no live `tap_decide` is a no-op; no premature success toast. `CommandDone` for an old `cmd_id` → log only; for the current one in any other state → toast only.
- [ ] `type hello world` → `kind="dictation"`, text `hello world`.
- [ ] One-word PTT command with no VAD end observed ("undo", quiet speaker) is **not** dropped. PTT (either mode) with no speech → "Didn't catch that" after 8 s, socket closed.
- [ ] No-hook abort tap stays in `EXECUTING` and does not spawn a phantom PTT (`tap_decide` cancelled). `stt.eager_commit: true` + "phrase … pause … command" still works (eager never commits a remnant-only partial).
- [ ] Lost `HotkeyUp` (Cmd+Tab mid-hold) → `hold_silence` ends the utterance after `hold_silence_s` (6 s) of silence; the next `HotkeyDown` is recovery, not key repeat. Holding the mute hotkey does not flap `MUTED`.
- [ ] Hotkey during `PROCESSING` is not dead (same as `LISTENING`); mic button during `WAKING`/`LISTENING` cancels.

**Concurrency**
- [ ] Mean wake+VAD inference < 4 ms per 1280-sample frame (≈5 % of one core), logged every 60 s, measured with tracking running.
- [ ] Stale timer (`stamp` mismatch) cannot act on a newer utterance; `watchdog`/`forced_end` survive `WAKING→LISTENING→PROCESSING`; `command` survives state changes and dies with its `cmd_id` (unit tests).
- [ ] Shutdown ≤ 2 s.

---

## 14. Tests and acceptance

**Unit (pure, no audio/network):**
- Table-driven `VoiceStateMachine` tests with a fake clock: every row of §5.0 and §5.1, every bullet of §5.2, every row of the §8 sub-table, all traces in §5.4–5.5, interrupt rules in §5.3, `gen`/`stamp` rules (incl. the unstamped `wake_gate_tail` and `gate_cap` surviving a `gen` bump), `session_id` filter, `cmd_id` guard, barge-in abort-then-dispatch, text-less pause rule with and without a server `Final`, lag-corrective arm, eager commit followed by `turn.end`, `pending_prefix` + `prefix_timeout`, utterance reset between consecutive utterances, abort path with and without `abort_supported` for every caller (tap, Cancel, (a), local stop, (d) barge-in, `command` timer), deferred release + `release_cap`, `hold_silence`, `ptt_no_speech` in hold mode, `SttFinalizeRejected` in `PROCESSING` (forced_end keeps running), text-less pause rule on a second text-less segment.
- Transcript builders: recorded Auto and Manual message sequences → expected events (verbatim delta concat; cumulative replace; single `Final` on `flush_done`; builder reset; `FinalizeRejected` classification; `TurnResume`).
- Post-processor with `phrase="hey cartesia"`: `"sia open chrome"`→`"open chrome"`, `"hey cartesia open chrome"`→`"open chrome"`, `"Hey, Cartesia, open chrome"`→`"open chrome"`, `"cartesia"`→`""`, `"cartesian coordinates"`→unchanged, `"sia open chrome hey cartesia open slack"`→`"open slack"`, `"open chrome hey cartesia"`→`"open chrome"`; with `phrase="hey jarvis"`: `"vis open chrome"`→`"open chrome"`. Blocklist exact match (`"say thank you"` survives), dictation prefix, interrupt classification with and without `in_flight_cmd` (incl. `cancel that`), `speech_ms=None` never drops, `dispatch_low_confidence` modes.
- `cloud_gate`: mocked socket, zero binary sends in every non-streaming state, including `PTT_ACTIVE` before `SttConnected` (queued, not sent).

**Integration (WAV fixtures through the real tap/VAD/wake pipeline faster than real time via the injectable clock; Cartesia replaced by a local WebSocket server replaying recorded messages):** required for "Done": `wake_plus_command_one_breath.wav`, `wake_pause_command.wav`, `silence_5s.wav`, `double_wake_1s_apart.wav`, and the 401-on-connect fault. Optional (M2b, if time): 3.5 s connect delay, `turn.end` withheld, `turn.eager_end` then `turn.resume`. Record fixtures with `sox -d -r 16000 -c 1 -b 16 name.wav trim 0 5`.

**Live smoke test** (README, real key, run before each demo; "the phrase" = configured `wake.phrase`):
1. Say "<phrase>, open chrome" in one breath → Chrome opens; transcript shows "open chrome".
2. Say "<phrase>", wait 2 s, say "open chrome" → Chrome opens.
3. Say "<phrase>", stay silent → indicator returns to dim within ~8 s; nothing dispatched; log shows `no_speech`.
4. Hold hotkey, "scroll down", release → executes. Release the key while still talking → still executes with the full sentence. Tap hotkey, "scroll up", wait → executes after ~1 s of silence. Tap hotkey, say nothing → "Didn't catch that" after 8 s.
5. Play the wake earcon 20× → 0 detections.
6. Say "<phrase>", then "cancel" → cancel earcon, nothing dispatched.
7. Start a slow command, say "<phrase>, stop" (or just "stop" on the sherpa path) → command aborted. Start a slow command, tap the hotkey → aborted.
8. Mute hotkey → OS mic dot disappears; wake does nothing; unmute restores.

**Latency (log one line per utterance; `voice debug latency` prints median and max over the session):**

| Metric | Target |
|---|---|
| `WakeDetected` → earcon start and indicator | < 50 ms |
| `WakeDetected` → first audio byte sent | < 800 ms (report median/max) |
| local speech end → `Final` or eager commit (Auto) | measure and report; expect 400–1000 ms |
| `Final` → `Dispatch` | < 50 ms |
| local "stop" keyword → `AbortCommand` | < 300 ms |
| hotkey tap abort → `AbortCommand` | < 300 ms (`tap_decide` bound) |
| mute → capture closed | < 100 ms |

**Done** = unit + integration tests pass locally; live smoke test passes on the dev machine; latency, inference-time, and false-accept counts recorded in `docs/voice/REPORT.md`; every §13 box ticked or marked deferred with a reason.

---

## 15. Milestones (ship in order; each is demoable) and the Later list

Rough budget for one owner: M0 4 h, M1 7 h, M2a 5 h, M2b 4 h (≈20 h; realistic only if M1 lands by hour ~11).

- **M0 — Discovery + skeleton (≤4 h).** `DISCOVERY.md`; interfaces, Events, Actions, Context (§4) including `session_id`/`stamp`/`cmd_id`; state machine with unit tests for the §5.4 trace and §5.3 (the §5.5 traces and remaining §5.1 rows' tests land with the code in M1/M2a); config; earcons on a pre-opened output stream; indicator idle state; PID lock + key presence check; wake-engine decision (§6.1, timeboxed, offline FA test). In parallel, a teammate starts custom-model training if the placeholder path was chosen (M3a).
- **M1 — Explicit mode (demo insurance).** AudioTap + resampler + self-test; `LocalVad`; Manual `SttSession` + transcript builder; hold/tap/toggle PTT + mic button + mute hotkey + long-press mute; `ptt_no_speech`; post-processor; `Dispatch`, single-worker executor, `cmd_id` guard, `EXECUTING`, `FEEDBACK`, abort tap; cloud dot; transcript line. Smoke tests 4, 7 (tap part), 8 pass.
- **M2a — Passive mode on the Manual session.** Wake engine + refractory + earcon gating; ring buffer + pre-roll; `wake_endpoint: manual` path (`manual_end`), text-less pause rule, `no_speech`/`max_utterance`/forced end; barge-in + `in_flight_cmd`; interrupt rules + local "stop"; `palm_toggle` and `require_attention` wiring if the signals exist (defaults off); `cloud_gate` test. Smoke tests 1–3, 5–7 pass. **"hey cartesia" is demoable here.**
- **M2b — Auto session + measurement.** Auto `SttSession`, `TurnResume`, `stt_final`, the `pending_prefix`/`prefix_timeout` rules (Auto-specific in practice: Manual `Final`s only arrive after our `finalize`), `turn` config, and the `close`-flush check. `eager_commit` (its timer, `last_partial_eager`, and its tests) is **optional**: implement it only after the measurement below and only if the auto column is slower than Manual; otherwise leave the flag off and skip its rows. **The demo ships on M2a if M2b is not measured by ~hour 20**; Manual with `manual_end` is already Google-class latency. **Measurement step (cap 30 min):** say "stop", "undo", "scroll down", "open chrome" 5× each under auto, auto+eager, and manual; record median and max of speech-end→dispatch. Pick the fastest with no truncation of "open … chrome" and set `stt.wake_endpoint`/`end_timeout_ms` (and `eager_commit` if implemented) accordingly. Also verify whether `{"type":"close"}` flushes a trailing `turn.end`; if not, set `stt.auto_forced_end: pad_then_close`. `REPORT.md`.

**Later (forbidden until M2b's smoke test passes), in priority order:** turning `wake.require_attention` on by default (after venue false-accept data); custom `<<WAKE_PHRASE>>` openWakeWord model swap (M3a) if the sherpa path was rejected; follow-up window (5–6 s, VAD-gated, no wake word); snooze timers (15/60 min); "what did you hear" history with one-click false-accept labeling; adaptive threshold from false-accept signals; number/URL/spelling normalizer; media ducking during `LISTENING`; `cloud_seconds_today` counter and budget warning; `debug.record` with persistent badge; DND detection; sleep/wake handling; level meter/clipping hints; spoken "Yes?" via Sonic TTS; auto-snooze when Zoom/Teams/Discord processes are running; keep-warm idle socket (zero-byte idle is *undocumented* as unbilled; counts against concurrency; would need recycling under the 3-min idle close); mid-utterance reconnect with PCM replay; access-token minting if a socket must live in a renderer.

---

## 16. Do not

- Stream audio in passive mode, "to keep the socket warm", or for wake detection.
- Open a second microphone stream.
- Act on partials. The eager commit is the one exception, is this prompt's judgment rather than Cartesia's recommendation (they suggest speculative work on `eager_end` and acting on `turn.end`), and runs only after local speech end. Trim/insert whitespace in Manual deltas. Append Auto cumulative transcripts.
- Emit a Manual `Final` per delta; emit it once on `flush_done`.
- Run two commands concurrently. Let the runtime mutate `Context` (only `handle` does, except the two VAD mirror fields, §4.5).
- Hard-code the wake phrase, API version, or timer values.
- Use Apple frameworks, Picovoice, Snowboy, or Cartesia Line/Managed Agents.
- Swallow `error` events; every one becomes `SttError` (or `SttFinalizeRejected`) with `error_code` logged.
- Start anything from the Later list before M2b passes.
- Block on questions; record assumptions in `DISCOVERY.md` and continue.

## 17. Final report (≤30 lines)

What was built, which milestones are complete, measured latency / inference time / false accepts, the M2b measurement table and the endpoint you chose, each §13 item ticked or deferred with reason, any place where live docs disagreed with Appendix A, and the exact commands for tests, `voice selftest`, `voice debug latency`, and the live smoke test.

---

## Appendix A — Verified Cartesia facts (docs.cartesia.ai, 2026-10-24, API version `2026-08-14`)

Consult this when writing `SttSession`. Cite the doc page in a comment wherever you rely on a non-obvious fact.

### A.1 Endpoints

| | **Auto (turns)** — wake mode | **Manual** — PTT (and wake fallback) |
|---|---|---|
| URL | `wss://api.cartesia.ai/stt/turns/websocket` | `wss://api.cartesia.ai/stt/websocket` |
| Model | `ink-2`, `ink-preview` (use `ink-2`) | `ink-2`, `ink-preview`, `ink-whisper` |
| Endpointing | Server-side semantic turn detection; `turn.*` events; `turn.end` lags speech end by ~0.5 s | None for ink-2 (you send `finalize`); ink-whisper only: `max_silence_duration_secs`, `min_volume` |
| End an utterance | Keep streaming (zeros if needed) until `turn.end`; or send `{"type":"close"}`. Sockets are multi-turn: each `turn.end` closes a turn and the next begins with a new `turn.start`; `request_id` is constant across turns | Text frame `finalize` (may be sent as many times as necessary; only after the user stops speaking — mid-speech produces transcription errors) → `flush_done`; text frame `close` → `done` and closes the session permanently |
| Transcript | `turn.update`/`turn.eager_end`/`turn.end` carry the **cumulative** turn text (replace, never append); never revised after emission; `turn.eager_end` is always followed by `turn.end` or `turn.resume`. Cartesia's recommended use of `eager_end` is speculative work that you cancel on `turn.resume`, acting only on `turn.end` | `transcript` events carry **deltas**; build by concatenating only `is_final:true` deltas **verbatim, no trimming, no inserted spaces**; `is_final:false` is display-only. The server buffers some audio; `close` (and in practice `finalize`) flushes it, so read until `flush_done`/`done` |
| Word timestamps | none | `words[]` optional (ink-whisper) |
| Language | auto-detect (`en, fr, hi, ja, es`); no language field in events | `language` param applies to ink-whisper only (default `en`) |
| `connected` message | emitted first; you need not wait for it before sending audio | not emitted (server types are only `transcript`, `flush_done`, `done`, `error`) |

Required query params on both: `model`, `encoding=pcm_s16le`, `sample_rate=16000`, `cartesia_version=2026-08-14` (on raw WebSockets the version is this query param; SDKs send a header). Optional `keyterm=` (repeatable, URL-encoded, ≤100 terms / ≤1200 chars, ink-2 only, **fixed for the connection**).

Auto turn tuning (query params `turn_start_threshold` 0.5–0.9 default 0.8, `turn_eager_end_threshold` 0.3–0.8 default 0.6, `turn_end_threshold` 0.05–0.5 default 0.3, `turn_end_timeout_ms` 640–11200 default 5600; constraint start > eager_end > end). Mid-session retune: `{"type":"config","turn":{"start_threshold":..,"eager_end_threshold":..,"end_threshold":..,"end_timeout_ms":..}}` (no `turn_` prefix inside). Cartesia's "Responsive" preset is 0.7/0.6/0.4/4500; this prompt shortens the timeout to 1500–2000 for commands. The v4.2 SDK docstrings state narrower ranges (eager_end 0.3–0.6 default 0.4, end default 0.2) than the docs; if the server rejects 0.6, use 0.5.

### A.2 Auth

Header `X-API-Key: sk_car_...` (or `Authorization: Bearer <key>`). If a socket must be opened from an untrusted context (Later): `POST https://api.cartesia.ai/access-token` with headers `Authorization: Bearer <api key>`, `Cartesia-Version: 2026-08-14`, `Content-Type: application/json`, body `{"grants":{"stt":true},"expires_in":60}` → `{"token": ...}` (other response fields unconfirmed), then `?access_token=` on the WebSocket. The `stt` grant documents `/stt/websocket`; coverage of `/stt/turns/websocket` is not documented.

### A.3 Audio input

Binary frames of raw headerless **mono** PCM. ~100 ms chunks (3200 bytes at 16 kHz s16le) paced at real time; large bursts → `Internal server error`. (The 1 s burst + 2× catch-up in §4.5 is this prompt's judgment, not a documented allowance; if the server 500s, fall back to 1×.) **Wrong sample rate/encoding is not rejected**; transcripts are silently garbled. Stopping the stream makes the server wait, not infer silence.

### A.4 Message shapes

Auto:
```json
{"type":"connected","request_id":"..."}
{"type":"turn.start"}
{"type":"turn.update","transcript":"open goo"}
{"type":"turn.eager_end","transcript":"open google chrome"}   // always followed by turn.end OR turn.resume
{"type":"turn.resume"}
{"type":"turn.end","transcript":"open google chrome please"}
{"type":"error","status_code":400,"title":"...","message":"...","error_code":"...","doc_url":"...","request_id":"..."}
```
Manual:
```json
{"type":"transcript","is_final":true,"request_id":"...","text":" open chrome","duration":1.9,"words":[...],"language":"en"}
{"type":"flush_done","request_id":"...","is_final":true}   // is_final here is deprecated/meaningless
{"type":"done","request_id":"...","is_final":true}
{"type":"error", ...same shape as Auto...}
```
Parsers must tolerate unknown/extra fields. Manual control frames are bare text (`finalize`, `close`); Auto control frames are JSON.

### A.5 Limits, cost, errors

- Idle timeout: 3 min without any message closes the socket; no keepalive primitive. **Silence is billed** (ink-2 = 3 credits/s; ink-whisper = 1 credit/s; Free plan 20K credits ≈ 111 min of ink-2 per month). Hence per-utterance sockets.
- Concurrency (STT): Free 8, Pro 12, Startup 20, Scale 60; idle sockets count; exceeding → `429`.
- 4xx on connect (bad key, model, or threshold) is permanent for that request: do not retry. 5xx/transport: retry inside `open()`.
- Max connection duration and request rate limits are not documented; the 60 s PTT cap is a safety margin.

### A.6 SDKs and TTS (optional; raw `websockets`/`ws` is the default for this design)

Python `cartesia` ≥ 4.2: `client.stt.auto_finalize.websocket(model=, encoding=, sample_rate=, keyterm=[...], turn_start_threshold=..., on_reconnecting=...)` (no `language` param), `client.stt.manual_finalize.websocket(..., language="en")` (`language` typed `Literal["en"]`; use `extra_query` otherwise); `conn.send_raw(bytes)`; Manual `conn.send("finalize")`/`conn.send("close")`; Auto `conn.send({"type":"close"})` (a bare string on the Auto client is a type error); iterate `for ev in conn`. Reconnect only if `on_reconnecting` is set (close codes 1001/1005/1006/1011–1013/1015; `max_retries=5`, `initial_delay=0.5`, `max_delay=8.0`). JS `@cartesia/cartesia-js` ≥ 4.2: `client.stt.autoFinalize.websocket({...})` / `manualFinalize.websocket({...})`, `ws.sendRaw(chunk)`, `ws.send("finalize")`, `for await (const ev of ws.stream())` with `ev.type === "message"` → `ev.message`.

Spoken "Yes?" (Later): pre-generate once via `POST https://api.cartesia.ai/tts/bytes` with `Cartesia-Version: 2026-08-14`, body `{"model_id":"sonic-3.6","transcript":"Yes?","voice":{"id":"<uuid from GET /voices>"},"output_format":{"container":"wav","encoding":"pcm_s16le","sample_rate":16000}}`; cache to disk. Never synthesize the wake phrase.

### A.7 Local engine facts

- **sherpa-onnx**: open-vocabulary transducer KWS; keyword file lines = BPE pieces + optional `:boost` `#threshold` (no space before the number); `sherpa-onnx-cli text2token --tokens --tokens-type bpe --bpe-model IN OUT`; Python `sherpa_onnx.KeywordSpotter` (class default `num_threads=2`; pass 1), float32 input in [-1, 1], `get_result` returns keyword text only, `reset_stream` after a hit, `num_trailing_blanks` up to ~8 for overlapping keywords; Node `createKws` with `keywords` as a string; English model `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (a bilingual zh-en 2025-12-20 model also exists). No documented guidance on minimum keyword length. Silero VAD is **supported** via `VoiceActivityDetector`/`createVad` with `windowSize: 512`, but `silero_vad.onnx` is a **separate download** from the sherpa-onnx releases page.
- **Silero VAD**: 512 samples per call at 16 kHz (enforced), stateful (`state` `(2, 1, 128)` + 64-sample context carried across calls), `reset_states()` zeros both.
- **openWakeWord**: 16 kHz int16, frames in multiples of 1280, `vad_threshold` (0 = off) gates on bundled Silero, default threshold 0.5, `Model.reset()`, `inference_framework` `"tflite"` (default, via `ai-edge-litert` on macOS/Linux) or `"onnx"`; only Windows is onnx-only; pretrained models CC BY-NC-SA 4.0.
- **python-soxr**: `ResampleStream(in_rate, out_rate, num_channels, dtype)` + `resample_chunk(x, last=False)`; input dtype/channels must match the constructor.
- **sounddevice**: `InputStream(samplerate=None)` uses the device default rate; `close()` discards pending buffers (as `abort()` would).
- **Electron**: `systemPreferences.askForMediaAccess('microphone')` → `Promise<boolean>` (macOS); `getMediaAccessStatus` → `not-determined|granted|denied|restricted|unknown`.
- **Picovoice Porcupine**: AccessKey required; free tier reported discontinued 2026-06-30.

## Appendix B — Sources

Cartesia: `use-the-api/stt/compare-endpoints`, `api-reference/stt/websocket`, `api-reference/stt/turns/websocket`, `use-the-api/stt/turns`, `build-with-cartesia/stt/audio-input`, `use-the-api/stt/keyterms`, `use-the-api/stt/troubleshooting/{manual,auto}`, `use-the-api/concurrency-limits-and-timeouts`, `pricing`, `get-started/authenticate-your-client-applications`, `build-with-cartesia/stt/latest`, `api-reference/tts/bytes`, `llms.txt` (all under docs.cartesia.ai; append `.md` for public versions); cartesia-python and cartesia-js v4.2.0 sources. Wake word / VAD: github.com/dscripka/openWakeWord (+ setup.py), github.com/livekit/livekit-wakeword, github.com/alfiedennen/openwakeword-colab-2026, k2-fsa.github.io/sherpa/onnx/kws (+ python-api-examples, nodejs-examples, keyword_spotter.py), github.com/snakers4/silero-vad (utils_vad.py), community.home-assistant.io threads on the Picovoice free-tier shutdown. Pipeline design: Home Assistant Assist pipeline/satellite docs, rhasspy/wyoming-satellite (refractory), LiveKit turn-handling options, Pipecat Cartesia turns service, Deepgram endpointing docs, Google Assistant conversation-design (errors, confirmations), Alexa error patterns. Audio/permissions: python-sounddevice, python-soxr, Electron `systemPreferences`/`globalShortcut`, pynput limitations, Apple developer forums on PortAudio mic prompts.
