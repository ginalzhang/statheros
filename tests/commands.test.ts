import { expect, it } from 'vitest';
import { defaultBindings, hitPanel, hitSurfaces, kritaProfile, resolveBinding, validateBindings, validateProfile } from '../src/main/commands';
it('keeps fixed Krita shortcuts and sparse initial global bindings', () => {
  expect(kritaProfile().shortcuts).toEqual({undo:'Command+Z',redo:'Command+Shift+Z',brush:'B',toggleErase:'E',bigger:']',smaller:'['});
  expect(defaultBindings()).toEqual({penToggle:'F8',pause:'F9'});
  expect(resolveBinding('penToggle',true)).toBe('markCorner'); expect(resolveBinding('penToggle',false)).toBe('penToggle');
  expect(resolveBinding('pause',true)).toBe('pause');
});
it('routes panel semantic hits locally, consumes background, and distinguishes outside', () => {
  const panel = {x:-336,y:-176,width:320,height:560};
  const buttons = [{actionId:'openSettings' as const,rect:{x:100,y:10,width:44,height:44}}];
  expect(hitPanel({x:-220,y:-150},panel,buttons)).toEqual({inside:true,action:'openSettings'});
  expect(hitPanel({x:-300,y:0},panel,buttons)).toEqual({inside:true,action:null});
  expect(hitPanel({x:0,y:0},panel,buttons)).toEqual({inside:false,action:null});
});
it('routes tracked clicks to whichever separate overlay surface is under the pointer', () => {
  const panel = { bounds: {x:1100,y:30,width:300,height:660}, buttons: [{actionId:'pause' as const,rect:{x:16,y:600,width:130,height:30}}] };
  const toolbar = { bounds: {x:450,y:800,width:386,height:36}, buttons: [{actionId:'undo' as const,rect:{x:250,y:1,width:30,height:34}}] };
  const preview = { bounds: {x:240,y:630,width:200,height:180}, buttons: [] };
  const surfaces = [panel, preview, toolbar];
  expect(hitSurfaces({x:710,y:815},surfaces)).toEqual({inside:true,action:'undo'});
  expect(hitSurfaces({x:1130,y:640},surfaces)).toEqual({inside:true,action:'pause'});
  expect(hitSurfaces({x:300,y:700},surfaces)).toEqual({inside:true,action:null});
  expect(hitSurfaces({x:700,y:400},surfaces)).toEqual({inside:false,action:null});
});
it('rejects duplicate/unknown bindings and validates generic profile configuration', () => {
  expect(() => validateBindings({pause:'F8',penToggle:'f8'})).toThrow('Duplicate');
  expect(() => validateBindings({shell:'Command+Q'})).toThrow();
  expect(validateBindings({pause:'F9',undo:''})).toEqual({pause:'F9'});
  expect(validateProfile({...kritaProfile(),name:'Generic — unverified',targetBundleId:'org.example.editor'}).targetBundleId).toBe('org.example.editor');
  expect(() => validateProfile({...kritaProfile(),shortcuts:{undo:'X'}})).toThrow();
});
it('exposes registration conflicts without fallback and removes owned registrations on replacement', async () => {
  const { GlobalBindingInstaller } = await import('../src/main/commands');
  const registered: Record<string, () => void> = {}; const removed: string[] = []; const actions: string[] = [];
  const installer = new GlobalBindingInstaller({ register: (key, callback) => { if (key === 'F8') return false; registered[key] = callback; return true; }, unregister: key => { removed.push(key); delete registered[key]; } });
  expect(installer.install(defaultBindings(), action => actions.push(action))).toEqual(['penToggle: F8']);
  registered.F9!(); expect(actions).toEqual(['pause']);
  installer.install({pause:'Command+P'}, () => undefined); expect(removed).toEqual(['F9']); expect(registered.F8).toBeUndefined();
});
