import { expect, it } from 'vitest';
import { defaultBindings, hitPanel, kritaProfile, resolveBinding, validateBindings, validateProfile } from '../src/main/commands';
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
it('rejects duplicate/unknown bindings and validates generic profile configuration', () => {
  expect(() => validateBindings({pause:'F8',penToggle:'f8'})).toThrow('Duplicate');
  expect(() => validateBindings({shell:'Command+Q'})).toThrow();
  expect(validateBindings({pause:'F9',undo:''})).toEqual({pause:'F9'});
  expect(validateBindings({setCanvas:'F7',beginCanvas:'F6'})).toEqual({setCanvas:'F7',beginCanvas:'F6'});
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
