# Voice input: "Hey Cartesia" + push-to-talk

Built from [the implementation prompt](CARTESIA_VOICE_INPUT_PROMPT.md); stack findings are in [DISCOVERY.md](DISCOVERY.md) and measurements in [REPORT.md](REPORT.md).

- **Wake word (local).** sherpa-onnx keyword spotting (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M`, int8) plus Silero VAD, running on a worker thread in the main process. Nothing leaves the Mac until the **red cloud dot** appears.
- **Speech to text (cloud).** Cartesia Ink (`ink-2`) over a raw WebSocket in the main process, one socket per utterance. Wake mode uses the Auto (turns) endpoint and push-to-talk uses the Manual endpoint.
- **Commands.** Steady's fixed vocabulary. The wake phrase replaces the spoken "Steady" prefix: "hey cartesia, pen down", "hey cartesia, undo", or just "pen down" with push-to-talk.

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

The mic permission belongs to the host process: **Electron** in dev, **Steady** when packaged. If the prompt never appears, run `tccutil reset Microphone org.steady.local` (or `com.github.Electron` in dev). The packaged app declares `NSMicrophoneUsageDescription`. The hardened runtime is off, so `com.apple.security.device.audio-input` is not required. If you enable the hardened runtime, add that entitlement.
