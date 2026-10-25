import { test, expect, _electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';

test('editable shortcut drafts survive live status updates and bindings persist after save',async()=>{
  test.setTimeout(30_000);
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({executablePath:path.resolve('out/Steady-darwin-arm64/Steady.app/Contents/MacOS/Steady'),args:[`--user-data-dir=${mkdtempSync(path.join(os.tmpdir(),'steady-keybindings-e2e-'))}`,'--test-fake-backend'],env,timeout:15000});
  try{
    const panel=await app.firstWindow();
    await expect.poll(()=>panel.evaluate(async()=>(await window.steady.status()).nativeClockReady)).toBe(true);
    const nextWindow=app.waitForEvent('window');await panel.evaluate(()=>window.steady.openAdvanced());const settings=await nextWindow;await settings.waitForLoadState();
    const binding=settings.getByRole('textbox',{name:'Binding resume',exact:true});
    // Every action acknowledgment publishes a freshly cloned status, just like
    // ongoing tracking. All commands and release attempts use fake input.
    const updates=()=>panel.evaluate(async()=>{for(let index=0;index<25;index++){await window.steady.action('penUp');await new Promise(resolve=>setTimeout(resolve,40));}});
    await binding.click();
    await Promise.all([updates(),binding.pressSequentially('Control+Alt+R',{delay:60})]);
    await expect(binding).toHaveValue('Control+Alt+R');
    await settings.getByRole('button',{name:'Save global bindings',exact:true}).click();
    await expect.poll(()=>panel.evaluate(async()=>(await window.steady.status()).bindings?.resume)).toBe('Control+Alt+R');
    await settings.getByRole('combobox',{name:'Profile',exact:true}).selectOption('generic');
    const name=settings.getByRole('textbox',{name:'Name',exact:true});await name.fill('');
    await Promise.all([updates(),name.pressSequentially('My editor',{delay:60})]);
    await expect(name).toHaveValue('My editor');
    const shortcut=settings.getByRole('textbox',{name:'Target shortcut undo',exact:true});await shortcut.fill('');
    await Promise.all([updates(),shortcut.pressSequentially('Control+Z',{delay:60})]);
    await expect(shortcut).toHaveValue('Control+Z');
    const closed=settings.waitForEvent('close');await panel.evaluate(()=>window.steady.closeSettings());await closed;
    const reopenedWindow=app.waitForEvent('window');await panel.evaluate(()=>window.steady.openAdvanced());const reopened=await reopenedWindow;await reopened.waitForLoadState();
    await expect(reopened.getByRole('textbox',{name:'Binding resume',exact:true})).toHaveValue('Control+Alt+R');
    expect((await panel.evaluate(()=>window.steady.status())).realInput).toBe(false);
  }finally{await app.close();}
});
