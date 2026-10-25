import { expect, it } from 'vitest';
import { CanvasDiagnostics } from '../src/main/canvas-diagnostics';
import type { CanvasObservation } from '../src/shared/contracts';

const observation: CanvasObservation = {
  generation:1,targetPid:123,windowId:'cg:123:7',windowBounds:{x:0,y:0,width:1200,height:900},windowToken:'hashed-document',layoutToken:null,
  availability:'unavailable',rect:null,kind:null,reason:'No identifiable viewport',observedAt:100,
  workspaceSuggestion:null,
  diagnostics:{inspected:117,complete:true,truncated:false,windowSource:'ax',nodes:[{path:'0',role:'AXWindow',subrole:'AXStandardWindow',identifier:null,bounds:{x:0,y:0,width:1200,height:900},childCount:4}]},
};

it('bounds in-memory history and retains structural diagnostics only on the current observation',()=>{
  const recorder = new CanvasDiagnostics();
  for(let index=0;index<20;index++) recorder.observe({...observation,observedAt:100+index});
  const report = recorder.snapshot();
  expect(report.history).toHaveLength(8); expect(report.history[0]?.observedAt).toBe(112);
  expect(report.history.every(item=>!('diagnostics' in item))).toBe(true);
  expect(report.current?.diagnostics?.inspected).toBe(117);
  report.current!.windowBounds!.width=1; report.history.length=0;
  expect(recorder.snapshot().current?.windowBounds?.width).toBe(1200); expect(recorder.snapshot().history).toHaveLength(8);
});

it('retains the invalidating fields and baseline after later observations arrive',()=>{
  const recorder = new CanvasDiagnostics(); recorder.observe(observation);
  const {diagnostics: _diagnostics,...baseline}=observation;
  const current={...observation,windowBounds:{...observation.windowBounds!,width:900},observedAt:200};
  recorder.invalidated('Krita window moved or resized.',['window-bounds'],baseline,current);
  recorder.observe({...current,observedAt:300});
  expect(recorder.snapshot().lastInvalidation).toMatchObject({changed:['window-bounds'],previous:{windowBounds:{width:1200}},current:{windowBounds:{width:900},observedAt:200}});
  expect(recorder.snapshot().lastInvalidation?.current).not.toHaveProperty('diagnostics');
});

it('records actual persistent-panel overlap separately from temporary controls geometry',()=>{
  const recorder = new CanvasDiagnostics();
  const selected={x:100,y:100,width:800,height:600}, panel={x:850,y:150,width:320,height:560};
  recorder.selectionValidated({stage:'preview',selection:selected,displayBounds:{x:0,y:0,width:1512,height:982},panelBounds:panel,controlsBounds:panel,surfaceBounds:{x:0,y:33,width:1512,height:949},accepted:false});
  recorder.observe(observation);
  expect(recorder.snapshot().lastSelectionValidation?.panelIntersection).toEqual({x:850,y:150,width:50,height:550});
  selected.width=1;
  expect(recorder.snapshot().lastSelectionValidation?.selection?.width).toBe(800);
  expect(recorder.snapshot().lastSelectionValidation?.surfaceBounds?.y).toBe(33);
  const controls={x:700,y:150,width:320,height:560};
  recorder.selectionValidated({stage:'preview',selection:{x:100,y:100,width:750,height:600},displayBounds:{x:0,y:0,width:1512,height:982},panelBounds:panel,controlsBounds:controls,surfaceBounds:{x:0,y:0,width:1512,height:982},accepted:true});
  expect(recorder.snapshot().lastSelectionValidation).toMatchObject({accepted:true,panelIntersection:null,controlsBounds:controls});
});
