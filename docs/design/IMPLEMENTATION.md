# Figma → Steady implementation notes

The panel follows the Figma main frame: 300 px wide, warm-white surface, Inter, and the cyan, mint and salmon tokens. Every control drives existing behavior (handoff §08.07: no disconnected controls).

| Figma control | Wired to |
|---|---|
| Tracking: Hand/Head Tracking · Active/Paused | Selected mode + native helper state. It shows "No camera" or "Unavailable" rather than a false "Active". |
| Camera · Connected | Whether the live camera probe is running |
| Recalibrate Tracking | Opens Settings (five-position calibration) |
| Input: Pen Up / Pen Down | `penUp` / `penDown` actions; selection follows the helper's `buttonDown` |
| Stroke Assistance chips | Presets over the engine's existing **smoothing** (One Euro cutoff) and **gain**: Natural 20, Steady 75, Precision 60 / gain 0.8, Sketch 10 / gain 1.4, Tremor Filter 95. **Adaptive is omitted**: it has no engine behavior, and the handoff says not to invent one. |
| Tremor Smoothing / Movement Sensitivity | Calibration `smoothing` (0–100 %) and `gain` (0.5–3 mapped linearly to 0–100 %). The value is applied on release through `tune-calibration`, which changes only those two fields, keeps the canvas, and releases a held pen first. |
| Voice Commands switch | Voice module mic on/off. Shows the actual capture state. Added below it: push-to-talk mic button, listening state, red cloud dot, transcript |
| Canvas section | Existing automatic detection, workspace review, mouse selection, diagnostics, and advanced tracked corner selection. Selection remains paused and uses the current panel exclusion rectangle. |
| Pause Tracking / Resume Tracking | `pause` / `resume`. Resume keeps every existing safety gate. |
| Recalibrate | `recenter` (new neutral, extents preserved) |
| Hand / Head Preview | The existing mirrored preview canvas, with a footer showing tracking and pen state |
| Floating toolbar | Click, pen toggle, eraser, brush, smaller, bigger, undo, redo. **AI Assist is rendered disabled** (unsupported), as the handoff requires. |
| Minimized (header only) | Collapse to 300 × 48. Tracking keeps running. |
| Transparent overlay (70 %) | Settings › Appearance, opaque by default (accessibility) |
| App icon | Generated from the logo tile, node 77-1331 (`resources/icon/statheros.icns`) |

**Conflicts, and the smallest change chosen for each:**
- **Floating Hand Preview and toolbar.** Figma draws them as separate movable windows. Here they live inside the panel, because the native helper excludes exactly one window rectangle from pointer input. Extra windows would need new exclusion geometry, which is a safety change.
- **Screen 2 "Head Preview vs Hand Tracking" mismatch.** Not reproduced: the label follows the actual mode.
- **Startup defaults.** The design shows Voice On; the plan requires launching microphone-off, so Voice starts Off. Pen Up and Paused follow the existing engine.
- **Canvas integration.** The Canvas section precedes Actions. Selection controls reuse the 300 × 660 panel frame (temporarily expanded when collapsed); overlays do not own camera or microphone capture. Tracked button registration follows changes between Resume and Pause and expansion of canvas controls.
- **The six-mode vs four-mode question.** Left open for the team to decide. Five modes ship as presets; none invents an algorithm.
