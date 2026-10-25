# Statheros — Design extraction (from public Figma `Fqi4P6I1ifyAsCJr5OB3bz`)

> Extracted from the public Figma file and kept here as the visual reference. Only a few of the referenced screenshots are committed (`screens/`): the main panel, the logo tile, and the implemented panel for comparison. How each control maps onto the engine is in [IMPLEMENTATION.md](IMPLEMENTATION.md).


Extracted 2026-10-24 from the view-only file, logged out. **How the numbers were obtained:** I measured them from screenshots taken at 100% and 200% zoom (Figma pixel grid on), and sampled colors from the rendered pixels. Without logging in, Figma's Inspect/Dev Mode was not available, so font family/weight, radii and shadows are visual estimates (marked "≈"). Hex values were sampled from flat fills, so they are reliable.

Screenshots: `screens/` (panel states), `icons/` (icon set), `logo/`, `handoff/` (doc chunks). The figures below are 1× design px. The `*-panel-2x.png` and `*-utilities-2x.png` files are 200% zoom, so divide their pixel coordinates by 2.

---

## 0. Quick design tokens (companion overlay)

| Token | Hex | Used for |
|---|---|---|
| `surface` | `#FFFEFC` | Panel, Hand Preview, floating toolbar background (warm white) |
| `border / separator` | `#E5E9E5` | 1px panel border, section dividers, hairlines under slider labels, chip borders, toolbar dividers, scroll track |
| `text` | `#292B2C` | All labels, headings, icons in toolbar |
| `text-muted` | `#81878A` | Secondary text ("Pen Up" in preview footer), minimize chevron |
| `status-mint` | `#70B99D` | "Active" / "Connected" / "Paused" status text, status dots, landmark overlay |
| `accent-cyan` | `#69BBD2` | "Recalibrate Tracking" link, slider percentage values |
| `selected-cyan` | `#A7DDF0` | Selected segment (Pen Up/Down), selected stroke chip, slider fill, selected toolbar tool |
| `segment-track` | `#ECEEEE` | Pen Up / Pen Down segmented-control track |
| `slider-track` | `#E4E3E2` | Unfilled slider track |
| `scroll-thumb` | `#A9B0B0` | Stroke-tab horizontal scroll indicator thumb |
| `toggle-on` | `#95CFBD` | Voice switch On track (mint) |
| `toggle-off` | `#C4C4C4` | Voice switch Off track (gray) |
| `danger-soft` | `#F0B9B3` | "Pause Tracking" / "Resume Tracking" button (salmon) |
| `chip-bg` | `#FFFFFF` | Unselected stroke chips |
| `brand-mint` | `#95CFBD` | Bunny head/ears |
| `brand-cream` | `#F6E5BD` | Bunny inner ears |
| `brand-ink` | `#29342F` | Logo zig-zag stroke and dot; icon-set light-mode ink |
| `stroke-preview` | `#111111` | Stroke preview squiggle |

**Typography:** the letterforms match **Inter** (Figma default). Weights and sizes were inferred from cap heights at 2×:
- Panel title "Statheros": ≈20px / semibold 600 (≈ bold 700 in the minimized header).
- Section headings ("Tracking", "Input", "Stroke Assistance", "Motion Assistance", "Voice", "Actions"): ≈13px / semibold 600, `#292B2C`.
- Body/rows ("Hand Tracking", "Camera", "Drawing State", "Tremor Smoothing", "Voice Commands"): ≈12.5px (use 12–13px) / regular 400.
- Status values ("Active", "Connected"): same size, regular, `#70B99D`. "Paused" looks medium 500.
- Segmented control and button labels: ≈13px / regular–medium, centered.
- Chips: ≈13px regular. Percent values: ≈13px regular `#69BBD2`.
- Hand Preview title: ≈13px semibold. Preview footer: ≈12px.

**Scene:** each state frame is a 1440 × 900 Krita screenshot (Krita is only a background reference; do not rebuild it). The overlay has three independent floating surfaces: the **Main Control Panel**, the **Hand Preview widget**, and the **Floating Toolbar**.

Figma layer tree (main frame):
```
Statheros — Krita Overlay / Active Drawing (1440×900)
├─ Statheros Overlay
│  ├─ Statheros Main Control Panel   (auto-layout, 300 × 614.6 "Hug")
│  │  ├─ Header
│  │  ├─ Rectangle (1px separator)
│  │  ├─ Tracking Section
│  │  ├─ Rectangle
│  │  ├─ Input Section
│  │  ├─ Rectangle
│  │  ├─ Stroke Assistance Section
│  │  ├─ Rectangle
│  │  ├─ Motion Assistance Section
│  │  ├─ Rectangle
│  │  ├─ Voice Section
│  │  ├─ Rectangle
│  │  └─ Actions Section
│  └─ Statheros Floating Utilities
│     ├─ Hand Preview Widget
│     └─ Floating Toolbar
└─ Krita Background
```

---

## 1. Main Control Panel (default state: `screens/screen-1-main-active-drawing-panel-2x.png`)

- **Size:** 300 × ~615 px (auto-layout, hug height). **Position in scene:** 32px from the right edge, 32px from the top (x 1108, y 32 in 1440×900).
- **Container:** bg `#FFFEFC`, 1px border `#E5E9E5`, corner radius ≈11–12px, faint soft shadow (≈ `0 4px 16px rgba(0,0,0,.08)`).
- **Horizontal padding:** 16px. Content width is 268px (matches "slider instances 268 px wide").
- **Sections** are stacked and separated by 1px full-width `#E5E9E5` lines. Measured heights:

| Section | Height | Panel y-range |
|---|---|---|
| Header | 52 | 0–52 |
| Tracking | 96 | 52–148 |
| Input | 94 | 148–242 |
| Stroke Assistance | 93 | 242–335 |
| Motion Assistance | 151 | 335–486 |
| Voice | 58.5 | 486–545 |
| Actions | 69 | 545–614 |

### Header (52px)
- Bunny glyph at x16, ≈16×20px: mint `#95CFBD` head, two upright ears, tiny `#292B2C` dot eyes, faint smile.
- Title **"Statheros"** in ≈20px semibold `#292B2C`, 8px right of the glyph, vertically centered.
- The expanded panel shows no chevron. The minimized state shows a chevron-down on the right (see Screen 5).

### Tracking (rows at a 21px pitch)
- Heading **"Tracking"** at top ≈12px inside the section.
- Row: **"Hand Tracking"** (left, `#292B2C`) … **"Active"** (right-aligned, `#70B99D`).
- Row: **"Camera"** … **"Connected"** (`#70B99D`).
- Link: **"Recalibrate Tracking"** (`#69BBD2`, no underline).

### Input
- Heading **"Input"**, then caption **"Drawing State"**.
- **Segmented control:** track 279 × 30.5px at x10 (slightly wider than the content, inset 10px), bg `#ECEEEE`, radius ≈6.
  - Two equal halves: **"Pen Up"** | **"Pen Down"**.
  - Selected half is a pill 137 × 27 (2px inset), bg `#A7DDF0`, radius ≈5.
  - Labels are centered, ≈13px `#292B2C`.

### Stroke Assistance
- Heading **"Stroke Assistance"**.
- **Horizontally scrolling chip row** (clipped at the 268px content edge): chips are 25px tall, radius ≈8, 7px gap, 1px `#E5E9E5` border on `#FFFFFF`. The selected chip is `#A7DDF0` with no visible border.
  - Chip widths: Natural 61, Steady 59, Precision 71, Sketch ≈62, Tremor Filter ≈93, Adaptive ≈70.
  - Source order (six modes): **Natural · Steady · Precision · Sketch · Tremor Filter · Adaptive**. The handoff requires four of them (Natural, Precision, Sketch, Tremor Filter), so the scope still has to be confirmed with developers.
- **Scroll indicator** directly under the chips: track 268 × 1.5px `#E5E9E5`, thumb ≈112px `#A9B0B0`, rounded. It slides with the scroll position: at the left for Natural/Steady, slightly right for Sketch, mid-right for Tremor Filter, fully right for Adaptive.
- **ONE stroke preview row:** a ≈42px-wide black (`#111`) sample stroke at x16 plus the mode name (≈13px) at x≈70. Per-mode preview glyph:
  - Natural: slightly jittery wave.
  - Steady: smooth gentle S-curve.
  - Precision: smooth rising curve (thin).
  - Sketch: tight zig-zag hatching scribble.
  - Tremor Filter: smooth wave (like Steady).
  - Adaptive: bold, thicker sine wave (~3px).

### Motion Assistance
- Heading **"Motion Assistance"**.
- Slider block 1: label row **"Tremor Smoothing"** (left) and **"75%"** (right, `#69BBD2`), with a 1px `#E5E9E5` hairline under the label row.
  - Track: 4px tall, rounded, runs from x26 to x272 (246px; the 268px slider instance has 10px side insets).
  - Fill `#A7DDF0` from the left up to the thumb; the rest is `#E4E3E2`.
  - Thumb: white pill ≈24 × 16, soft shadow `0 1px 3px rgba(0,0,0,.18)`, hairline border.
- Slider block 2: **"Movement Sensitivity"** / **"50%"**, same construction.
- Vertical rhythm: label row ≈20px, hairline, 16px gap, track; about 59px per slider.

### Voice
- Heading **"Voice"**.
- Row: **"Voice Commands"** with a switch on the right.
- Switch: 44 × 20 pill. On = track `#95CFBD` with the white knob (≈16px) on the right. Off = track `#C4C4C4` with the knob on the left.

### Actions
- Heading **"Actions"**.
- Two buttons side by side, each ≈129–130 × 30, radius ≈8, gap ≈9:
  - **"Pause Tracking"**: bg `#F0B9B3`, label `#292B2C`.
  - **"Recalibrate"**: bg `#FFFEFC`, 1px `#E5E9E5` border.

---

## 2. Floating utilities (`screens/*-utilities-2x.png`)

### Hand Preview widget, 200 × 180
- **Position:** frame x238, y632. It sits bottom-left over the canvas, about 88px above the bottom edge.
- **Container:** bg `#FFFEFC`, 1px `#E5E9E5` border, radius ≈10, soft shadow.
- **Header (32px):** **"Hand Preview"**, ≈13px semibold, 12px left padding.
- **Camera image:** 200 × 120, edge to edge. The live feed is overlaid with mint `#70B99D` landmark dots (~4px) joined by 1px mint lines (hand skeleton: wrist, palm and five fingertips).
- **Footer (28px):**
  - Left: mint dot (6px `#70B99D`) + **"Tracking Active"** (≈12px `#292B2C`).
  - A 1px `#E5E9E5` vertical divider.
  - Right: pen status **"Pen Up"** (`#81878A`).

### Floating Toolbar, 386 × 36
- **Position:** frame x453, y800. Bottom-center of the canvas, 64px from the bottom.
- **Container:** bg `#FFFEFC`, 1px `#E5E9E5` border, radius ≈10.
- **Items left to right** (icons ≈18px, `#292B2C`, 1.5px stroke):
  1. Select (cursor arrow)
  2. **Pen** (selected: full-height square cell ≈37 × 34, bg `#A7DDF0`)
  3. Eraser
  4. Steadiness (wave over baseline)
  5. Undo (curved arrow left)
  6. Redo
  7. Microphone (filled mic)
  8. **"AI Assist"** (sparkle/4-point-star icon + ≈13px label)
  9. Status dot (8px `#70B99D`)
- 1px `#E5E9E5` vertical dividers (~17px tall) sit after Select, after Eraser, after Steadiness, after Redo, after Mic and after AI Assist.
- The handoff says unsupported toolbar features must render **disabled** (for example, AI Assist if it is not implemented).

---

## 3. Panel states (all on page "Statheros: Annotations", node 70:312)

Every state is the same 1440×900 scene. Only the differences from the main frame are listed.

| State (Figma node) | File(s) | Differences from main |
|---|---|---|
| **Main / Active Drawing** (70:313; carries a "10" annotation badge) | `screen-1-main-active-drawing-*.png` | Pen Up selected; Hand Tracking Active; Camera Connected; Steady chip; Tremor Smoothing 75%; Movement Sensitivity 50%; Voice On; preview footer "Tracking Active · Pen Up". |
| **Screen 2 / Pen Down** (84:156) | `screen-2-pen-down-*.png` | "Pen Down" segment selected (cyan pill on the right half). Preview footer right text reads **"Pen Down"**. |
| **Screen 3 / Movable Tabs** (70:593) | `screen-3-movable-tabs-full.png` | Same panel contents, but every surface has been dragged to show they are independently movable. Panel at x1099, y258 (mid-right). Hand Preview at x236, y148 (top-left of the canvas). Toolbar at x670, y781 (bottom-center-right). Dragging is by the header/handle. |
| **Screen 4 / Stroke Assistance Scrolled** (70:730) | `screen-4-stroke-assistance-scrolled-*.png` | Chip row scrolled fully right: "…ion", "Sketch", "Tremor Filter", **"Adaptive"** (selected). Scroll thumb at the right end. Preview: bold wave + "Adaptive". |
| **Screen 5 / Minimized Panel** (70:869) | `screen-5-minimized-*.png` | The panel collapses to its **header only: 300 × 47**, same position (x1108, y32), same radius/border. Shows bunny + **"Statheros"** (≈20px bold) + **chevron-down** (≈12px, `#81878A`) at the right, 16px padding. Hand Preview and toolbar stay visible. Collapsing keeps tracking running. |
| **Screen 6 / Transparent Overlay** (70:1008) | `screen-6-transparent-overlay-*.png` | The **entire overlay renders at ≈70% opacity** (panel, Hand Preview, toolbar, icons, camera image), so Krita's dockers show through. Colors are unchanged. The handoff requires a fully opaque accessibility option. |
| **Voice Commands / Off** (84:327) | `voice-commands-off-*.png` | Voice switch **Off**: gray `#C4C4C4` track, knob on the left. Nothing else changes; the toolbar mic icon looks the same. |
| **Tracking / Paused** (84:498) | `tracking-paused-*.png` | Hand Tracking value reads **"Paused"** (mint, slightly heavier). The salmon action button reads **"Resume Tracking"**. Preview footer: **"Tracking Paused · Pen Up"**. Pen is forced to Up. |
| **Input Mode / Head Tracking** (84:669) | `input-mode-head-tracking-*.png` | The tracking row reads **"Head Tracking"** (≈medium weight) … "Active". The preview widget is titled **"Head Preview"** and shows a face webcam image with a mint corner-bracket face box and facial landmark dots/lines. Footer "Tracking Active · Pen Up". |
| **Stroke / Natural** (86:285) | `stroke-natural-*.png` | "Natural" chip selected; preview is a jittery wave + "Natural". |
| **Stroke / Precision** (86:456) | `stroke-precision-*.png` | "Precision" chip selected; smooth thin rising curve + "Precision". |
| **Stroke / Sketch** (86:627) | `stroke-sketch-*.png` | Row scrolled ≈3px; "Sketch" selected; zig-zag hatch scribble + "Sketch". |
| **Stroke / Tremor Filter** (86:798) | `stroke-tremor-filter-*.png` | Row scrolled so "…dy, Precision, Sketch, **Tremor Filter**" show; thumb mid-right; smooth wave + "Tremor Filter". |
| **Smoothing / 0·50·100%** (88:1448 / 88:1619 / 88:1790) | `smoothing-*.png` | Tremor Smoothing thumb at the start, middle or end, and the value text changes ("0%", "50%", "100%"). At 0% the thumb's left edge sits on the track start and there is no cyan fill. These are visual checkpoints only; the slider is continuous. |
| **Sensitivity / 0·75·100%** (88:1961 / 88:2132 / 88:2303) | `sensitivity-*.png` | The same for Movement Sensitivity. |

Notes:
- The numbered green circles ("10" on the main frame, "1" on the others) at each frame's top-right look like Figma annotation markers. Their text only shows in Dev Mode, which needs login, so I could not read it. The Developer Handoff doc summarizes them (section 3, "Annotated overlay behavior").
- The handoff index lists source nodes 16:2 and 61:37 ("Screen 2 / Alternate Settings": Pen Down, Precision, smoothing 40%, sensitivity 70%, Voice Off, Head Preview). **Those nodes no longer exist** in the file; the URL falls back to the logo page. The "Statheros" page holds the same frames as the Annotations page.
- Motion timings from the source annotations: 180 ms for pen/state and stroke selection, 160 ms for voice, 240 ms for collapse. The handoff recommends 150 ms toggles, 180 ms dropdown opening and immediate value changes. Safety actions are always immediate.

---

## 4. Icon set ("Steady — Krita icon set", Page 1, node 9:2): `icons/`

- **Sheet:** 1200 × 1040, bg `#FBFAF6`.
  - Eyebrow "STEADY / KRITA PLUGIN" (≈12px medium caps, `#526159`).
  - Title **"Less shake. More expression."** (≈40px semibold, `#29342F`).
  - Subtitle "A quiet, confident icon family for painting without holding a pen." (≈16px, `#526159`).
  - Spec, top right: "16 / 22 / 32 px" / "1.5 px stroke at 22".
  - Footer: "One gesture, resolved. No grip required." (left); "24 SVG assets · Rounded caps & joins · Monochrome UI" (right).
- **Light panel:** 540 × 760, radius 16, bg `#E8E7E4`, ink `#29342F`. Labels: "LIGHT PANEL" / "light_steady.svg".
- **Dark panel:** same size, bg `#303236`, ink `#F4F5F0`. Labels: "DARK PANEL" / "dark_steady.svg".
- Panel text colors: label text `#526159` (light) / `#B9C2BC` (dark). Divider `#CBD0C9` (light) / `#4D5350` (dark).
- **Panel contents, top to bottom:**
  - Hero "steady" mark at 128px.
  - Size row: the same mark at **16 px / 22 px / 32 px**.
  - Divider.
  - "ACTIONS / 22 PX" grid, 3 × 3: **Pen · up, Pen · down, Latch / Pause tracking, Recenter, Steadiness / Mic · off, Mic · on, Calibrate**.
  - Legend: "Hollow = up / off · Filled = down / on".
- **Drawing rules:** 22px grid, **1.5px stroke, round caps and round joins**, monochrome `currentColor`. Hollow (outline) means up/off; filled means down/on.

Below, each icon is redrawn on a **24 × 24 viewBox**: the content is centered, there is about 1px of padding relative to the original 22px frame, and stroke-width is 1.5. All shapes use `fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"` unless marked `fill`. I traced them from 800% zooms (`icons/light-*.png`). They are close approximations, so compare against the PNGs.

```svg
<!-- Pen · up (hollow): nib outline pointing lower-left, short handle to upper-right, baseline -->
<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M11.5 4.8 L17.3 10.2 L11.3 16 C9.5 17.7 6.6 17.1 5.8 15 C5.3 13.6 5.7 11.9 6.7 10.5 Z"/>
  <path d="M14.6 7.1 L18.4 3.6"/>
  <path d="M5.3 19.9 H12.4"/></g></svg>

<!-- Pen · down (filled): same nib filled, same handle + baseline -->
<svg viewBox="0 0 24 24"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path fill="currentColor" d="M11.5 4.8 L17.3 10.2 L11.3 16 C9.5 17.7 6.6 17.1 5.8 15 C5.3 13.6 5.7 11.9 6.7 10.5 Z"/>
  <path fill="none" d="M14.6 7.1 L18.4 3.6"/>
  <path fill="none" d="M5.3 19.9 H12.4"/></g></svg>

<!-- Latch: smaller hollow nib at upper-left + padlock at lower-right -->
<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9.4 4 L13.6 8 L8.9 12.4 C7.6 13.6 5.4 13.2 4.7 11.6 C4.3 10.6 4.6 9.3 5.4 8.3 Z"/>
  <path d="M11.9 5.6 L14.6 3.4"/>
  <rect x="12.9" y="14.9" width="7.4" height="5.6" rx="1.5"/>
  <path d="M15 14.9 V11.6 A1.75 1.75 0 0 1 18.5 11.6 V14.9"/></g></svg>

<!-- Pause tracking: raised open hand (4 fingers + thumb, outline) + two pause bars at lower-right -->
<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5.4 12.2 L3.6 10.6 C2.9 10 3.2 8.9 4.1 8.9 C4.6 8.9 5 9.2 5.4 9.6 L6.1 10.3 V5.5 C6.1 4.8 6.6 4.3 7.2 4.3 C7.8 4.3 8.3 4.8 8.3 5.5 V9.2 V3.9 C8.3 3.2 8.8 2.8 9.4 2.8 C10 2.8 10.5 3.2 10.5 3.9 V9.2 V4.5 C10.5 3.8 11 3.4 11.6 3.4 C12.2 3.4 12.7 3.8 12.7 4.5 V9.4 V6.3 C12.7 5.7 13.2 5.2 13.8 5.2 C14.4 5.2 14.9 5.7 14.9 6.3 V12 C14.9 13 14.6 13.9 14 14.7 L12.9 16.2 V19.6 H6.6 V16.4 C6.6 15.7 6.3 15.1 5.9 14.6 Z"/>
  <path d="M17.4 15.2 V21"/><path d="M20.7 15.2 V21"/></g></svg>

<!-- Recenter: rounded square + 4-arm crosshair with center gap + center dot -->
<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="4" y="4" width="16" height="16" rx="3.5"/>
  <path d="M12 7 V10"/><path d="M12 14 V17"/><path d="M7 12 H10"/><path d="M14 12 H17"/></g>
  <circle cx="12" cy="12" r="1.1" fill="currentColor"/></svg>

<!-- Steadiness: small irregular wave above a long baseline (also used in the floating toolbar) -->
<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.2 9.6 C5.2 7.9 6.4 8.4 7.4 9.9 C8.6 11.8 9.9 12 11 9.6 C12 7.2 13 5.6 14.2 6.2 C15.6 6.9 16.4 9.6 17.2 11.4 C17.9 13 19.2 13.3 20 9.9"/>
  <path d="M4 17.8 H20"/></g></svg>

<!-- Mic · off (hollow capsule) -->
<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="3.5" width="6" height="11" rx="3"/>
  <path d="M6 10.3 V11 A6 6 0 0 0 18 11 V10.3"/>
  <path d="M12 17 V20.3"/><path d="M9 20.3 H15"/></g></svg>

<!-- Mic · on (filled capsule) -->
<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="3.5" width="6" height="11" rx="3" fill="currentColor"/>
  <path d="M6 10.3 V11 A6 6 0 0 0 18 11 V10.3"/>
  <path d="M12 17 V20.3"/><path d="M9 20.3 H15"/></g></svg>

<!-- Calibrate: ~300° clockwise circular arrow, open at the upper-right, right-angle arrowhead at the top end, center dot -->
<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M19.9 14.2 A7 7 0 1 1 16.4 6.3"/>
  <path d="M17.9 3.4 V7.4 H13.9"/></g>
  <circle cx="12" cy="12.6" r="1.4" fill="currentColor"/></svg>
```

**Hero "steady" mark** (`icons/hero-light-400pct.png`). This is the same motif as the logo: a zig-zag "shaky" stroke that resolves into a smooth curve ending in a solid dot. Measured on a 116 × 62 box:
```svg
<svg viewBox="0 0 116 62"><g fill="none" stroke="currentColor" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.5 50.5 L13.3 32.3 L25 57.3 L34.5 32.3 L49 44.5 C53 47.5 56 45 59 38 C64 26 72 14 86 11.5"/></g>
  <circle cx="101" cy="15" r="15" fill="currentColor"/></svg>
```
At 16/22/32 px the mark renders at 14×9, 20×11 and 28×15 px of content respectively.

---

## 5. Logo tile ("Steady — 512 px tile", node 77:1331, page "Statheros: Logo"): `logo/logo-tile-512-100pct.png`

- **Tile:** 512 × 512, bg `#FBFAF6`, corner radius ≈104px (≈20%, squircle-like). No border.
- **Bunny head:** ellipse ≈198 × 160, center (249, 244), fill `#95CFBD`.
- **Ears:** two tall rounded ellipses ≈66 × 140, behind the head, tops at y59; left ear x173–239, right ear x260–325. Both lean slightly outward.
- **Inner ears:** ≈22 × 81 cream `#F6E5BD` ellipses (x190–211 and x288–309, y87–168).
- **Eyes:** `#292B2C` circles ⌀15 at (209, 244) and (289, 244).
- **Smile:** a small `#292B2C` arc ≈17px wide, ~1.5px stroke, centered at (251, 271).
- **Zig-zag stroke:** `#29342F`, ≈26px wide, round caps/joins.
  - It starts at lower-left (≈48, 318), peaks at (≈85, 240), dips to (≈128, 325) and rises behind the head's left edge.
  - It re-emerges at the head's right side (≈316, 185) and curves up into a solid `#29342F` **circle**, center (405, 177), r≈54.
  - Meaning: shaky input becomes a steady dot. Same motif as the hero icon.
- **Wordmark:** "Statheros", `#292B2C`, Inter Bold (≈700) at ≈76px. Ink spans x71–440, y384–441 and is centered horizontally (baseline ≈441).
- **Alternate tile** on Page 1 (node 9:139), `logo/logo-tile-alt-green-page1.png`: the same 512 tile with no bunny and no wordmark. The zig-zag is `#29342F`, the smooth tail and dot turn green `#178A3C` (dot center ≈(398, 222), r≈52).
- The small bunny glyph in the panel header is this bunny head at ~16×20.

---

## 6. Developer Handoff, full transcription (page "Statheros: Developer Handoff", node 77:1230)

Doc styling, observed:
- Page: white, 1440 wide, Inter.
- Section number badges: `#D1EDF5` rounded squares with teal `#24677B` numerals. Section titles ≈24px semibold `#292B2C`. Teal caps eyebrows `#24677B`.
- Callouts: teal = bg `#EEF8FB` with a 3px `#24677B` left border; amber "VERIFY" = bg `#FFF8EE` with a `#795323` left border and title.
- Table headers: bg `#EEF8FB`, teal text. Rows alternate white / `#F6F9FA`.
- Screenshots of the doc: `handoff/handoff-01..08.png`.

<!-- Header strip: small bunny logo (mint) + "STATHEROS / ENGINEERING DOCUMENTATION" (left, teal caps, ~11px) ... "ONE APPLICATION · EIGHT SECTIONS" (right, gray caps). Teal rule (2px, ~#7CC3D0) underneath full width. -->

# STATHEROS — DEVELOPER HANDOFF

*Interface Specifications, Component Behavior, Interaction States & Implementation Requirements*

| IMPLEMENTATION SCOPE | READ BEFORE IMPLEMENTING |
|---|---|
| Accessible drawing overlay for Krita. Preserve the existing engine and integration. | Figma evidence is not runtime verification. Open conflicts are explicitly marked for developer review. |

---

## 01 Product overview
`CONTEXT / OBSERVED DESIGN`

Application: Statheros.

### Purpose
An accessible drawing application designed for artists experiencing hand pain, arthritis, carpal tunnel syndrome, or difficulties gripping traditional drawing tools.

### Core functionality
Statheros uses computer vision to translate natural hand movements into digital drawing input without requiring users to grip a pen or stylus. The application provides an overlay for Krita, allowing users to configure movement tracking, stroke stabilization, sensitivity, and voice-controlled interactions.

> **IMPORTANT — OVERLAY, NOT A REPLACEMENT DRAWING INTERFACE**
> Statheros is an overlay that interacts with Krita. Do NOT recreate Krita's drawing interface. The six source screens are states of ONE app; Krita is a visual reference only. Preserve the existing engine.

### Evidence legend
| OBSERVED DESIGN | REQUIRED BEHAVIOR | RECOMMENDED | VERIFY WITH DEVELOPERS |
|---|---|---|---|
| Visible Figma values and annotations; not proof of runtime behavior. | Expected functional and safety behavior to implement and verify. | Implementation guidance; not measured performance or a verified requirement. | Unresolved scope, architecture, defaults or platform support. |

### Reference anatomy
The white floating settings panel contains the bunny logo and title; Tracking with Hand Tracking / Active, Camera / Connected and Recalibrate Tracking; Input with Drawing State segments; Stroke Assistance with horizontally scrolling tabs and ONE stroke preview; Motion Assistance with Tremor Smoothing and Movement Sensitivity; a Voice switch; and Actions with Pause Tracking and Recalibrate.

Observed visual language: cyan selected states and slider fill, light gray tracks and separators, dark labels, mint active voice/status and a salmon pause action. The camera preview and floating toolbar are separate overlay utilities. Unsupported toolbar features must be disabled, not nonfunctional active controls.

Observed dimensions only: settings sections 300 px wide, slider instances 268 px wide, scene 1440 × 900 px. These are reference measurements, not a mandatory runtime viewport or evidence of accessible target size.

### Compact reference / state index
Read-only source pointers, not duplicated screens. Main visual values are reference defaults only; runtime startup and saved defaults are unknown.

| Reference / state name | Figma node ID | Evidence / reading note |
|---|---|---|
| Main / active drawing | 16:2 | Pen Up; Hand Tracking Active; Camera Connected; Voice On; Steady; smoothing 75%; sensitivity 50%. |
| Screen 2 / Alternate Settings | 61:37 | Pen Down; Precision; smoothing 40%; sensitivity 70%; Voice Off. Head Preview / Hand Tracking row mismatch: verify. |
| Screen 3 / Movable Tabs | 61:179 | Repositioned settings panel, camera preview and floating toolbar. |
| Screen 4 / Stroke Assistance Scrolled | 61:321 | Horizontal stroke tabs scrolled to Adaptive; one selected preview. |
| Screen 5 / Minimized Panel | 65:97 | Logo, title and expand chevron remain visible. |
| Screen 6 / Transparent Overlay | 65:239 | Approximately 70% opacity across the entire overlay. |
| Annotations / main reference | 70:313 | Annotation context: page 70:312; states belong to one application. |
| Screen 2 / Pen Down | 84:156 | Pen Down selection and matching preview status. |
| Voice Commands / Off | 84:327 | Voice recognition switch shown Off. |
| Tracking / Paused | 84:498 | Paused; Resume Tracking; Pen Up. |
| Input Mode / Head Tracking | 84:669 | Head Preview and Head Tracking row agree. |
| Stroke / Natural; Precision | 86:285; 86:456 | Named visual state references for required stroke modes. |
| Stroke / Sketch; Tremor Filter | 86:627; 86:798 | Named visual state references for required stroke modes. |
| Smoothing / 0%; 50%; 100% | 88:1448; 88:1619; 88:1790 | Visual checkpoints only; not three discrete settings. |
| Sensitivity / 0%; 75%; 100% | 88:1961; 88:2132; 88:2303 | Visual checkpoints only; not three discrete settings. |

---

## 02 Control specifications
`REQUIRED BEHAVIOR / OBSERVED VISUAL FEEDBACK`

Controls must remain synchronized with the application's actual runtime state. A visual selection is not an acceptable substitute for its intended behavior.

> **VERIFY WITH DEVELOPERS — FOUR REQUIRED MODES VS SIX SOURCE MODES** *(amber callout)*
> The source includes Natural, Steady, Precision, Sketch, Tremor Filter and Adaptive; the main design selects Steady. This handoff requires Natural, Precision, Sketch and Tremor Filter. Confirm four-vs-six scope and the Steady default mapping before removing or renaming modes. Preserve the current implementation until resolved. Do NOT invent Steady or Adaptive algorithms.

| Control | Possible States | Expected Behavior | Visual Feedback |
|---|---|---|---|
| Pen Control | Pen Up / Pen Down | Up: tracked movement controls the cursor without drawing. Immediately release any held drawing input. Down: movement creates drawing strokes, only with active, safe tracking. | Distinguishable cyan selected segment and a matching drawing-state status. |
| Voice Commands | On / Off | On enables supported speech commands; Off disables recognition. Manual controls remain available. Vocabulary and platform support: VERIFY WITH DEVELOPERS. | Show actual activation state, not only the requested state. Source: mint On / gray Off. |
| Tracking | Active / Paused | Active processes movement. Paused stops movement-driven cursor and drawing immediately, releases held input and preserves current settings. Never wait for animation. | Synchronize tracking status, camera preview status and Pause Tracking / Resume Tracking action. |
| Input Mode | Hand Tracking / Head Tracking | Switch the active tracking method without page reload; preserve other settings. Head Tracking is an alternative accessibility option. | Correct selected tracking row and corresponding Hand Preview / Head Preview. Do not reproduce the Screen 2 label inconsistency. |
| Stroke Mode | Required: Natural / Precision / Sketch / Tremor Filter | Natural: minimal correction. Precision: smooth, controlled strokes. Sketch: quick, responsive movements. Tremor Filter: filter small unwanted oscillations while preserving intended strokes. Real supported processing must change, not the label alone. Unsupported algorithms: VERIFY WITH DEVELOPERS. | Highlight the selected tab and update ONE preview. Source has six modes; resolve the scope conflict above before removal or rename. |
| Smoothing Slider | Continuous 0–100% — NOT three settings | 0% means minimal additional smoothing; 100% means maximum available smoothing. Dragging immediately updates the percentage and the actual stabilization setting. | Percentage updates as the thumb moves. Source 0 / 50 / 100% states are visual checkpoints only; main shows 75%. |
| Sensitivity Slider | Continuous 0–100% — NOT three settings | Controls the strength of tracked movement-to-cursor mapping. Higher generally means more cursor travel for the same tracked motion, subject to calibration. Dragging updates the percentage and actual setting. | Percentage and thumb reflect the current setting. Source 0 / 75 / 100% states are checkpoints only; main shows 50%. |

> **VERIFY WITH DEVELOPERS — SENSITIVITY MAPPING** *(teal callout)*
> Confirm zero-value mapping, step size, rounding and gain curve against the existing engine and calibration. Do not assert that sensitivity 0% freezes input. The source checkpoints do not define an algorithm or a discrete-only range.

### Default evidence table
OBSERVED DESIGN — values visible in main node 16:2, not verified runtime startup defaults.

| Control / status | Main visual value | Runtime startup / saved default |
|---|---|---|
| Pen Control | Pen Up | VERIFY WITH DEVELOPERS |
| Voice Commands | On | VERIFY WITH DEVELOPERS |
| Tracking | Active | VERIFY WITH DEVELOPERS |
| Camera | Connected | Actual feed / connection must determine status. |
| Input Mode | Hand Tracking | VERIFY WITH DEVELOPERS |
| Tremor Smoothing | 75% | VERIFY WITH DEVELOPERS |
| Movement Sensitivity | 50% | VERIFY WITH DEVELOPERS |
| Stroke Mode | Steady — scope conflict | VERIFY WITH DEVELOPERS: mapping to required four-mode scope. |

Do not infer startup or saved settings from a Figma state. Inspect existing initialization and persistence behavior, resolve conflicts with developers, and document the confirmed defaults.

---

## 03 Interaction & animation specifications
`RECOMMENDED MOTION / REQUIRED SAFETY BEHAVIOR`

The timings below are implementation recommendations, NOT measured requirements or claims about current performance. Use subtle, consistent motion; avoid unnecessary animation and respect reduced motion.

| Interaction | Suggested behavior |
|---|---|
| Toggle changes | 150 ms ease-out. |
| Dropdown opening | 180 ms ease-out. |
| Dropdown selection | Immediate value change. |
| Slider dragging | Continuous, immediate feedback. |
| Slider percentage | Updates as the thumb moves. |
| Settings scrolling | Scroll within the settings panel only. |
| Input-mode switching | Update selected state without page reload. |
| Tracking pause | Immediately stop movement-driven input. |
| Stroke-mode switching | Apply the selected mode without restarting the interface. |
| Settings panel | Maintain position and layout when controls change. |

> **VERIFY WITH DEVELOPERS — SOURCE AND RECOMMENDED TIMINGS DIFFER** *(amber callout)*
> Source annotations specify 180 ms for pen/state and stroke selection, 160 ms for voice, and 240 ms for collapse. The requested recommendation table uses 150 ms toggles, 180 ms dropdown opening and immediate dropdown value changes. Resolve the timing policy with developers; these values are not measured timing claims. Pen Up, tracking pause and all other safety operations are always immediate and never wait for visual animation.

Do not animate drawing strokes in a way that introduces lag. Settings changes must not trigger a full-interface reload or unnecessary restarts. Horizontal stroke-tab scrolling is distinct from settings-panel scrolling; scrolling the settings panel must not move Krita.

### Annotated overlay behavior
| Interaction / surface | Required behavior from annotations |
|---|---|
| Camera preview & status | Show the real active camera feed and actual tracking/connection status. Camera disconnection automatically updates the preview and status; never leave a false Connected or Active indicator. |
| Header dragging / movable panels | Dragging begins immediately through the header, stays within screen bounds and never causes drawing. Preserve panel settings and keep movable overlay utilities separate from Krita. |
| Collapse / expand | Collapse preserves tracking and current settings. The minimized header retains the bunny logo, Statheros title and expand chevron. Expanding restores the controls without resetting their values. |
| Transparent overlay | The annotated state is approximately 70% opacity across the entire overlay, including icons and camera preview. Preserve source colors. Provide a fully opaque accessibility option. |
| Unsupported toolbar features | Render unsupported features as disabled. Do not present visually active controls that do nothing or imply unsupported implemented capabilities. |

> **SAFETY TAKES PRIORITY OVER MOTION** *(teal callout)*
> Pen Up immediately releases held drawing input. Pen Down is permitted only with active, safe tracking. Pause Tracking immediately stops movement-driven cursor and drawing input and releases any held drawing input, regardless of animation duration.

---

## 04 Application states & error handling
`EXPECTED IMPLEMENTATION BEHAVIOR / NOT VERIFIED ERROR DESIGNS`

The following feedback and recovery requirements describe expected implementation behavior, not verified existing error designs. Proposed recovery and error wording is not a claim of current implementation.

> **SAFETY PRINCIPLE — PREVENT UNINTENDED DRAWING** *(teal callout)*
> Whenever tracking is unavailable, release held input and prevent unintended drawing or surprise re-arming. Safety operations are immediate. Valid tracking must be established before drawing can be deliberately re-armed.

| State | User feedback | Drawing input | Recovery |
|---|---|---|---|
| Camera permission denied | Clear explanation of camera access and why tracking is unavailable. | STOP drawing and release held input. | Grant OS/app camera permissions and retry. |
| Webcam disconnected | Disconnected status; preview unavailable. Automatically update connection feedback. | STOP movement and drawing; release held input. | Reconnect or select a compatible camera, verify the active feed, recalibrate and deliberately resume safely. |
| No hand detected | No-hand guidance in Hand Tracking mode. In Head Tracking mode, require a valid head rather than a hand. | STOP drawing and release held input when the active tracking target is invalid. | Place the hand in camera view, verify detection and explicitly re-arm safely. In Head mode, verify valid head detection. |
| Tracking temporarily lost | Tracking-lost status; no stale-coordinate updates. | STOP drawing and release held input. Never bridge old and new points into an unintended stroke. | Reacquire tracking; recalibrate as needed. Require deliberate safe resume. |
| Head Tracking unavailable | Clear unavailable explanation. No false Active state and no silent fallback to another input mode. | STOP drawing and release held input. | Select available Hand Tracking or restore head-tracking capability. |
| Voice recognition fails / unavailable | Error or unavailable indicator. Manual and keyboard controls remain available. | Valid, safe tracked drawing need not stop solely because voice fails. Never execute uncertain speech. | Retry the relevant permission/service, or keep Voice Commands Off. |
| Tracking paused | Paused status and Resume Tracking action; synchronized preview/status. | STOP movement and drawing; release held input. Preserve settings. | Resume only with valid tracking. |
| Krita disconnected / not responding | Clear connection feedback; no false success. | STOP sending drawing input; release where possible. Do not replay stale queued strokes. | Reconnect or reopen the integration and verify Krita responds before deliberate safe resume. |
| Settings closes / reopens | Restore consistent runtime values. Visibility alone must not silently change tracking. | Collapse explicitly preserves tracking. Under uncertain close policy, release the pen safely; never auto-start drawing on reopen. | Close/background policy and cross-session persistence: VERIFY WITH DEVELOPERS. Reopen with consistent runtime values and a safe drawing state. |

---

## 05 Accessibility requirements
`REQUIRED BEHAVIOR / GRIP-FREE PRIMARY GOAL`

Statheros must remain usable for people with varied movement capabilities. The primary goal is drawing without gripping a pen or stylus; avoid repeated pinching, gripping or sustained arm elevation.

- **Readable, high-contrast interface** — Provide high contrast, readable text, clear labels for every setting and large interaction targets. Selected, disabled and focus states must be visible and must not rely on color alone.
- **Keyboard accessibility where applicable** — Use a logical focus order. Make toggles, input modes, stroke modes, sliders and tracking pause accessible without a mandatory gesture. Keep focus states clear throughout the overlay.
- **Reduced motion** — Respect reduced-motion preferences and avoid unnecessary animation. Motion must never delay a safety operation or introduce lag into drawing input.
- **Multiple ways to operate** — Supported voice commands are an alternative to the manual interface, not a replacement for it. Manual controls remain available when recognition is Off, fails or is unavailable.
- **Adaptable movement & visibility** — Provide configurable sensitivity for varied capabilities. Offer a fully opaque option for the transparent overlay so underlying Krita content does not compromise readability.

> **VERIFY WITH DEVELOPERS — ACCESSIBILITY VALIDATION CRITERIA** *(teal callout)*
> Tiny observed source controls are not proof of sufficient accessible target size. Confirm exact interaction targets and contrast-compliance criteria with developers rather than inventing mandates or claiming compliance. Validate that the grip-free goal is preserved in real use.

---

## 06 Technical implementation notes
`IMPLEMENTATION BOUNDARIES / DEVELOPER VERIFICATION`

Figma was inspected. A GitHub repository was not provided or inspected. No framework, library, API, transport, algorithm or implemented capability is inferred from these designs. Inspect the existing codebase and preserve its architecture.

| Area | Implementation requirement | Verification / boundary |
|---|---|---|
| Camera Input | Capture video from the selected camera. Handle permissions, interruptions and compatible Desk View / external camera setups. | Compatibility matrix: VERIFY WITH DEVELOPERS. Show the actual active feed and connection status. |
| Hand Tracking | Detect relevant landmarks, calibrate fingertip-to-screen coordinates and stabilize noisy input. | Existing engine, landmark set, calibration and algorithm: VERIFY WITH DEVELOPERS. Do not prescribe a new engine. |
| Head Tracking | Provide an alternative tracking method; preserve control preferences where practical. | Availability and supported capability: VERIFY WITH DEVELOPERS. Never imply false Active or silently fall back. |
| Stroke Processing | Four required distinct modes: Natural, Precision, Sketch and Tremor Filter. Wire smoothing to real processing and resolve the six-mode source conflict. | No invented algorithm. Confirm existing processing and Steady / Adaptive scope before removal or rename. |
| Krita Integration | Use the existing application integration to send drawing/cursor input. Keep the overlay separate; do NOT rebuild Krita. | Transport / API: VERIFY WITH DEVELOPERS. Preserve the existing integration and verify response. |
| Voice Recognition | Supported commands trigger real application actions. Keep recognition synchronized with On / Off and show actual activation. | Engine, vocabulary, platform support and permissions: VERIFY WITH DEVELOPERS. Never execute uncertain speech. |
| State Management | Keep runtime and display synchronized; apply changes without unnecessary restarts. Preserve in-session settings across relevant UI states. | Cross-session persistence: VERIFY WITH DEVELOPERS. Document the confirmed policy once established. |

### Verification register
VERIFY WITH DEVELOPERS — resolve these points against the codebase before changing scope or treating visual reference values as runtime requirements.

| Open decision | Evidence / conflict | Required resolution |
|---|---|---|
| Stroke scope & default mapping | Six source modes; four requested modes; main selects Steady. | Confirm four-vs-six scope and Steady default mapping. Preserve implementation pending agreement. |
| Screen 2 tracking labels | 61:37 shows Head Preview but Hand Tracking in settings. | Confirm intended mode and synchronize row + preview; do not implement the inconsistency. |
| Motion timing | Source: pen/stroke 180 ms, voice 160 ms, collapse 240 ms. Recommendation: toggle 150 ms; dropdown 180 ms / immediate value. | Agree the visual timing policy; safety operations remain immediate. No measured performance claim. |
| Defaults, persistence & visibility | Startup and saved defaults unknown. Collapse preserves tracking; close/background policy unresolved. | Confirm initialization, in-session restoration, cross-session persistence and close policy; never auto-start drawing on reopen. |
| Voice, camera & calibration | Vocabulary, platform support, camera compatibility and calibration details not verified. | Confirm engine/permissions, supported commands, camera matrix, calibration and head-tracking availability. |
| Slider mapping & accessibility | Continuous ranges required; exact step/rounding/gain curve, targets and contrast criteria unresolved. | Confirm zero mapping without assuming frozen input; agree accessible targets and validation criteria. |

> **RECOMMENDED CHANGE STRATEGY — PRESERVE THE EXISTING ARCHITECTURE** *(teal callout)*
> Prefer the smallest architecture-preserving changes that connect documented controls to existing tracking, stroke processing, voice and Krita behavior. Report conflicts before replacing working systems or inventing unsupported features.

---

## 07 Developer acceptance checklist
`UNTESTED / ALL ITEMS UNCHECKED`

Use this editable checklist during implementation and validation. No item below is marked tested or passed.

- [ ] Interface visually matches the Figma main design.
- [ ] Pen Up and Pen Down perform their intended actions.
- [ ] Tracking can pause and resume.
- [ ] Voice recognition can be enabled and disabled.
- [ ] Hand and head input modes can be selected.
- [ ] All four stroke modes have distinct implemented behavior.
- [ ] Smoothing and sensitivity sliders accept continuous values.
- [ ] Slider changes update application settings.
- [ ] The control panel scrolls without moving Krita.
- [ ] User settings remain consistent across relevant UI states.
- [ ] Appropriate feedback appears for tracking and camera errors.
- [ ] Accessibility settings remain usable.
- [ ] The existing Krita integration remains functional.

> **SCOPE DEPENDENCY** *(teal callout)*
> The four-mode acceptance item must be evaluated after developers resolve the source six-mode conflict and Steady default mapping. This checklist does not authorize removing existing modes before that decision.

---

## 08 Design-to-code handoff notes
`IMPLEMENTATION INSTRUCTIONS`

### Instructions for Claude Code / Developers
01. Use the existing Statheros Figma designs as the visual source of truth and the GitHub repository as the implementation source of truth.
02. Inspect the existing codebase before making changes.
03. Implement reusable interactive components rather than treating each Figma state as a separate page.
04. Follow the documented control behavior and state transitions.
05. Preserve existing webcam tracking, stroke processing, voice control, and Krita integration wherever possible.
06. Do not recreate Krita.
07. Do not implement visually interactive controls that are disconnected from their intended application behavior.
08. If a specification conflicts with the actual application architecture, report the conflict and recommend the smallest viable change.
09. Prioritize functional accuracy, accessibility, and visual consistency over decorative animation.

*Footer:* `STATHEROS / DEVELOPER HANDOFF` (left, teal caps) · "Design evidence + implementation requirements · Not a test report" (right, gray).
