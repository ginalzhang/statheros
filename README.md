# Statheros

**Voice commands:** explicitly enable Voice Commands, then just talk. Command words (“pen down”, “eraser”) run on-device at once (sherpa-onnx). Anything else you say streams to Cartesia Ink while the red cloud dot shows, and is read by Claude when an Anthropic key is configured (“I want to rub that out” → eraser). ⌘⇧Space push-to-talk also works. There is no wake word. See [docs/voice/README.md](docs/voice/README.md). **UI:** the companion panel follows the Statheros Figma design ([docs/design](docs/design/IMPLEMENTATION.md)).

Steady is a working prototype of a local macOS drawing companion for Krita on Apple Silicon/macOS 26+. It maps camera-based head or palm tracking across the selected display and limits drawing to a configured canvas rectangle. It provides drawing controls through a floating panel and configurable global keys, with five-position calibration, Accessibility-based canvas detection, mouse selection, explicit real-input opt-in, and pause/recovery controls.

Physical-camera, live voice, and Krita acceptance remain partially unverified. One instance runs per application profile. Voice models load when the microphone is first enabled; voice starts with the microphone off; Apple speech-asset installation is unused. Generic shortcut profiles are configuration previews; native execution supports the fixed Krita profile.

## Development

Use Node 26.12.1, npm 11.20.0, Swift 6.4, and macOS SDK 27.0. Install the pinned dependencies with the committed `package-lock.json`.

```sh
npm ci
npm run setup:electron
npm run setup:signing
npm run assets
npm run dev
```

Development starts Forge/Vite and the bundled native helper. If the environment sets `ELECTRON_RUN_AS_NODE=1`, unset it before launching Electron; Playwright does this explicitly. Packaged resources load locally from files and `steady-resource:`. Model/runtime URLs and hashes are recorded in [the asset manifest](resources/asset-manifest.json). Restore assets with `npm run assets`; runtime downloads and CDN fallback are blocked.

## Checks and packaging

```sh
npm run typecheck
npm test
npm run test:native
npm run package
npm run test:e2e
npm run make
```

Package before running the packaged-app end-to-end tests. Automated tests use fake input; they do not establish physical-camera, real desktop input, fullscreen, permissions, external-display, or offline inference acceptance.

Run `npm run setup:signing` once per Mac before packaging. Ad-hoc builds change identity on every rebuild, so macOS silently drops the Accessibility (and Camera/Microphone) grants even though System Settings still shows Steady enabled; builds signed with the local "Steady Local Signing" certificate keep them. Without the certificate, packaging falls back to ad-hoc signing.

The packaged app is `out/Steady-darwin-arm64/Steady.app`. ZIP output is `out/make/zip/darwin/arm64/Steady-darwin-arm64-0.1.0.zip`. The Swift executable and verified model/runtime files are outside ASAR under `Contents/Resources/`. See [the native helper documentation](native/README.md) for protocol and runtime details.

## Using the prototype

The panel starts paused, with camera and microphone off and fake native input enabled.

1. Open a disposable Krita 5.3.4 document. Select its display in Settings, close Settings, and bring Krita to the foreground.
2. Choose **Set canvas** near the top of the floating panel. It starts fresh detection: an identified canvas or drawing viewport is confirmed automatically; an available workspace suggestion opens for review automatically. If no usable bounds arrive within ten seconds, mouse selection opens so you can drag the drawing area yourself. Review and mouse selection require **Use canvas**; every path leaves input paused. Cancel while detection is pending to prevent the overlay from opening later. The separate **Detect canvas** control remains available for detection only.

   Steady uses Accessibility information to look for an unambiguous document or drawing viewport. A detected viewport may include gray workspace around the document. The status explains when detection is unavailable; the window frame is never substituted for a canvas.
3. If you used the separate **Detect canvas** control and Krita exposes only an unnamed workspace, choose **Review suggested workspace** when offered. **Set canvas** opens this review automatically. The overlay highlights that surrounding document area. Steady excludes the bottom info/status bar when its Accessibility geometry exposes one unambiguous, full-width bar along the window's bottom edge. Missing or ambiguous bar geometry leaves the suggestion unchanged; tabs, rulers, or scrollbars may still be included. When necessary, Steady reduces the suggestion to keep its floating panel outside the rectangle, including in fullscreen. The overlay explains this adjustment. Inspect the outline, drag to replace it with the desired drawing rectangle if necessary, then choose **Use canvas**. The suggestion requires explicit review; it is not automatically accepted as a viewport.
4. To choose the area yourself, use **Select with mouse**. Canvas setup controls temporarily replace the interface at the floating Steady panel's location, with **Use canvas**, **Retry**, and **Cancel** in that same area. Drag a rectangle in either direction on the temporary overlay, then choose **Use canvas**. **Retry** clears it; **Cancel** or Escape discards the setup and leaves drawing paused. The rectangle must be at least 100 × 100 logical points, stay on the selected display, and exclude the persistent Steady panel. Temporary selection controls do not add another forbidden canvas region. If a rectangle you draw overlaps the persistent panel, redraw it or cancel setup and move the panel. The overlay consumes selection clicks and temporarily suspends tracked pointer movement. Mouse selection and workspace review do not require camera capture or calibration.
5. Open Settings, select a camera and tracking mode, and start capture. The preview is mirrored. Complete neutral/left/right/up/down calibration. Each capture samples for two seconds and requires at least 40 valid samples and 80% validity. Calibration is saved separately per camera and mode. Recenter preserves extents and leaves input paused. After calibration or a camera/mode change, reconfirm the canvas.
6. Explicitly enable real input in Advanced settings (linked from the Settings footer), close Settings, return to Krita, and detect, review, or select the canvas again if needed. Resume explicitly after tracking is valid for 500 ms. F8 toggles the pen; F9 pauses. Additional global keys can be configured in Advanced settings. The “Before you draw” checklist shows missing prerequisites. In Palm mode, Resume confirms the selected hand when it is the only matching hand in view and waits briefly for steady tracking.

Pen Down from the panel, F8, or voice arms the pen when the pointer is outside the canvas or over an excluded window. It presses on entering the canvas and can re-engage after leaving and returning. Pen Up, Pause, setup, and tracking loss disarm it. After the pointer moves more than 15 logical points during a stroke, holding within 7.5 points for 1.2 seconds lifts and disarms the pen. The former rest/lift gesture is retired. The Camera Preview remains a separate movable window, excluded from drawing alongside the panel.

Automatic detection is monitored while Krita is ready. New detected bounds show a brief outline and always leave input paused; unchanged observations do not interrupt drawing. A manual selection takes precedence until **Set canvas** or **Detect canvas** is chosen again. Root-window movement, resizing, document identity, and directly observed viewport or suggested workspace bounds invalidate a manual selection, independently of whether the deeper viewport search has completed. These changes require reselection; leaving Krita idle should preserve the confirmation. Changes to an unrelated widget-tree hash do not invalidate it. Manual bounds otherwise stay fixed on screen: reselect after dock changes, zooming, or panning when the viewport or those changes cannot be identified. The last accepted canvas is remembered across launches and helper recovery only when the selected display, Krita window frame, hashed document identity, and recorded workspace or viewport match. Restoring it leaves input paused. An explicit Set canvas request starts fresh detection; canceling setup prevents remembered bounds from being reapplied until another confirmation or helper recovery.

When detection completes without identifying a viewport, open **Canvas diagnostics** on the panel or in Settings and choose **Copy canvas diagnostics**. The report contains bounded Accessibility structure and geometry, technical widget identifiers, hashed window/document identity, and the fields behind the most recent observation-driven invalidation. It also records the last selection-validation rectangles and computed persistent-panel intersection so an unexpected overlap error can be investigated. Temporary selection controls are recorded separately and do not add an exclusion. The report excludes raw window titles, document text, images, and camera data. Reports stay in memory until explicitly copied; no report is uploaded or saved to a file automatically.

Selection previews, mouse coordinates, panel-positioned controls, and confirmation outlines use each overlay's actual content origin in logical points. This accounts for macOS shifting a requested overlay window below its menu area. Preview and confirmation reject an outdated surface frame; no fixed menu-bar or status-bar inset is assumed.

**Advanced canvas setup** retains tracked corner marking: begin **Mark corners with tracking**, position the tracked pointer at the top-left and press F8, then mark the bottom-right with F8. This legacy method requires tracking calibration. F8 only marks corners while advanced tracked setup is active.

Opening Settings, target changes, and tracking loss release input. Recovery never resumes automatically. The panel continues to own capture when unfocused or collapsed. After declared palm loss, show only the selected model label and choose Resume (or Confirm selected hand); continuity uses a conservative label/proximity heuristic. Canvas setup changes the permitted drawing area; pointer mapping remains display-wide so the floating controls remain reachable.

Settings also offers a bounded real-input probe in the packaged app. Confirm a disposable Krita document, switch to Krita during the five-second countdown, and keep the physical cursor over the canvas with room for a ten-point rightward stroke. Emergency release is available in Settings.

## Known limitations

- Canvas detection uses macOS Accessibility and window metadata only; it does not capture screens, require Screen Recording permission, or install a Krita plugin. Its success depends on the geometry Krita exposes. Missing or ambiguous geometry requires mouse selection. A bounded search can continue across polling intervals rather than restarting the entire tree on each interval. Live viewport detection, window-change invalidation, focus restoration, and physical selection-click isolation require packaged Krita validation; automated tests alone do not establish those behaviors. See the [idle invalidation and diagnostics retest](docs/KRITA_CANVAS_VALIDATION.md#idle-invalidation-and-accessibility-diagnostics).
- Initial automatic detection targets unrotated documents. Use mouse selection for rotated or ambiguous layouts. A viewport rectangle includes its gray workspace; it does not represent the rotated artwork's exact shape.
- Relaxed desk-facing palm tracking remains unverified; earlier validation used a raised hand.
- The 10-second warmup and 60-second baseline measure renderer mapping rate and receipt-to-map processing time. Camera inference p95 measures bitmap dispatch to result receipt. These do not establish native-event or perceived smoothing latency.
- Local drawing keywords can execute mid-sentence while Voice Commands is enabled, and other speech near the mic is sent to Cartesia: mute when you don't want to be heard. Open mic and push-to-talk use Cartesia; optional Claude interpretation uses `ANTHROPIC_API_KEY` or the macOS Keychain. Apple speech assets are unused. Live recognition and speech timing remain unverified. See [voice setup](docs/voice/README.md).
- No camera frames, recordings, or transcripts are persisted. Voice timing logs contain identifiers and counters only. Voice and tracking logs are buffered asynchronously and each retain at most two 1 MB files.

Historical plans, reviews, operator checklists, and execution evidence are preserved locally in `.archive/plan/`. `.archive/` is ignored by Git and is not included in fresh checkouts. These records describe earlier development milestones; this README describes the current working prototype.
