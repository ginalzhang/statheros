# Voice input: local command words, open mic and push-to-talk

Built from [the implementation prompt](CARTESIA_VOICE_INPUT_PROMPT.md); historical stack findings are in [DISCOVERY.md](DISCOVERY.md) and earlier measurements in [REPORT.md](REPORT.md). This guide describes the current behavior. The original "hey cartesia" wake phrase has been removed: open mic replaces it.

- **Command words (local).** sherpa-onnx keyword spotting (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M`, int8) plus Silero VAD, running on a worker thread in the main process, listens for every Steady command ("undo", "redo", "brush", "eraser"/"erase", "toggle erase", "pen down", "bigger", "swap colors", "tremor filter", "pause"…; see `resources/voice/keywords_raw.txt`). With the mic on, a spotted command runs immediately, even mid-sentence ("switch to the brush"), and that utterance stays on the Mac.
- **Open mic (cloud).** With the mic on, an utterance that ends without a command word ("get rid of that last line") is streamed to Cartesia Ink (`ink-2`, Auto endpoint) from the start of that utterance, never earlier, so a previous command word is never transcribed twice. The **red cloud dot** shows while audio is sent. There is no earcon, and a failed connection is dropped quietly. Speech under 250 ms is ignored. Set `wake.openMic: false` in `src/main/voice/config.ts` to disable automatic cloud transcription. Push-to-talk still uses Cartesia, and startup still checks the configured key.
- **Push-to-talk (cloud).** ⌘⇧Space sends one utterance to Cartesia's Manual endpoint.
- **Meaning (Claude).** Every transcript becomes an ordered plan of actions with repeat counts (`src/main/voice/plan.ts`). Plain phrasings are parsed locally and run at once: "undo 3 times", "undo twice then switch to the brush". Anything else ("I want to rub that out", "don't undo") goes to Claude (`claude-haiku-5-5`, `src/main/voice/intent.ts`), constrained to Steady's actions. An open-mic utterance that is not a request (talk to someone in the room) is ignored silently. Without an Anthropic key the local parse runs, unless it heard a negation. Only undo, redo, bigger and smaller repeat, at most 20 times, about 60 ms apart.
- **Eraser.** "Eraser"/"erase" switches erase mode on and does nothing if it is already on. "Brush" switches back to painting (it also turns erase mode off). "Toggle erase" flips it. Krita does not report erase mode, so Steady tracks what it last sent. If you change it in Krita directly, say "toggle erase" once to get back in step.
- **Other words.** "Swap colors" presses Krita's X (foreground/background). "Tremor filter" is a toggle on Steady's own pointer smoothing, not Krita's stabilizer: it switches to the Tremor Filter stroke mode and back to the previous smoothing, keeping sensitivity, and needs a calibration.
- **Counts after command words (off).** `wake.localFollowUp: true` also streams utterances that contained a command word, so "undo … three times" runs two more. It is off by default, so a command word runs once.

## Setup

```sh
npm ci
npm run assets            # MediaPipe + voice models (SHA-256 pinned in resources/voice/manifest.json)
export CARTESIA_API_KEY=sk_car_...   # or paste it into Settings › Voice (encrypted on this Mac with Electron safeStorage)
npm run dev
```

Steady launches **microphone-off**, and loads local inference models on first microphone activation. The panel shows “Starting microphone…” until capture opens; the switch reports actual capture. Electron holds an OS-backed single-instance lock for each application profile. Enable Voice Commands or click the mic button on the panel (or press ⌘⇧M) to start listening. Command words can execute mid-sentence, and everything else said near the mic is sent to Cartesia (and to Claude when it isn't a plain command), so mute when you do not want voice control. Without a Cartesia key, command words still work but open mic and push-to-talk are unavailable.

Configure `ANTHROPIC_API_KEY` or Keychain service `org.steady.anthropic`, account `steady`, for Claude. Only the transcript is sent to Claude; command words spotted on-device never call it.

| Input | Action |
|---|---|
| "pen down", "switch to the brush" | runs on-device at once |
| "I want to rub that out" | open mic → Cartesia → Claude → eraser |
| **⌘⇧Space** | push-to-talk toggle: press, speak, then press again or just stop talking |
| Mic button click | turn the mic on; then push-to-talk; mid-utterance it cancels |
| Mic button right-click / long-press, **⌘⇧M** | mute: the OS mic indicator turns off |
| Click the transcript | cancel |
| "cancel", "never mind" | abort the utterance; never sent as a command |

Electron's `globalShortcut` fires on key-down only, so there is no hold-to-talk: the hotkey toggles. ⌘⇧Space can conflict with input-source switching on some setups, so check the toast at launch. macOS Secure Input (a focused password field) swallows global keys; the panel button still works. Because the panel never takes focus, Esc cannot cancel; use the transcript click or the hotkey. Voice "cancel" cannot press a Cancel button in Krita. Steady commands are atomic native actions with no abort hook, so "stop" during a command says "Can't stop that one".

Only one app should listen at a time: another voice-controlled Krita helper running alongside Steady will act on the same words (two "eraser" toggles cancel out).

## Changing command words or sensitivity

Edit `resources/voice/keywords_raw.txt` (`TEXT @LABEL :boost #threshold`; the label is the command phrase in capitals with `_` for spaces, and must be in `src/main/voice/steady-commands.ts`). Add respellings for words the spotter misses (as with `ERACE`), raise `#threshold` if it fires by accident, then regenerate the BPE keyword file (never hand-write the pieces):

```sh
python3 -m venv .cache/spvenv && .cache/spvenv/bin/pip install sentencepiece
.cache/spvenv/bin/python -I scripts/voice-keywords.py resources/voice/models/kws/bpe.model resources/voice/keywords_raw.txt resources/voice/keywords.txt
```

## Tests

```sh
npm test                         # unit + integration (tests/voice/*); integration needs `npm run voice:assets`
node scripts/voice-fixtures.mjs  # regenerate the synthetic WAV fixtures (macOS `say`)
```

Integration tests run the real tap → Silero/sherpa pipeline on WAV fixtures faster than real time, against a local fake Cartesia WebSocket server: a command word inside a sentence, plain conversation (open mic), the old wake phrase, silence, and 401 on connect.

## `voice selftest` and `voice debug latency`

Both are buttons in **Advanced settings › Voice input**; the main Settings Voice tab also offers a microphone test. The self-test measures sample delivery and peak dBFS over two seconds. It expects 16000 samples/s, allows ±2.5% IPC batching jitter, and warns below −45 dBFS. It does not test recognition. Concurrent requests share one measurement. The latency report gives the median and max for the most recent 1,000 commands for speech end → Final and Final → execution start (including executor queue time). Logs go to `~/Library/Application Support/Steady/voice.log`; set `STEADY_VOICE_DEBUG=1` for debug lines. Logs are asynchronous and bounded to two 1 MB files. Transcripts are never logged. If a connection queues more than two seconds of audio, the utterance fails instead of accumulating delayed audio.

## Live smoke test (real key, before every demo)

1. "Pen down" → the pen goes down at once; the red dot does not show.
2. "Eraser" → erase mode on. "Eraser" again → stays on. "Brush" → painting again.
3. "I want to rub that out" → the red dot shows, then the eraser comes on (needs the Anthropic key).
4. Talk about something else for a few seconds → the red dot shows, then nothing happens and no toast appears.
5. ⌘⇧Space, "bigger", then stop talking → runs after about 1 s of silence. ⌘⇧Space and say nothing → "Didn't catch that" after 8 s.
6. "Swap colors" → Krita's foreground and background colors swap.
7. ⌘⇧M → the OS mic dot disappears and nothing is heard; ⌘⇧M again restores it.

## Permissions

Run `npm run setup:signing` once per Mac before packaging. Ad-hoc builds change identity on every rebuild, so macOS silently drops the Microphone and Accessibility grants; builds signed with the local "Steady Local Signing" certificate keep them. Without the certificate, packaging falls back to ad-hoc signing.

The mic permission belongs to the host process: **Electron** in dev, **Steady** when packaged. If the prompt never appears, run `tccutil reset Microphone org.steady.local` (or `com.github.Electron` in dev). The packaged app declares `NSMicrophoneUsageDescription`. The hardened runtime is off, so `com.apple.security.device.audio-input` is not required. If you enable the hardened runtime, add that entitlement.
