# Voice input: local command words, "Hey Cartesia" and push-to-talk

Built from [the implementation prompt](CARTESIA_VOICE_INPUT_PROMPT.md); stack findings are in [DISCOVERY.md](DISCOVERY.md) and measurements in [REPORT.md](REPORT.md).

- **Wake word (local).** sherpa-onnx keyword spotting (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M`, int8) plus Silero VAD, running on a worker thread in the main process. Nothing leaves the Mac until the **red cloud dot** appears.
- **Speech to text (cloud).** Cartesia Ink (`ink-2`) over a raw WebSocket in the main process, one socket per utterance. Wake mode uses the Auto (turns) endpoint and push-to-talk uses the Manual endpoint.
- **Commands (local, no wake phrase).** The same keyword spotter also listens for every Steady command ("undo", "redo", "brush", "eraser"/"erase", "pen down", "bigger", "pause"…; see `resources/voice/keywords_raw.txt`). With the mic on, a spotted command runs immediately, even mid-sentence ("switch to the brush"). Eraser is a toggle.
- **Counts and follow-ons.** Right after a spotted command runs, that utterance is streamed to Cartesia from the pre-roll (the red cloud dot shows), so "undo … three times" runs two more undos once the transcript arrives. No earcon plays, and a failed connection is dropped quietly because the command already ran. Set `wake.localFollowUp: false` in `src/main/voice/config.ts` to keep spotted commands fully on-device.
- **Meaning (Claude).** Every transcript (wake, push-to-talk, follow-up) becomes an ordered plan of actions with repeat counts (`src/main/voice/plan.ts`). Plain phrasings are parsed locally and run at once: "undo 3 times", "undo undo undo", "undo the last two strokes", "undo twice then switch to the brush". Anything else ("get rid of the last few lines", "don't undo") goes to Claude (`claude-haiku-5-5`, `src/main/voice/intent.ts`), constrained to Steady's actions. Without an Anthropic key the local parse runs, unless it heard a negation. Only undo, redo, bigger and smaller repeat, at most 20 times, about 60 ms apart.

## Setup

```sh
npm ci
npm run assets            # MediaPipe + voice models (SHA-256 pinned in resources/voice/manifest.json)
export CARTESIA_API_KEY=sk_car_...   # or paste it into Settings › Voice (stored in the macOS Keychain)
npm run dev
```

Steady launches **microphone-off**. Click the mic button on the panel (or press ⌘⇧M) to start listening locally for "hey cartesia".

| Input | Action |
|---|---|
| "hey cartesia, pen down" | wake + command in one breath |
| "hey cartesia" … pause … "undo" | also works (the text-less pause rule) |
| **⌘⇧Space** | push-to-talk toggle: press, speak, then press again or just stop talking |
| Mic button click | turn the mic on; then push-to-talk; mid-utterance it cancels |
| Mic button right-click / long-press, **⌘⇧M** | mute: the OS mic indicator turns off |
| Click the transcript | cancel |
| "cancel", "never mind" | abort the utterance; never sent as a command |

Electron's `globalShortcut` fires on key-down only, so there is no hold-to-talk: the hotkey toggles. ⌘⇧Space can conflict with input-source switching on some setups, so check the toast at launch. macOS Secure Input (a focused password field) swallows global keys; the panel button still works. Because the panel never takes focus, Esc cannot cancel; use the transcript click or the hotkey. Voice "cancel" cannot press a Cancel button in Krita. Steady commands are atomic native actions with no abort hook, so "stop" during a command says "Can't stop that one".

## Changing command words or sensitivity

Edit `resources/voice/keywords_raw.txt` (`TEXT @LABEL :boost #threshold`; the label is the command phrase in capitals with `_` for spaces, and must be in `src/main/voice/steady-commands.ts`). Add respellings for words the spotter misses (as with `ERACE`), raise `#threshold` if it fires by accident, then regenerate `keywords.txt` with the command below.

## Changing the wake phrase

Edit `wake.phrase` in `src/main/voice/config.ts` and the respellings in `resources/voice/keywords_raw.txt`, then regenerate the BPE keyword file (never hand-write the pieces):

```sh
python3 -m venv .cache/spvenv && .cache/spvenv/bin/pip install sentencepiece
.cache/spvenv/bin/python -I scripts/voice-keywords.py resources/voice/models/kws/bpe.model resources/voice/keywords_raw.txt resources/voice/keywords.txt
```

## Tests

```sh
npm test                         # unit + integration (tests/voice/*); integration needs `npm run voice:assets`
node scripts/voice-fixtures.mjs  # regenerate the synthetic WAV fixtures (macOS `say`)
```

Integration tests run the real tap → Silero/sherpa pipeline on WAV fixtures faster than real time, against a local fake Cartesia WebSocket server. Required fixtures: one breath, pause, silence, double wake, and 401 on connect.

## `voice selftest` and `voice debug latency`

Both are buttons in **Settings › Voice**. The self-test checks 16000 ± 1 % samples/s from the real device and the peak dBFS, and warns below −45 dBFS. The latency report gives the session median and max for wake → first audio byte, speech end → Final, and Final → dispatch. Logs go to `~/Library/Application Support/Steady/voice.log`; set `STEADY_VOICE_DEBUG=1` for debug lines. Transcripts are never logged.

## Live smoke test (real key, before every demo)

1. "hey cartesia, pen down" in one breath → the pen goes down and the transcript shows "pen down".
2. "hey cartesia", wait 2 s, "undo" → undo runs.
3. "hey cartesia", stay silent → the indicator dims within about 8 s, nothing is dispatched, and the log shows `no_speech`.
4. ⌘⇧Space, "bigger", then stop talking → runs after about 1 s of silence. ⌘⇧Space and say nothing → "Didn't catch that" after 8 s.
5. Press ⌘⇧Space twice, 10 times in a row (each start plays the wake earcon) → 0 wake detections in the log.
6. "hey cartesia", then "cancel" → cancel earcon, nothing dispatched.
7. "hey cartesia, stop" with nothing running → dispatched as a command and rejected as "not a Steady command".
8. ⌘⇧M → the OS mic dot disappears and the wake word does nothing; ⌘⇧M again restores it.

## Permissions

Run `npm run setup:signing` once per Mac before packaging. Ad-hoc builds change identity on every rebuild, so macOS silently drops the Microphone and Accessibility grants; builds signed with the local "Steady Local Signing" certificate keep them. Without the certificate, packaging falls back to ad-hoc signing.

The mic permission belongs to the host process: **Electron** in dev, **Steady** when packaged. If the prompt never appears, run `tccutil reset Microphone org.steady.local` (or `com.github.Electron` in dev). The packaged app declares `NSMicrophoneUsageDescription`. The hardened runtime is off, so `com.apple.security.device.audio-input` is not required. If you enable the hardened runtime, add that entitlement.
