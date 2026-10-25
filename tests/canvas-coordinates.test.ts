import { expect, it } from 'vitest';
import { rectangleBetween, screenRectToSurface, surfacePointToScreen } from '../src/shared/canvas-coordinates';

it('keeps highlighted workspace and controls at their screen coordinates when macOS shifts the content origin', () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 };
  const content = { x: 0, y: 33, width: 1512, height: 949 };
  const workspace = { x: 72, y: 69, width: 1172, height: 882 };
  const local = screenRectToSurface(workspace, content);
  expect(local).toEqual({ ...workspace, y: 36 });
  expect(content.y + local.y + local.height).toBe(951);
  expect(surfacePointToScreen(local, content, display)).toEqual({ x: 72, y: 69 });
  expect(screenRectToSurface({ x: 1176, y: 41, width: 320, height: 560 }, content)).toEqual({ x: 1176, y: 8, width: 320, height: 560 });
});

it('uses logical coordinates for surfaces on displays with negative origins and different scale factors', () => {
  for (const scaleFactor of [1, 2]) {
    const display = { bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, scaleFactor };
    const content = { x: -1920, y: -176, width: 1920, height: 1056 };
    const canvas = { x: -1800, y: -100, width: 800, height: 600 };
    const local = screenRectToSurface(canvas, content);
    expect(local).toEqual({ x: 120, y: 76, width: 800, height: 600 });
    expect(surfacePointToScreen(local, content, display.bounds)).toEqual({ x: -1800, y: -100 });
  }
});

it('clamps captured pointer coordinates after converting them into screen space', () => {
  const display = { x: -1920, y: -200, width: 1920, height: 1080 };
  const content = { x: -1920, y: -176, width: 1920, height: 1080 };
  expect(surfacePointToScreen({ x: -50, y: -50 }, content, display)).toEqual({ x: -1920, y: -200 });
  expect(surfacePointToScreen({ x: 2000, y: 1100 }, content, display)).toEqual({ x: 0, y: 880 });
  expect(surfacePointToScreen({ x: 100, y: 1070 }, content, display)).toEqual({ x: -1820, y: 880 });
});

it('previews the same screen rectangle for reversed drags on a shifted surface', () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 };
  const content = { x: 0, y: 33, width: 1512, height: 949 };
  const a = surfacePointToScreen({ x: 100, y: 117 }, content, display);
  const b = surfacePointToScreen({ x: 400, y: 317 }, content, display);
  expect(rectangleBetween(a, b)).toEqual({ x: 100, y: 150, width: 300, height: 200 });
  expect(rectangleBetween(b, a)).toEqual(rectangleBetween(a, b));
  expect(screenRectToSurface(rectangleBetween(b, a), content)).toEqual({ x: 100, y: 117, width: 300, height: 200 });
});
