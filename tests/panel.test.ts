import { expect, it } from 'vitest';
import { panelPosition, preferredDisplay } from '../src/main/panel';
import type { DisplayInfo } from '../src/shared/contracts';
const builtIn:DisplayInfo={id:1,bounds:{x:0,y:0,width:1512,height:982},workArea:{x:0,y:25,width:1512,height:920},builtIn:true,primary:true,scaleFactor:2};
const external:DisplayInfo={id:2,bounds:{x:-1920,y:-200,width:1920,height:1080},workArea:{x:-1920,y:-176,width:1920,height:1016},builtIn:false,primary:false,scaleFactor:1};
it('selects built-in by default and retains an explicitly selected external display',()=>{
  expect(preferredDisplay([external,builtIn])?.id).toBe(1);expect(preferredDisplay([external,builtIn],2)?.id).toBe(2);expect(preferredDisplay([builtIn],2)?.id).toBe(1);
});
it('positions with16-point margin in negative-origin logical coordinates without Retina multiplication',()=>{
  expect(panelPosition(external)).toEqual({x:-316,y:-160});expect(panelPosition(builtIn)).toEqual({x:1196,y:41});
});
