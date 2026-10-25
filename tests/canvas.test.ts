import fixtures from '../fixtures/phase03-v1.json';
import { expect, it } from 'vitest';
import { CanvasCapture, fitWorkspaceSuggestion, intersects, validateCanvas } from '../src/main/canvas';
const display = { x: -1920, y: -200, width: 1920, height: 1080 };
const panel = { x: -336, y: -176, width: 320, height: 560 };
it('captures ordered Quartz logical corners on negative-origin displays and ends paused-ready', () => {
  const capture = new CanvasCapture(); capture.begin();
  expect(capture.mark({ x: -1800, y: -100 }, display, [panel])).toBeNull();
  expect(capture.mark({ x: -700, y: 600 }, display, [panel])).toEqual({ x: -1800, y: -100, width: 1100, height: 700 });
  expect(capture.active).toBe(false); expect(capture.message).toContain('paused');
});
it('rejects reverse, undersized, off-display, nonfinite and panel-overlapping rectangles', () => {
  for (const [first, second] of [[{x:0,y:0},{x:-100,y:100}], [{x:-1800,y:0},{x:-1701,y:100}], [{x:-2000,y:0},{x:-1000,y:100}], [{x:NaN,y:0},{x:-1000,y:100}], [{x:-500,y:0},{x:-100,y:500}]]) expect(() => validateCanvas(first!, second!, display, [panel])).toThrow();
  expect(validateCanvas({x:-1800,y:0},{x:-1700,y:100},display,[panel]).width).toBe(100);
});
it('failed second corner keeps first corner for retry; cancel does not invent a canvas', () => {
  const capture = new CanvasCapture(); expect(() => capture.mark({x:-1800,y:0}, display, [])).toThrow();
  capture.begin(); capture.mark({x:-1800,y:0},display,[]);
  expect(() => capture.mark({x:-1790,y:10},display,[])).toThrow(); expect(capture.active).toBe(true);
  capture.cancel(); expect(capture.firstCorner).toBeNull(); expect(capture.active).toBe(false);
});

it('agrees with shared Phase03 positive/negative canvas fixtures', () => {
  for (const fixture of fixtures.canvas.positive) expect(validateCanvas(fixture.corners[0]!, fixture.corners[1]!, fixture.display, [fixture.panel]), fixture.name).toEqual(fixture.rect);
  for (const fixture of fixtures.canvas.negative) expect(() => validateCanvas(fixture.corners[0]!, fixture.corners[1]!, fixture.display, [fixture.panel]), fixture.name).toThrow();
});

it('fits the fullscreen workspace around the panel before explicit review', () => {
  const screen = { x: 0, y: 0, width: 1512, height: 982 };
  const workspace = { x: 72, y: 30, width: 1172, height: 921 };
  const floatingPanel = { x: 1176, y: 41, width: 320, height: 560 };
  expect(() => validateCanvas(workspace, { x: 1244, y: 951 }, screen, [floatingPanel])).toThrow('panel');
  const fitted = fitWorkspaceSuggestion(workspace, screen, floatingPanel);
  expect(fitted).toEqual({ ...workspace, width: 1104 });
  expect(validateCanvas(fitted, { x: fitted.x + fitted.width, y: fitted.y + fitted.height }, screen, [floatingPanel])).toEqual(fitted);
  expect(workspace.width).toBe(1172);
});

it('selects the largest usable strip for panels on any side in logical coordinates', () => {
  const workspace = { x: -1800, y: -100, width: 1000, height: 800 };
  const panels = [
    {x:-1850,y:0,width:250,height:400}, {x:-1000,y:0,width:250,height:400},
    {x:-1600,y:-150,width:400,height:250}, {x:-1600,y:500,width:400,height:250},
  ];
  const expected = [
    {x:-1600,y:-100,width:800,height:800}, {x:-1800,y:-100,width:800,height:800},
    {x:-1800,y:100,width:1000,height:600}, {x:-1800,y:-100,width:1000,height:600},
  ];
  panels.forEach((obstacle, index) => {
    const fitted = fitWorkspaceSuggestion(workspace, display, obstacle);
    expect(fitted).toEqual(expected[index]); expect(intersects(fitted, obstacle)).toBe(false);
  });
});

it('keeps untouched suggestions and leaves impossible fits visible for manual redraw', () => {
  const workspace = { x: -1800, y: 0, width: 900, height: 600 };
  expect(fitWorkspaceSuggestion(workspace, display, panel)).toEqual(workspace);
  expect(fitWorkspaceSuggestion(workspace, display, null)).toEqual(workspace);
  const covered = { x: -1850, y: -50, width: 1000, height: 700 };
  const fitted = fitWorkspaceSuggestion(workspace, display, covered);
  expect(fitted).toEqual(workspace);
  expect(() => validateCanvas(fitted, {x:-900,y:600}, display, [covered])).toThrow('panel');
  expect(() => fitWorkspaceSuggestion({...workspace, x:-2000},display,null)).toThrow('selected display');
});
