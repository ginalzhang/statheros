import { test, expect, _electron } from '@playwright/test';
import path from 'node:path';
import { panelWindow } from './helpers';
import { readdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
test('packaged panel is sandboxed, local and nonactivating with bundled helper',async()=>{
  test.setTimeout(60_000);
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({executablePath:path.resolve('out/Steady-darwin-arm64/Steady.app/Contents/MacOS/Steady'),args:[`--user-data-dir=${mkdtempSync(path.join(os.tmpdir(),'steady-phase03-e2e-'))}`,'--test-fake-backend','--use-fake-device-for-media-stream=fps=30','--use-fake-ui-for-media-stream'],env,timeout:15000});
  try{
    const page=await panelWindow(app);await expect(page.getByText('Statheros',{exact:true}).first()).toBeVisible();
    // Main-inspector evaluation can pause Electron's monotonic RTT measurement.
    // Wait through native startup via renderer IPC before inspecting the main VM.
    await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).nativeClockReady),{timeout:5000}).toBe(true);
    await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).speechDiagnostics?.phase),{timeout:5000}).toBe('idle');
    const info=await app.evaluate(({BrowserWindow,app})=>{
      const w=BrowserWindow.getAllWindows().find(win=>new URL(win.webContents.getURL()).searchParams.get('view')==='panel')!;
      return {packaged:app.isPackaged,size:w.getSize(),focusable:w.isFocusable(),alwaysOnTop:w.isAlwaysOnTop(),allSpaces:w.isVisibleOnAllWorkspaces(),url:w.webContents.getURL()};
    });
    expect(info).toMatchObject({packaged:true,size:[300,660],focusable:false,alwaysOnTop:true,allSpaces:true});
    expect(info.url).toMatch(/^file:/);
    const status=await page.evaluate(()=>window.steady.status());expect(status.realInput).toBe(false);expect(status.fault).toBeNull();expect(status.native?.buttonDown).toBe(false);
    await expect(page.evaluate(()=>window.steady.setRealInput(true))).rejects.toThrow('Real input requires');
    await expect(page.evaluate(()=>window.steady.runNativeProbe())).rejects.toThrow('unavailable in fake tests');
    // Fake-test emergency control must stay on the fake release entry point.
    await page.evaluate(()=>window.steady.releaseInput());
    expect(status.speechDiagnostics).toMatchObject({session:null,audioBuffers:0,transcriberResults:0,detectorResults:0,acceptedUtterances:0});
    expect(await page.evaluate(async()=>{try{await fetch('https://example.com/steady-outbound-probe');return false;}catch{return true;}})).toBe(true);
    // Chromium offline emulation proves bundled inference needs no fetch.
    // Physical network-off camera/telemetry evidence still requires an operator.
    await app.context().setOffline(true);
    const workerFilename=readdirSync('.vite/renderer/main_window/assets').find(name=>name.startsWith('vision.worker-'))!;
    for(const mode of ['head','palm'] as const){
      const result=await page.evaluate(async({workerFilename,mode})=>new Promise<{delegate:string;valid:boolean}>((resolve,reject)=>{
        const worker=new Worker(new URL(`assets/${workerFilename}`,location.href),{type:'module'});
        const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Local model initialization timeout'));},15000);
        let delegate='';worker.onerror=event=>{clearTimeout(timeout);worker.terminate();reject(new Error(event.message));};
        worker.onmessage=async event=>{
          if(event.data.type==='fault'){clearTimeout(timeout);worker.terminate();reject(new Error(event.data.message));}
          if(event.data.type==='ready'){
            delegate=event.data.delegate;const canvas=new OffscreenCanvas(640,480);canvas.getContext('2d')!.fillRect(0,0,640,480);
            const bitmap=await createImageBitmap(canvas);worker.postMessage({type:'frame',bitmap,frameId:1,generation:1,captureTimestamp:performance.now()},[bitmap]);
          }
          if(event.data.type==='sample'){clearTimeout(timeout);worker.terminate();resolve({delegate,valid:event.data.sample.valid});}
        };worker.postMessage({type:'initialize',mode,assetRoot:'steady-resource://assets/'});
      }),{workerFilename,mode});
      expect(['GPU','CPU']).toContain(result.delegate);expect(result.valid).toBe(false);
    }
    // Settings and panel are separate packaged file:// windows. Verify their
    // control/report transport without opening any camera or microphone.
    const settingsPromise=app.waitForEvent('window');await page.evaluate(()=>window.steady.openAdvanced());const settings=await settingsPromise;await settings.waitForLoadState();
    // Voice launches microphone-off (plan §2): wake listening needs an explicit mic-on, so no prompt here.
    await expect(settings.getByRole('heading',{name:'Voice commands',exact:true})).toBeVisible();
    await expect(settings.getByRole('button',{name:'Turn microphone on',exact:true})).toBeVisible();
    await expect(page.getByRole('switch',{name:'Voice Commands',exact:true})).toHaveAttribute('aria-checked','false');
    const assetError=await settings.evaluate(async()=>{try{await window.steady.installSpeechAssets();return null;}catch(error){return String(error);}});
    expect(assetError).toContain('Cartesia');
    const voice=await settings.evaluate(()=>window.steady.voiceStatus());
    expect(voice.snapshot?.state).toBe('MUTED');
    expect(voice.snapshot?.cloudOn).toBe(false);
    const voiceStatus=await page.evaluate(()=>window.steady.status());
    expect(voiceStatus.microphoneEnabled).toBe(false);
    const received=page.evaluate(()=>new Promise<boolean>(resolve=>{
      const channel=new BroadcastChannel('steady-review-origin-probe');const timer=setTimeout(()=>{channel.close();resolve(false);},2000);
      channel.onmessage=event=>{clearTimeout(timer);channel.close();resolve(event.data==='probe');};
    }));
    await settings.evaluate(()=>{const channel=new BroadcastChannel('steady-review-origin-probe');channel.postMessage('probe');setTimeout(()=>channel.close(),100);});
    expect(await received).toBe(true);
    expect(await page.evaluate(()=>typeof (globalThis as any).require)).toBe('undefined');
    await settings.getByRole('button',{name:'Start camera probe',exact:true}).click();
    const frameCount=async()=>Number((await settings.locator('[aria-labelledby="camera-heading"] [role="status"]').textContent())?.match(/(\d+) frames/)?.[1]??0);
    await expect.poll(frameCount,{timeout:15000}).toBeGreaterThan(2);
    const beforeCollapse=await frameCount();await page.evaluate(()=>window.steady.collapse(true));
    await expect.poll(frameCount,{timeout:10000}).toBeGreaterThan(beforeCollapse+2);
    await settings.getByRole('button',{name:'Stop camera probe',exact:true}).click();
    await expect(settings.locator('[aria-labelledby="camera-heading"] [role="status"]')).toContainText('Camera off');
    await page.evaluate(() => {
      // Synthetic model outputs exercise the full packaged setup workflow. The
      // real bundled models were separately initialized above; no hardware claim.
      const root = globalThis as any; root.syntheticAnchor = { x: .5, y: .5 };
      root.Worker = class {
        onmessage: ((event: {data: any}) => void) | null = null; onerror = null; stopped = false;
        postMessage(message: any): void {
          if (message.type === 'initialize') setTimeout(() => this.onmessage?.({ data: { type: 'ready', delegate: 'CPU' } }), 1);
          if (message.type === 'frame') {
            message.bitmap.close();
            setTimeout(() => { if (!this.stopped) this.onmessage?.({ data: { type: 'sample', sample: { generation: message.generation, frameId: message.frameId, captureTimestamp: message.captureTimestamp, mode: 'head', valid: true, anchor: root.syntheticAnchor, qualityReason: 'synthetic fixture', selectedHand: null } } }); }, 1);
          }
        }
        terminate(): void { this.stopped = true; }
      };
    });
    await page.evaluate(()=>window.steady.collapse(false));
    await settings.getByRole('button',{name:'Start camera probe',exact:true}).click();
    try {
      await expect(settings.locator('[aria-labelledby="camera-heading"] [role="status"]')).toContainText('synthetic fixture');
    } catch (error) {
      const current=await page.evaluate(()=>window.steady.status());
      console.log('FIXTURE_START_DIAGNOSTIC',JSON.stringify({generation:current.generation,nativeFault:current.nativeFault,nativeClockReady:current.nativeClockReady,native:current.native,selectedDisplayId:current.selectedDisplayId,cameraId:current.settings?.cameraId,mode:current.settings?.mode,alerts:await settings.getByRole('alert').allTextContents(),camera:await settings.locator('[aria-labelledby="camera-heading"] [role="status"]').textContent()}));
      throw error;
    }
    await expect.poll(frameCount,{timeout:10000}).toBeGreaterThan(2);
    await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).settings?.cameraId),{timeout:5000}).not.toBe('');
    const autoCapture = settings.getByRole('checkbox',{name:'Auto-capture when I hold still for 1 second (Capture still works manually)',exact:true});
    await autoCapture.click(); await expect(autoCapture).not.toBeChecked();
    await settings.getByRole('button',{name:'Begin five-position calibration',exact:true}).click();
    await expect(settings.getByTestId('setup-message')).toContainText('Rest your hand',{timeout:5000});
    const positions = [{x:.5,y:.5},{x:.3,y:.5},{x:.8,y:.5},{x:.5,y:.3},{x:.5,y:.8}];
    const steps = ['left','right','up','down'];
    for (let index=0;index<positions.length;index++) {
      await page.evaluate(position => { (globalThis as any).syntheticAnchor = position; }, positions[index]);
      await settings.getByRole('button',{name:'Capture / Retry',exact:true}).click();
      if(index===0) {
        const before=(await page.evaluate(()=>window.steady.status())).generation;
        await app.evaluate(({screen})=>{
          const display=screen.getPrimaryDisplay();
          for(let index=0;index<20;index++)screen.emit('display-metrics-changed',{},display,['workArea']);
        });
        expect((await page.evaluate(()=>window.steady.status())).generation).toBe(before);
        await expect(settings.getByTestId('setup-message')).toContainText('Capturing neutral');
      }
      if(index<4) await expect(settings.getByText(`Current step: ${steps[index]}`,{exact:true})).toBeVisible({timeout:5000});
      else await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).settings?.calibrations.length),{timeout:5000}).toBe(1);
    }
    // Saving publishes a new configuration; the live controller may already
    // display its loaded-calibration message. Assert the durable result below.
    const calibrated = await page.evaluate(()=>window.steady.status());
    expect(calibrated.settings?.calibrations[0]).toMatchObject({gain:1,smoothing:50,neutral:{x:.5,y:.5}});
    expect(calibrated.canvasConfirmed).toBe(false); expect(calibrated.native?.buttonDown).toBe(false); expect(calibrated.native?.state).toBe('PAUSED'); expect(calibrated.nativeClockReady).toBe(true);
    await expect(page.evaluate(()=>window.steady.action('resume'))).rejects.toThrow('Close Settings');
    await settings.getByRole('button',{name:'Recenter neutral',exact:true}).click();
    await expect(settings.getByTestId('setup-message')).toContainText('Capturing a new neutral',{timeout:2000});
    await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).settings?.calibrations[0]?.neutral),{timeout:5000}).toEqual(positions[4]);
    expect((await page.evaluate(()=>window.steady.status())).native?.buttonDown).toBe(false);
    const closed = settings.waitForEvent('close');
    await page.evaluate(()=>window.steady.closeSettings()); await closed;
    const reopenedPromise=app.waitForEvent('window');await page.evaluate(()=>window.steady.openAdvanced());
    const reopened=await reopenedPromise;await reopened.waitForLoadState();
    await expect(reopened.locator('[aria-labelledby="camera-heading"] [role="status"]')).toContainText('synthetic fixture');
    await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).nativeClockReady)).toBe(true);
    // Phase03: exercise main/preload/native canvas and state integration entirely
    // with fake input, then semantic panel routing with no native click-through.
    await reopened.getByRole('button',{name:'Stop camera probe',exact:true}).click();
    const closedAgain=reopened.waitForEvent('close');await page.evaluate(()=>window.steady.closeSettings());await closedAgain;
    await page.evaluate(()=>window.steady.beginLegacyCanvas());
    await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).native?.state)).toBe('SETUP');
    const sample = async (position:{x:number;y:number}, count=1):Promise<void> => {
      for(let index=0;index<count;index++) {
        const frameId = await page.evaluate(async position=>{
          const status=await window.steady.status();
          const root=globalThis as any;root.phase03Frame=Math.max(root.phase03Frame??0,status.native?.latestValidFrame??0)+1;
          window.steady.submitMappedProbe({generation:status.generation,frameId:root.phase03Frame,captureTimestamp:performance.now(),mode:status.settings!.mode,valid:true,anchor:{x:.5,y:.5},qualityReason:'phase03 synthetic mapped fixture'},position);
          return root.phase03Frame as number;
        },position);
        await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).native?.latestValidFrame)).toBe(frameId);
        await page.waitForTimeout(35);
      }
    };
    const selected=await page.evaluate(async()=>{const s=await window.steady.status();return s.displays.find(d=>d.id===s.selectedDisplayId)!.bounds;});
    const at=(x:number,y:number)=>({x:selected.x+x*selected.width,y:selected.y+y*selected.height});
    const inside=at(.3,.5),outside=at(.05,.5);
    await sample(at(.1,.2));await page.evaluate(()=>window.steady.action('markCorner'));
    await sample(at(.55,.8));await page.evaluate(()=>window.steady.action('markCorner'));
    let current=await page.evaluate(()=>window.steady.status());expect(current.canvasConfirmed).toBe(true);expect(current.native?.state).toBe('PAUSED');expect(current.native?.buttonDown).toBe(false);
    await sample(inside,18);await page.evaluate(()=>window.steady.action('resume'));
    await page.evaluate(()=>window.steady.action('penDown'));
    expect((await page.evaluate(()=>window.steady.status())).native?.state).toBe('DRAWING');
    expect((await page.evaluate(()=>window.steady.status())).penArmed).toBe(true);
    await sample(outside);current=await page.evaluate(()=>window.steady.status());expect(current.native?.state).toBe('HOVER');expect(current.native?.buttonDown).toBe(false);
    await sample(inside);await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).native?.buttonDown)).toBe(true);
    await page.evaluate(()=>window.steady.action('penUp'));
    await page.evaluate(()=>window.steady.action('click'));
    for(const action of ['undo','redo','brush','toggleErase','bigger','smaller','swapColors'] as const)await page.evaluate(action=>window.steady.action(action),action);
    await page.evaluate(()=>window.steady.action('penDown'));
    const panelPoint=await app.evaluate(({BrowserWindow})=>{const bounds=BrowserWindow.getAllWindows().find(win=>new URL(win.webContents.getURL()).searchParams.get('view')==='panel')!.getBounds();return {x:bounds.x+10,y:bounds.y+10};});
    await sample(panelPoint);current=await page.evaluate(()=>window.steady.status());expect(current.native?.state).toBe('HOVER');expect(current.native?.buttonDown).toBe(false);
    // Background consumes Click. A registered Pause invokes its local dispatcher.
    await page.evaluate(()=>window.steady.action('click'));
    const pauseRect=await page.getByRole('button',{name:'Pause tracking',exact:true}).first().boundingBox();expect(pauseRect).not.toBeNull();
    await sample({x:panelPoint.x-10+pauseRect!.x+pauseRect!.width/2,y:panelPoint.y-10+pauseRect!.y+pauseRect!.height/2});
    await page.evaluate(()=>window.steady.action('click'));expect((await page.evaluate(()=>window.steady.status())).native?.state).toBe('PAUSED');
    expect((await page.evaluate(()=>window.steady.status())).penArmed).toBe(false);
    await sample(inside,18);await page.evaluate(()=>window.steady.action('resume'));await page.evaluate(()=>window.steady.action('penDown'));
    // No more samples: the independent native watchdog must release by 300ms.
    await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).native?.buttonDown),{timeout:1000,intervals:[20]}).toBe(false);
    expect((await page.evaluate(()=>window.steady.status())).native?.state).toBe('PAUSED');
    await page.evaluate(()=>window.steady.recover());current=await page.evaluate(()=>window.steady.status());expect(current.canvasConfirmed).toBe(false);expect(current.nativeFault).toBeNull();expect(current.native?.state).toBe('PAUSED');
    const finalSettingsPromise=app.waitForEvent('window');await page.evaluate(()=>window.steady.openAdvanced());const finalSettings=await finalSettingsPromise;await finalSettings.waitForLoadState();
    // Deliberately fault only the fake helper with an unordered sample. Camera
    // Stop must still work after the Pause request rejects, including remount.
    await page.evaluate(async()=>{
      const current=await window.steady.status();
      window.steady.submitSample({generation:current.generation,frameId:1,captureTimestamp:performance.now(),mode:'head',valid:false,anchor:null,qualityReason:'synthetic ordering seed'});
      await new Promise(resolve=>setTimeout(resolve,35));
      window.steady.submitSample({generation:current.generation,frameId:0,captureTimestamp:performance.now(),mode:'head',valid:false,anchor:null,qualityReason:'synthetic unordered fixture'});
    });
    await expect.poll(()=>page.evaluate(async()=>(await window.steady.status()).nativeFault)).toContain('stale-or-unordered');
    await finalSettings.getByRole('button',{name:'Stop camera probe',exact:true}).click();
    await expect(finalSettings.locator('[aria-labelledby="camera-heading"] [role="status"]')).toContainText('Camera off');
    await page.evaluate(()=>window.steady.openAdvanced());
    expect((await page.evaluate(()=>window.steady.status())).nativeFault).toContain('stale-or-unordered');
  }finally{await app.close();}
});
