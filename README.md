# Steady (Statheros)

**Voice commands:** say “hey cartesia, pen down” or use ⌘⇧Space push-to-talk. The wake word runs locally (sherpa-onnx); speech-to-text is Cartesia Ink and is only streamed while the red dot shows. See [docs/voice/README.md](docs/voice/README.md). **UI:** the companion panel follows the Statheros Figma design ([docs/design](docs/design/IMPLEMENTATION.md)).

Phase 03 Krita integration implementation for Apple Silicon/macOS 26+. Phase completion is governed by [the plan](plan/PLAN.md) and [execution ledger](plan/LEDGER.md). Five-position calibration and visual/fake-input mapping are available. Canvas marking, explicit drawing, safe recovery, semantic panel actions and configurable global keys are implemented. Physical Phase 03 acceptance is pending operator verification.

Use Node 26.12.1, npm 11.20.0, Swift 6.4 and macOS SDK 27.0. All direct npm dependencies are pinned in `package.json`; use the committed/resolved `package-lock.json` without updating versions.

```sh
npm ci
npm run setup:electron
npm run assets
npm run typecheck
npm test
npm run test:native
npm run package
npm run test:e2e
npm run make
```

`npm run dev` starts Forge/Vite and the bundled native helper. Development uses only the local Vite origin; packaged resources load from local files and `steady-resource:`. In environments setting `ELECTRON_RUN_AS_NODE=1`, unset it before launching Electron. Playwright does this explicitly.

The app is `out/Steady-darwin-arm64/Steady.app`; ZIP output is `out/make/zip/darwin/arm64/Steady-darwin-arm64-0.1.0.zip`. The Swift executable and verified model/runtime files are outside ASAR under `Contents/Resources/`. All asset URLs/hashes are in [the manifest](resources/asset-manifest.json). Restore assets using `npm run assets`; runtime downloads and CDN fallback are blocked.

The panel starts paused with microphone off, camera off and fake native input. Open Settings to select a camera/mode, start capture, and complete neutral/left/right/up/down captures. Each Capture samples for two seconds and requires at least40 valid samples and80% validity. The panel shows a mirrored preview. Calibration is saved separately per camera/mode in atomic versioned settings; no active input state is persisted. Recenter captures neutral, preserves extents and leaves input paused. After declared Palm loss, show only the selected model label and explicitly confirm it. Continuity uses a conservative label/proximity heuristic. Voice input (Cartesia + local wake word) starts with the microphone off; turn on Voice Commands in the panel to listen for the wake phrase. The panel owns capture when unfocused/collapsed; settings pause input. No frames, recordings or transcripts are persisted. Phase-01 action timing evidence contains session/utterance IDs and action IDs only.

The supervised real-input probe is available only in the packaged app. It requires the disposable-document confirmation checkbox and launches the bundled helper with explicit `--probe --real-input`. Switch to Krita during the five-second countdown, keeping the physical cursor over a disposable canvas with room for a ten-point rightward stroke. The probe is bounded; emergency release is available in Settings. Automated tests use fake input and never invoke this control.

Follow the [Phase 03 operator checklist](plan/ledger/phase-03-20261024-01/artifacts/operator-checklist.md) for manual Krita acceptance. The10s warmup+60s baseline measures renderer mapping rate and receipt-to-map processing time. Camera inference p95 is bitmap-dispatch-to-result receipt; neither number represents native-event or perceived smoothing latency. Full scored native timing belongs Phase05. A successful build or synthetic model test does not establish physical-camera, fullscreen, permissions, external-display or offline inference acceptance.

The [2026-10-24 scope amendment](plan/ledger/phase-02-20261024-01/artifacts/desk-palm-deferral-01.md) permits raised-hand Palm validation in Phase 02. Relaxed desk-facing Palm behavior remains unverified and its mandatory physical validation is deferred to Phase 05. Remaining Phase 02 hardware/review evidence is preserved as unverified; the user accepted Phase 02 as sufficient Phase 03 entry.

For Phase 03, open a disposable Krita document and enable real input explicitly in Settings. Select/calibrate the camera and display, close Settings, keep Krita foreground, then use the nonactivating panel **Set canvas** control. F8 marks top-left then bottom-right during setup and otherwise toggles the pen; F9 pauses. Canvas capture ends paused and Resume requires 500ms of valid tracking. Reconfirm canvas each launch and after geometry/camera/mode changes. Opening Settings, target changes and loss always release input; recovery never resumes automatically. Configure additional global keys in Settings. Generic shortcut profiles are saved previews and remain unverified/unavailable for native execution under the fixed Krita-only protocol. Voice commands use the fixed vocabulary without the “Steady” prefix after the wake phrase; see docs/voice/README.md.
