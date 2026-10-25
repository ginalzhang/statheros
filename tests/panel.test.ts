import { expect, it } from 'vitest';
import { PANEL_WIDTH, PANEL_HEIGHT, PANEL_COLLAPSED_HEIGHT, SETTINGS_HEIGHT, SETTINGS_WIDTH, UTILITY_SIZE, canvasSelectionControlsFrame, panelPosition, preferredDisplay, sameCanvasSelectionDisplay, previewClearOf, settingsFrame, toastPosition, utilityPosition } from '../src/main/panel';
import type { DisplayInfo } from '../src/shared/contracts';
const builtIn:DisplayInfo={id:1,bounds:{x:0,y:0,width:1512,height:982},workArea:{x:0,y:25,width:1512,height:920},builtIn:true,primary:true,scaleFactor:2};
const external:DisplayInfo={id:2,bounds:{x:-1920,y:-200,width:1920,height:1080},workArea:{x:-1920,y:-176,width:1920,height:1016},builtIn:false,primary:false,scaleFactor:1};
it('selects built-in by default and retains an explicitly selected external display',()=>{
  expect(preferredDisplay([external,builtIn])?.id).toBe(1);expect(preferredDisplay([external,builtIn],2)?.id).toBe(2);expect(preferredDisplay([builtIn],2)?.id).toBe(1);
});
it('positions with16-point margin in negative-origin logical coordinates without Retina multiplication',()=>{
  expect(panelPosition(external)).toEqual({x:-316,y:-160});expect(panelPosition(builtIn)).toEqual({x:1196,y:41});
});

it('keeps selection controls exactly over an expanded floating panel', () => {
  const frame = { ...panelPosition(builtIn), width: PANEL_WIDTH, height: PANEL_HEIGHT };
  expect(canvasSelectionControlsFrame(frame, builtIn)).toEqual(frame);
  const negative = { ...panelPosition(external), width: PANEL_WIDTH, height: PANEL_HEIGHT };
  expect(canvasSelectionControlsFrame(negative, external)).toEqual(negative);
  expect(canvasSelectionControlsFrame(frame, {...builtIn,scaleFactor:1})).toEqual(frame);
});

it('temporarily expands collapsed selection controls at the same origin', () => {
  const frame = { ...panelPosition(builtIn), width: PANEL_WIDTH, height: PANEL_COLLAPSED_HEIGHT };
  expect(canvasSelectionControlsFrame(frame, builtIn)).toEqual({...frame,height:PANEL_HEIGHT});
});

it('keeps selection actions reachable when a panel is clipped or on another display', () => {
  expect(canvasSelectionControlsFrame({x:1450,y:900,width:PANEL_WIDTH,height:PANEL_HEIGHT},builtIn)).toEqual({x:1212,y:322,width:PANEL_WIDTH,height:PANEL_HEIGHT});
  expect(canvasSelectionControlsFrame({x:1400,y:100,width:PANEL_WIDTH,height:PANEL_HEIGHT},external)).toEqual({...panelPosition(external),width:PANEL_WIDTH,height:PANEL_HEIGHT});
  const small = {...builtIn,bounds:{x:-500,y:-300,width:300,height:400},workArea:{x:-500,y:-300,width:300,height:400}};
  expect(canvasSelectionControlsFrame({x:0,y:0,width:320,height:96},small)).toEqual({...small.bounds});
});

it('preserves a selection frame through fullscreen work-area animation but not actual display changes', () => {
  expect(sameCanvasSelectionDisplay(builtIn, {...builtIn,workArea:builtIn.bounds})).toBe(true);
  expect(sameCanvasSelectionDisplay(builtIn, {...builtIn,bounds:{...builtIn.bounds,x:-1512}})).toBe(false);
  expect(sameCanvasSelectionDisplay(builtIn, {...builtIn,scaleFactor:1})).toBe(false);
  expect(sameCanvasSelectionDisplay(builtIn,external)).toBe(false);
  expect(sameCanvasSelectionDisplay(builtIn,undefined)).toBe(false);
});

it('places the Camera Preview, settings modal and notifications at their Figma scene positions', () => {
  const scene = { x: 0, y: 0, width: 1440, height: 900 };
  expect(UTILITY_SIZE).toEqual({ preview: { width: 200, height: 180 } });
  expect(utilityPosition('preview', scene)).toEqual({ x: 238, y: 632 });
  expect(settingsFrame(scene)).toEqual({ x: 180, y: 100, width: SETTINGS_WIDTH, height: SETTINGS_HEIGHT });
  expect(toastPosition(builtIn.workArea)).toEqual({ x: 14, y: 63 });
  // Negative-origin work areas stay in logical points, and the preview does not overlap the default panel.
  const preview = { ...utilityPosition('preview', external.workArea), ...UTILITY_SIZE.preview };
  expect(preview.x).toBeGreaterThanOrEqual(external.workArea.x);
  expect(preview.y + preview.height).toBeLessThanOrEqual(external.workArea.y + external.workArea.height);
  const panel = { ...panelPosition(builtIn), width: PANEL_WIDTH, height: PANEL_HEIGHT };
  const at = { ...utilityPosition('preview', builtIn.workArea), ...UTILITY_SIZE.preview };
  expect(at.x + at.width <= panel.x || at.y >= panel.y + panel.height).toBe(true);
});

it('keeps the settings modal on screen when the work area is small', () => {
  const small = { x: -500, y: -300, width: 700, height: 500 };
  const frame = settingsFrame(small);
  expect(frame).toEqual({ x: -500, y: -300, width: 700, height: 500 });
});

it('moves the Camera Preview to the nearest spot clear of a confirmed canvas and the panel', () => {
  // Real report: canvas 341,132 461×679 on the built-in display; the default preview overlapped it.
  const canvas = { x: 341, y: 132, width: 461, height: 679 };
  const preview = { ...utilityPosition('preview', builtIn.workArea), ...UTILITY_SIZE.preview };
  const panel = { ...panelPosition(builtIn), width: PANEL_WIDTH, height: PANEL_HEIGHT };
  const spot = previewClearOf(preview, canvas, builtIn.workArea, [panel])!;
  expect(spot).toEqual({ x: 133, y: preview.y });
  const moved = { ...spot, ...UTILITY_SIZE.preview };
  const overlaps = (a: typeof moved, b: typeof moved): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlaps(moved, canvas)).toBe(false); expect(overlaps(moved, panel)).toBe(false);
  expect(moved.x).toBeGreaterThanOrEqual(builtIn.workArea.x);
  expect(moved.y + moved.height).toBeLessThanOrEqual(builtIn.workArea.y + builtIn.workArea.height);
});

it('reports no spot when the canvas leaves no room for the Camera Preview', () => {
  const full = { x: 0, y: 25, width: 1512, height: 920 };
  expect(previewClearOf({ x: 250, y: 677, ...UTILITY_SIZE.preview }, full, builtIn.workArea, [])).toBeNull();
});
