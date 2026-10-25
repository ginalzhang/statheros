# Figma → Statheros implementation notes

The current source of truth is the **Statheros 2** design: the 35 frames and component library on the "Statheros" page, plus the "Current UI specification" block at the end of the Developer Handoff (node 77-1230). Earlier sections of that handoff and the old "Statheros: Annotations" page are historical. Every control drives existing behavior (no disconnected controls).

## Surfaces

| Surface | Implementation |
|---|---|
| Compact control panel (300 px) | Its own window. The header has the bunny and "Statheros", then **Pause/Play** (`pause` / `resume`), **Tune** (sliders icon, opens Settings), **chevron** (`togglePanel`) and **Close** (quit). The sections are Tracking, Input, Stroke Assistance, Motion Assistance, Voice, Canvas and Actions. |
| Camera Preview (200 × 180) | A separate movable window. It has its own bunny header, the live mirrored preview with landmarks and a status/pen footer. The panel still owns the camera: it draws off-screen and streams JPEG frames over a `BroadcastChannel`. Moving it never moves the panel. |
| Settings modal (~860 × 690) | A frameless window over Krita, next to the panel. It has three tabs: **Motion**, **Voice** and **Appearance**. X closes it without resetting values. Opening it pauses input, as before. |
| Notifications | A click-through window in the upper left. It **replaces the floating toolbar**. |
| Advanced settings | The former settings page, opened from "Advanced settings…" in the modal footer. See the conflicts below. |

The native helper excludes the panel and the Camera Preview (`excludedRects` accepts up to 64), so a stroke that reaches either one lifts the pen. Moving either one pauses input and reconfigures the helper. The notification window is click-through and not excluded, so a toast never changes input geometry.

## State language

Tones are CONNECTED/ACTIVE mint `#95CFBD`, DISCONNECTED/UNAVAILABLE/LOST/FAILED coral `#F0B9B3`, CONNECTING/WAITING blue `#A7DDF0` and USER-PAUSED gray `#A1A9AB`. Dots and pills use these exact fills. Text uses a darker shade of the same hue so labels stay readable. Every state is also named in text.

- Camera: Connected (feed running, detector ready), Connecting (feed started, detector loading) or Disconnected. The preview shows "Camera unavailable".
- Tracking: Active, Paused, Tracking Lost (subject missing; the preview says "Move back into camera view."), Unavailable or Connecting. A camera problem always outranks tracking state.

## Notifications

A success toast appears only after the action resolves. Native actions resolve only on an accepted helper ack, and the bridge rejects otherwise. User-initiated commands from the panel, Settings, global bindings and voice show: Undo, Redo, Switch to Pencil (`brush`), Drawing Paused, Drawing Resumed. Any failure shows **Action Failed** with the reason. **Tracking Lost** comes from real tracking errors: palm-continuity loss in the renderer, or a native `stale-capture` stop while tracking was live.

## Settings tabs

- **Motion:** camera permission (from the helper), Palm/Head, camera source (choosing one starts capture, with connecting/connected/failed feedback and a Connect link), Pen Up/Down, all six stroke modes, smoothing/sensitivity, and the five-step calibration (Hold Still → Left → Right → Up → Down, Start Calibration, then Capture/Cancel while it runs).
- **Voice:** microphone permission, the Voice Commands switch (shows actual capture state), the Cartesia key (masked, Show/Save, stored through the existing secure key store, never read back) and Test Microphone with its result.
- **Appearance:** the Transparency Mode toggle only (70% on the panel and Camera Preview, opaque by default).

## Conflicts, and the smallest change chosen for each

- **"Appearance: Transparency toggle ONLY" vs. operational settings.** The old page holds controls the app needs: enabling real input, recovering the helper, display selection, bindings, the bounded probe, diagnostics, camera orientation and the hand confirmation. Removing them would break drawing. They now live in a separate Advanced window, reached from a small footer link, and stay out of the three tabs.
- **Pen Down inside Settings.** Opening Settings pauses input, and pointer actions are refused while it is open (existing safety rule). Pen Down is therefore shown disabled with a tooltip. Pen Up works.
- **Adaptive.** All six modes are listed, as required. Adaptive has no engine behavior and the handoff forbids inventing one, so it is shown disabled ("not available yet") and is never reported as active.
- **"Switch to Eraser".** Krita's `E` is a toggle and Statheros does not read Krita's tool state, so the toast says "Eraser toggled" instead of claiming which tool is active.
- **Camera auto-start.** The design does not define a startup policy, so capture still starts only when you pick a source (or press Connect).
- **Minimized panel.** It keeps the bunny, title and chevron, plus Pause/Play, so pausing stays one click away while collapsed (F9 also works).

## Drawing and voice integration

The compact panel also shows the “Before you draw” prerequisite checklist and armed Pen Down feedback. Armed input waits until the pointer enters the canvas outside both floating windows. A stroke that moves more than 15 logical points can be lifted by holding within 7.5 points for 1.2 seconds; the former rest/lift controls remain retired. Resume can confirm the matching selected hand without another pause.

Set canvas performs fresh detection, workspace review, or timed mouse-selection fallback. Matching remembered bounds can restore after restart or helper recovery, always paused; explicit setup cancellation suppresses restoration. Voice Commands starts off. When enabled, local command words run on-device and other utterances use Cartesia without a wake phrase. Eraser requests are idempotent relative to shortcuts Steady sent; external changes in Krita are not observable.
