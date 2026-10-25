import { expect, it } from 'vitest';
import { canvasSelectionControlsFrame, panelPosition, preferredDisplay, sameCanvasSelectionDisplay } from '../src/main/panel';
import type { DisplayInfo } from '../src/shared/contracts';
const builtIn:DisplayInfo={id:1,bounds:{x:0,y:0,width:1512,height:982},workArea:{x:0,y:25,width:1512,height:920},builtIn:true,primary:true,scaleFactor:2};
const external:DisplayInfo={id:2,bounds:{x:-1920,y:-200,width:1920,height:1080},workArea:{x:-1920,y:-176,width:1920,height:1016},builtIn:false,primary:false,scaleFactor:1};
it('selects built-in by default and retains an explicitly selected external display',()=>{
  expect(preferredDisplay([external,builtIn])?.id).toBe(1);expect(preferredDisplay([external,builtIn],2)?.id).toBe(2);expect(preferredDisplay([builtIn],2)?.id).toBe(1);
});
it('positions with16-point margin in negative-origin logical coordinates without Retina multiplication',()=>{
  expect(panelPosition(external)).toEqual({x:-336,y:-160});expect(panelPosition(builtIn)).toEqual({x:1176,y:41});
});

it('keeps selection controls exactly over an expanded floating panel', () => {
  const frame = { ...panelPosition(builtIn), width: 320, height: 560 };
  expect(canvasSelectionControlsFrame(frame, builtIn)).toEqual(frame);
  const negative = { ...panelPosition(external), width: 320, height: 560 };
  expect(canvasSelectionControlsFrame(negative, external)).toEqual(negative);
  expect(canvasSelectionControlsFrame(frame, {...builtIn,scaleFactor:1})).toEqual(frame);
});

it('temporarily expands collapsed selection controls at the same origin', () => {
  const frame = { ...panelPosition(builtIn), width: 320, height: 96 };
  expect(canvasSelectionControlsFrame(frame, builtIn)).toEqual({...frame,height:560});
});

it('keeps selection actions reachable when a panel is clipped or on another display', () => {
  expect(canvasSelectionControlsFrame({x:1450,y:900,width:320,height:560},builtIn)).toEqual({x:1192,y:422,width:320,height:560});
  expect(canvasSelectionControlsFrame({x:1400,y:100,width:320,height:560},external)).toEqual({...panelPosition(external),width:320,height:560});
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
