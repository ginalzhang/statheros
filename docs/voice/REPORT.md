# Voice report (prompt §14 "Done", §17)

> Historical measurements and checklist for the original wake-word implementation. They do not measure current command-word/open-mic recognition. The current behavior and live validation checklist are in [README.md](README.md).

**Built:** M0, M1, M2a and the M2b code paths: the pure state machine (§5, §8), Auto and Manual Cartesia sessions, transcript builders, the cloud-gated Forwarder, ring buffer and pre-roll, sherpa-onnx wake word with local "stop", Silero VAD (energy fallback), the post-processor (§9), the single-worker executor with the `cmd_id` guard, startup probe, PID lock, earcons, cloud dot, transcript line, mute, self-test and latency report. `eager_commit` is implemented but **off** (the M2b measurement decides). `stt.wake_endpoint = auto`.

**Not done and needs a human with a real key and mic:** the live smoke test, the M2b endpoint measurement table, and the check that `close` flushes a trailing `turn.end`. They are blocked on a `CARTESIA_API_KEY` and a person at the mic. Until measured, the defaults stand: `auto`, `eager_commit: false`, `auto_forced_end: close`.

## Measurements (dev Mac, Apple Silicon, synthetic speech)

| Metric | Result | Target |
|---|---|---|
| Wake + VAD inference, mean per 1280-sample frame | 0.6 ms wake word, 0.16 ms VAD, about 1.4 ms combined on 10 min of continuous speech | < 4 ms |
| Wake false accepts, 33.7 min of unrelated synthesized speech (plan text) | **0** | 0 per 10 min |
| "stop" false fires, same audio | 2 in 33.7 min (gated by `in_flight_cmd`) | ≤ 2 |
| Wake recall, 20 clips from 10 macOS voices ("Hey Cartesia, undo" / "Hey Cartesia. Pen down.") | 9/20 at threshold 0.1, boost 2 (it was 4/20 at the 0.25 default) | ≥ 8/10 human at 1 m |
| `Final` → `Dispatch` (integration, fake server) | < 1 ms | < 50 ms |

The recall figure uses **TTS voices only**, several of them novelty voices. It is a lower bound, not the §6.1 human test. Run 10 real utterances at 1 m before the demo. If recall is under 8/10, lower `#0.1` in `resources/voice/keywords_raw.txt` and regenerate. The false-accept margin at that threshold was zero fires, so there is room to go lower. The sweep and false-accept scripts are reproducible from `scripts/voice-fixtures.mjs` plus the sherpa `Inference` class (see the README).

Found and fixed while measuring: Silero's 2 s internal buffer was regrowing during long speech, which cost 28 ms per frame. The buffer is now sized to 60 s, at or above `maxSpeechDuration`.

Latency targets that need live runs: wake → earcon (< 50 ms; the earcon plays from a pre-opened context), wake → first byte (< 800 ms), speech end → Final, and hotkey tap → abort. Settings › Voice › **Show latency** reports the session median and max, and every utterance is logged to `voice.log`.

## §13 checklist

Covered by unit tests (`tests/voice/machine.test.ts`, `components.test.ts`, `postprocess.test.ts`): one breath; pause with a late `Final("sia")`; coughs bounded by `max_utterance`; refractory double wake; ≤1-word `pending_prefix` and `prefix_timeout` ("undo"); utterance reset; wake ignored in LISTENING; barge-in in EXECUTING; local "stop"; no-hook honesty ("Can't stop that one", no earcon); 20 earcons gated plus `gate_cap`; unstamped `wake_gate_tail`; non-gating TTS; 401/403 sticky; 429 not sticky; mid-utterance drop → ERROR; a wake in PROCESSING; eager commit plus the later `turn.end`; `turn.resume`; session_id filter (runtime); both transcript builders; `SttFinalizeRejected` (LISTENING/PTT and PROCESSING); socket close; PTT partials plus low-confidence `forced_end`; interrupt words; "stop" with nothing in flight; the cloud dot off in every non-streaming state; probe at startup; command failure → ERROR; command timeout orphan; dictation; one-word PTT never dropped; PTT with no speech → "Didn't catch that"; soft end before connect; the connect backstop on long PTT; mute; device change. Integration (`tests/voice/integration.test.ts`, real sherpa + Silero, fake Cartesia): one breath, pause, 5 s silence (0 bytes sent), double wake, 401 on connect.

**Deferred, with reasons:**
- **Hold-to-talk, lost `HotkeyUp`, `hold_silence`, tap/hold barge-in.** Electron `globalShortcut` is key-down only (§2). The machine paths are implemented and unit-tested; the UI exposes toggle only.
- **Esc cancel.** The panel never takes focus; the transcript click and the hotkey cover it.
- **`palm_toggle` and `require_attention`.** Tracking exposes no "palm raised" or "facing screen" signal yet (DISCOVERY §6).
- **Bluetooth HFP input selection.** The renderer uses the system default device.
- **Physical device-swap and permission-denied runs.** The code paths exist; they need manual checks.
- **Shutdown ≤ 2 s.** Implemented (Shutdown → close all), not timed.

## Places where reality differed from Appendix A

- `ws` must be resolved with Node conditions in Vite; otherwise the browser stub is bundled (fixed in `vite.main.config.ts`).
- sherpa-onnx-node's `KeywordSpotter` takes `keywordsFile`, not a `keywords` buffer string, in 2.0.0.

No Cartesia doc disagreement was observed offline; the live checks are pending.

## Commands

```sh
npm test                         # all unit + integration tests
npm run voice:assets             # models (pinned SHA-256)
node scripts/voice-fixtures.mjs  # regenerate WAV fixtures
npm run dev                      # Settings › Voice: self-test, latency, key
```
