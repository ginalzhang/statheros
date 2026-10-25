import { app, BrowserWindow, globalShortcut, ipcMain, net, powerMonitor, protocol, screen, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NativeSupervisor } from './supervisor';
import { emptySpeechDiagnostics, isSpeechDiagnosticError, SpeechDiagnosticRecorder } from './speech-diagnostics';
import { LiveProbe } from './live-probe';
import { PANEL_COLLAPSED_HEIGHT, PANEL_HEIGHT, PANEL_WIDTH, panelPosition, preferredDisplay } from './panel';
import { CanvasCapture, containsPoint, intersects } from './canvas';
import { GlobalBindingInstaller, defaultBindings, kritaProfile, isLocalAction, hitPanel, resolveBinding, validateBindings, validateProfile } from './commands';
import { freshPointer, mappedSampleAllowed, readyForControl } from './input-gates';
import { resourcesRoot, verifyResources } from './resources';
import { ACTIONS, type Ack, type ActionID, type LocalActionID, type Point, type DisplayInfo, type Mode, type ProbeStatus, type Rect, type TrackingSample } from '../shared/contracts';
import { isObject, rect, uint, point, finite } from './protocol';
import { isTrackingSample } from '../shared/tracking-validation';
import { DisplayLayoutGuard } from './display-layout';
import { ConfigurationQueue } from './configuration';
import { deliverCommand } from './command-delivery';
import { SettingsStore } from './settings';
import { defaultSettings, withCalibration } from '../shared/settings';
import { isCalibrationV1 } from '../renderer/engine';
import { ElectronVoice } from './voice/electron-voice';
import { parseSteadyCommand, VOICE_LABELS } from './voice/steady-commands';
import type { CommandEvent } from './voice/types';
import type { VoiceCaptureReport } from '../shared/voice';
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

protocol.registerSchemesAsPrivileged([{ scheme: 'steady-resource', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let realInput = false;
const testFakeBackend = process.argv.includes('--test-fake-backend');
const canvasCapture = new CanvasCapture();
let canvas: Rect | null = null;
let pointer: { position: Point; timestamp: number; generation: number } | null = null;
let nativeConfiguredTarget: number | null = null;
let knownPanelOrigin: Point | null = null;
let panelGeometryPending = false;
let panelGeometryEpoch = 0;
let movingPanelProgrammatically = false;
const bindingInstaller = new GlobalBindingInstaller(globalShortcut);
let panel: BrowserWindow | null = null, settings: BrowserWindow | null = null, supervisor: NativeSupervisor | null = null;
let voice: ElectronVoice | null = null;
let quitting = false, generation = 1;
let settingsStore: SettingsStore;
const configuration = new ConfigurationQueue();
let savedSettings = defaultSettings();
async function configureControl(setup = false): Promise<void> {
  pointer = null;
  if (!supervisor || status.selectedDisplayId === undefined || !status.targetPid) {
    await pause('Open Krita, then Recover native helper before configuring control.'); return;
  }
  const bounds = panel?.getBounds();
  if (canvas && bounds && intersects(canvas, bounds)) {
    canvas = null; canvasCapture.cancel(); status.canvasConfirmed = false;
    status.fault = 'Panel overlaps the canvas. Mark the corners again.';
  }
  await supervisor.request('configure', { generation, targetBundleId: 'org.krita', targetPid: status.targetPid,
    displayId: status.selectedDisplayId, canvas: setup ? null : canvas, excludedRects: bounds ? [bounds] : [] });
  nativeConfiguredTarget = status.targetPid;
  if (!setup) await supervisor.request('action', { generation, eventId: randomUUID(), actionId: 'pause' });
  publish();
}
function invalidateCanvas(): void {
  canvas = null; canvasCapture.cancel(); pointer = null; status.canvasConfirmed = false;
}
async function beginCanvas(): Promise<void> {
  if(panelGeometryPending)throw new Error('Wait for panel geometry to settle, then Set canvas again.');
  await pause('Canvas setup requested; pen up.');
  // Refresh target identity/foreground metadata before using UI prerequisites.
  await supervisor?.request('ping', { senderTimestamp: performance.now() });
  const reason = readyForControl({ ...status, generation }, false);
  if (reason) throw new Error(reason);
  if (!fixedKritaProfile()) throw new Error('Select the fixed Krita profile before canvas setup. Generic profiles are configuration previews.');
  invalidateCanvas(); generation++; canvasCapture.begin();
  await configureControl(true); publish();
}
async function cancelCanvas(): Promise<void> {
  invalidateCanvas(); await pause('Canvas setup canceled; input stays paused.');
  generation++; await configureControl(); publish();
}
function installBindings(): void {
  status.bindingConflicts = bindingInstaller.install(status.bindings ?? defaultBindings(), action => {
    const resolved = resolveBinding(action, canvasCapture.active);
    void enqueueAction(resolved).catch(error => fault(String(error)));
  });
  publish();
}

let status: ProbeStatus = { native: null, displays: [], fault: null, collapsed: false, settingsOpen: false, generation, realInput, microphoneEnabled: false };
let buttons: {actionId:LocalActionID;rect:Rect}[] = [];
let speechSession: string | null = null;
const speechSeen = new Set<string>();
let shutdownStarted = false;
let resourcesReady=false;
let liveProbe: ChildProcessWithoutNullStreams | null = null;
let liveProbeLifecycle: LiveProbe | null = null;
function trackingEvidence(type: string, data: unknown): void {
  const directory=path.join(app.getPath('userData'),'phase03-evidence');mkdirSync(directory,{recursive:true});
  appendFileSync(path.join(directory,'tracking.jsonl'),JSON.stringify({v:1,type,time:new Date().toISOString(),evidence:'physical-camera operator trial or automated harness; classify by session launch',cameraId:savedSettings.cameraId,mode:savedSettings.mode,displayId:status.selectedDisplayId,data})+'\n');
}
function stopLiveProbe(): void { liveProbeLifecycle?.cancel(); }
function releaseRealInput(): void { spawnSync(path.join(resourcesRoot(),'bin','SteadyNative'),['--release-and-exit',testFakeBackend?'--test-fake-backend':'--real-input'],{stdio:'ignore',timeout:1000}); }
function publish(): void { status = {...status, generation, realInput, canvas, canvasSetup: canvasCapture.snapshot()}; for (const win of [panel,settings]) if (win && !win.isDestroyed()) win.webContents.send('steady:status-changed', status); }
function fault(message: string): void { status.fault = message; publish(); }
async function pause(reason: string): Promise<void> {
  stopLiveProbe();
  if (!supervisor) return;
  try { await supervisor.request('action', { generation:supervisor.state?.generation ?? 0, eventId: randomUUID(), actionId: 'pause' }); }
  catch (error) { supervisor.emergencyRelease(); status.nativeFault ??= String(error); }
  status.fault = reason; publish();
}
function fixedKritaProfile(): boolean {
  const actual = status.profile ?? kritaProfile(), expected = kritaProfile();
  return actual.name === expected.name && actual.targetBundleId === expected.targetBundleId &&
    (Object.keys(expected.shortcuts) as (keyof typeof expected.shortcuts)[]).every(key => actual.shortcuts[key] === expected.shortcuts[key]);
}
function enqueueAction(action: LocalActionID, eventId = randomUUID()): Promise<Ack | null> {
  return deliverCommand(configuration, () => generation, action, () => dispatch(action, eventId));
}
async function dispatch(actionId: LocalActionID, eventId: string = randomUUID()): Promise<Ack | null> {
  if (!isLocalAction(actionId)) throw new Error('Unknown action');
  stopLiveProbe();
  switch (actionId) {
    case 'microphoneOff': await microphone(false); return null;
    case 'openSettings': await openSettings(); return null;
    case 'togglePanel': await collapsePanel(!status.collapsed); return null;
    case 'quit': app.quit(); return null;
    case 'recover': await recoverNative(); return null;
    case 'beginCanvas': await beginCanvas(); return null;
    case 'cancelCanvas': await cancelCanvas(); return null;
    case 'confirmHand': await pause('Selected hand confirmation; explicit Resume required.'); panel?.webContents.send('steady:local-action','confirmHand'); return null;
    case 'recenter':
      invalidateCanvas(); await pause('Recenter: capture a new neutral position; input remains paused');
      panel?.webContents.send('steady:recenter'); publish(); return null;
    case 'pause':
      if (canvasCapture.active) canvasCapture.cancel();
      await pause('Paused'); return null;
    case 'markCorner': {
      const reason = readyForControl({ ...status, generation }, false);
      if (reason) throw new Error(reason);
      if (supervisor?.state?.state !== 'SETUP') throw new Error('Canvas setup paused. Begin canvas setup again.');
      const position = freshPointer(pointer, generation, performance.now());
      if (!position) throw new Error('No fresh tracked pointer. Corner command discarded.');
      const display = status.displays.find(d => d.id === status.selectedDisplayId);
      if (!display) throw new Error('Select an available display.');
      const bounds = panel?.getBounds();
      const result = canvasCapture.mark(position, display.bounds, bounds ? [bounds] : []);
      if (result) {
        await pause('Canvas confirmed; explicitly Resume when ready.'); canvas = result; status.canvasConfirmed = true;
        generation++; await configureControl();
        trackingEvidence('canvas-confirmed', { canvas, realInput });
      }
      publish(); return null;
    }
    case 'resume': {
      if(panelGeometryPending)throw new Error('Panel geometry is changing. Retry Resume explicitly.');
      await supervisor?.request('ping', { senderTimestamp: performance.now() });
      const reason = readyForControl({ ...status, generation }, true);
      if (reason) throw new Error(reason);
      if (nativeConfiguredTarget !== status.targetPid) throw new Error('Krita restarted. Recover the native helper and reconfirm canvas.');
      break;
    }
    case 'click': {
      const position = freshPointer(pointer, generation, performance.now());
      const bounds = panel?.getBounds();
      if (position && bounds) {
        const hit = hitPanel(position, bounds, buttons);
        if (hit.inside) {
          // End an active stroke before any local panel operation. Background consumes Click.
          await supervisor?.request('action', { generation, eventId: randomUUID(), actionId: 'penUp' });
          if (hit.action && hit.action !== 'click') return dispatch(hit.action, eventId);
          return null;
        }
      }
      break;
    }
  }
  if (!supervisor) throw new Error('Native helper unavailable');
  if (!ACTIONS.includes(actionId as ActionID)) throw new Error('Local action was not handled');
  if(status.settingsOpen && ['resume','penDown','penToggle','click'].includes(actionId)){
    await supervisor.request('action',{generation,eventId:randomUUID(),actionId:'penUp'});
    throw new Error('Close Settings before pointer actions.');
  }
  if (['resume','penDown','penToggle','click','undo','redo','brush','toggleErase','bigger','smaller'].includes(actionId) && !fixedKritaProfile()) {
    await supervisor.request('action', { generation, eventId: randomUUID(), actionId: 'penUp' });
    throw new Error('Generic shortcut profiles are unverified configuration previews. Select the fixed Krita profile to execute.');
  }
  const ack = await supervisor.request('action', { generation, eventId, actionId: actionId as ActionID });
  status.fault = null; publish(); return ack;
}
async function collapsePanel(collapsed: boolean): Promise<void> {
  status.collapsed = collapsed; panel?.setSize(PANEL_WIDTH, collapsed ? PANEL_COLLAPSED_HEIGHT : PANEL_HEIGHT, false); buttons = [];
  // Native exclusion geometry changes are serialized and always leave input paused.
  await pause('Panel geometry changed; Resume when ready.');
  if (canvasCapture.active) invalidateCanvas();
  generation++; await configureControl(); publish();
}

/** Voice input (Cartesia STT + local wake word) replaces the deferred native speech path; the helper's microphone stays off. */
async function microphone(enabled: boolean): Promise<void> {
  if (!voice) throw new Error('Voice input is unavailable.');
  voice.setMicrophone(enabled);
}
/** <<COMMAND_ENTRYPOINT>> for voice: the shared dispatcher, resolving after the native ack. */
async function executeVoiceCommand(command: CommandEvent): Promise<string | null> {
  if (command.kind === 'dictation') throw new Error("Dictation isn't available in Steady");
  const action = parseSteadyCommand(command.text);
  if (!action) throw new Error(`“${command.text.slice(0, 40)}” isn't a Steady command`);
  await enqueueAction(action);
  return VOICE_LABELS[action];
}
function initialPanelPosition(): {x:number;y:number} {
  const display = screen.getAllDisplays().find(d=>d.internal) ?? screen.getPrimaryDisplay();
  return { x:display.workArea.x+display.workArea.width-PANEL_WIDTH-16, y:display.workArea.y+16 };
}
function updateDisplays(displays:DisplayInfo[],forcePosition=false):void {
  const previous=status.displays.find(display=>display.id===status.selectedDisplayId);
  const selected=preferredDisplay(displays,status.selectedDisplayId);
  const changed=previous?.id!==selected?.id||JSON.stringify(previous?.workArea)!==JSON.stringify(selected?.workArea);
  status.displays=displays;status.selectedDisplayId=selected?.id;
  if(selected&&(forcePosition||changed)){
    const position=panelPosition(selected);movingPanelProgrammatically=true;
    try{knownPanelOrigin=position;panel?.setPosition(position.x,position.y,false);if(panel)knownPanelOrigin=panel.getBounds();}
    finally{movingPanelProgrammatically=false;}
  }
  publish();
}
function secureWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate', event=>event.preventDefault());
  win.webContents.on('render-process-gone', ()=>{ void pause('Renderer exited; restart required'); });
  win.webContents.on('unresponsive', ()=>{ void pause('Renderer unresponsive'); });
}
async function loadView(win: BrowserWindow, view: string): Promise<void> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?view=${view}`);
  else await win.loadFile(path.join(__dirname,`../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),{query:{view}});
}
async function openSettings(): Promise<void> {
  status.settingsOpen=true;publish();
  await pause('Settings opened; input paused');
  if (settings) { settings.show(); settings.focus(); return; }
  settings = new BrowserWindow({ width:760,height:820,minWidth:600,minHeight:600,title:'Steady — Settings',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false} });
  secureWindow(settings); status.settingsOpen=true; publish();
  settings.on('closed',()=>{settings=null;status.settingsOpen=false;publish();});
  await loadView(settings,'settings');
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
  if (![panel?.webContents,settings?.webContents].includes(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted IPC sender');
}
function installIPC(): void {
  const handle = (name:string,fn:(...args:any[])=>unknown) => ipcMain.handle(`steady:${name}`,(event,...args)=>{trusted(event);return fn(...args);});
  handle('clock',()=>performance.now());
  handle('status',()=>status);
  handle('action',async (action:unknown)=>{
    if(typeof action!=='string'||!ACTIONS.includes(action as ActionID))throw new Error('Invalid action');
    try { await enqueueAction(action as ActionID); } catch(error) { fault(String(error)); throw error; }
  });
  handle('local-action',async(action:unknown)=>{
    if(!isLocalAction(action))throw new Error('Invalid local action');
    try { await enqueueAction(action); } catch(error) { fault(String(error)); throw error; }
  });
  handle('begin-canvas',()=>configuration.run(beginCanvas));
  handle('cancel-canvas',()=>configuration.run(cancelCanvas));
  handle('recover',()=>configuration.run(recoverNative));
  handle('real-input',(enabled:unknown)=>configuration.run(async()=>{
    if(typeof enabled!=='boolean')throw new Error('Invalid real-input flag');
    if(enabled && (!app.isPackaged || testFakeBackend))throw new Error('Real input requires the packaged app and disposable Krita document confirmation.');
    await pause('Native input mode changed.'); invalidateCanvas(); realInput=enabled; generation++;
    await recoverNative();
  }));
  handle('save-bindings',(value:unknown)=>configuration.run(async()=>{
    const bindings=validateBindings(value);await pause('Bindings changed; input paused.');
    savedSettings={...savedSettings,bindings};settingsStore.save(savedSettings);status.settings=savedSettings;status.bindings=bindings;installBindings();
  }));
  handle('save-profile',(value:unknown)=>configuration.run(async()=>{
    const profile=validateProfile(value);await pause('Shortcut profile changed; input paused.');
    savedSettings={...savedSettings,profile};settingsStore.save(savedSettings);status.settings=savedSettings;status.profile=profile;publish();
  }));
  handle('collapse',(collapsed:unknown)=>configuration.run(async()=>{if(typeof collapsed!=='boolean')throw new Error('Invalid collapse');await collapsePanel(collapsed);}));
  handle('open-settings',openSettings);
  handle('close-settings',()=>settings?.close());
  handle('select-camera',(cameraId:unknown,mode:unknown)=>configuration.run(async()=>{
    if(typeof cameraId!=='string'||cameraId.length>1024||!['head','palm'].includes(mode as string))throw new Error('Invalid camera');
    await pause('Camera/mode changed; canvas confirmation required');generation++;
    savedSettings={...savedSettings,cameraId,mode:mode as Mode};settingsStore.save(savedSettings);status.settings=savedSettings;status.canvasConfirmed=false;
    invalidateCanvas(); await configureControl();publish();
  }));
  handle('tracking-metrics',(value:unknown)=>{
    if(!isObject(value)||!['frames','validFrames','mappedFrames','elapsedMs','mappingHz'].every(k=>finite(value[k])&&value[k]>=0)||!(value.receiptToMappedP95Ms===null||(finite(value.receiptToMappedP95Ms)&&value.receiptToMappedP95Ms>=0))||!(value.position===null||point(value.position))||typeof value.reason!=='string'||value.reason.length>256)throw new Error('Invalid tracking metrics');
    const metrics={frames:value.frames,validFrames:value.validFrames,mappedFrames:value.mappedFrames,elapsedMs:value.elapsedMs,mappingHz:value.mappingHz,receiptToMappedP95Ms:value.receiptToMappedP95Ms,position:value.position,reason:value.reason};
    trackingEvidence('baseline',metrics);
  });
  handle('save-calibration',(value:unknown)=>configuration.run(async()=>{
    if(!isCalibrationV1(value)||value.cameraId!==savedSettings.cameraId||value.mode!==savedSettings.mode)throw new Error('Calibration does not match selected camera/mode');
    await pause('Calibration saved; input remains paused and canvas confirmation is required');
    savedSettings=withCalibration(savedSettings,value);settingsStore.save(savedSettings);trackingEvidence('calibration-saved',value);status.settings=savedSettings;status.canvasConfirmed=false;generation++;
    invalidateCanvas(); await configureControl();publish();
  }));
  // Stroke/motion tuning: gain and smoothing only. Canvas geometry is unaffected, so no reconfirmation;
  // a held pen is released first so a mapping change can never extend a stroke.
  handle('tune-calibration',(value:unknown)=>configuration.run(async()=>{
    if(!isCalibrationV1(value)||value.cameraId!==savedSettings.cameraId||value.mode!==savedSettings.mode)throw new Error('Calibration does not match selected camera/mode');
    const current=savedSettings.calibrations.find(c=>c.cameraId===value.cameraId&&c.mode===value.mode);
    const fixed=(c:typeof value)=>JSON.stringify([c.schemaVersion,c.selectedHand,c.neutral.x,c.neutral.y,c.extents.left,c.extents.right,c.extents.up,c.extents.down,c.jitter.x,c.jitter.y]);
    if(!current||fixed(current)!==fixed(value))throw new Error('Only smoothing and sensitivity can be tuned from the panel');
    if(status.native?.buttonDown)await supervisor?.request('action',{generation,eventId:randomUUID(),actionId:'penUp'});
    savedSettings=withCalibration(savedSettings,value);settingsStore.save(savedSettings);status.settings=savedSettings;publish();
  }));
  // Orientation changes the tracked coordinate space: the camera's saved calibrations no longer apply.
  handle('set-orientation',(cameraId:unknown,flipX:unknown,flipY:unknown)=>configuration.run(async()=>{
    if(typeof cameraId!=='string'||cameraId.length>1024||typeof flipX!=='boolean'||typeof flipY!=='boolean')throw new Error('Invalid camera orientation');
    await pause('Camera orientation changed; recalibrate');generation++;
    const orientations=[...(savedSettings.orientations??[]).filter(entry=>entry.cameraId!==cameraId),...(flipX||flipY?[{cameraId,flipX,flipY}]:[])];
    savedSettings={...savedSettings,orientations,calibrations:savedSettings.calibrations.filter(c=>c.cameraId!==cameraId)};
    if(!orientations.length)delete savedSettings.orientations;
    settingsStore.save(savedSettings);status.settings=savedSettings;status.canvasConfirmed=false;
    invalidateCanvas();await configureControl();status.fault='Camera orientation changed; recalibrate';publish();
  }));
  handle('panel-opacity',(opacity:unknown)=>{if(opacity!==1&&opacity!==0.7)throw new Error('Invalid opacity');panel?.setOpacity(opacity);status.panelOpacity=opacity;publish();});
  handle('select-display',(displayId:unknown)=>configuration.run(async()=>{
    if(!uint(displayId)||!status.displays.some(display=>display.id===displayId))throw new Error('Unknown native display');
    await pause('Selected display changed; canvas invalidated');generation++;status.selectedDisplayId=displayId;buttons=[];status.canvasConfirmed=false;invalidateCanvas();updateDisplays(status.displays,true); await configureControl();
  }));
  handle('microphone',async(enabled:unknown)=>{if(typeof enabled!=='boolean')throw new Error('Invalid microphone flag');await microphone(enabled);});
  handle('install-speech-assets',async()=>{throw new Error('Apple speech assets are not used; voice uses Cartesia.');});
  handle('voice-status',()=>({snapshot:voice?.snapshot()??null,keySource:voice?.keySource??null}));
  handle('voice-key',(key:unknown)=>{if(key!==null&&(typeof key!=='string'||key.length>256))throw new Error('Invalid key');voice?.setKey(key);});
  handle('voice-selftest',()=>voice?.selfTest()??{ok:false,samplesPerSecond:0,peakDbfs:null,message:'Voice unavailable'});
  handle('voice-latency',()=>voice?.latency()??null);
  handle('release-input',()=>{
    stopLiveProbe();
    releaseRealInput();
    return pause('Emergency release requested');
  });
  handle('run-native-probe',async()=>{
    if(!app.isPackaged || testFakeBackend)throw new Error('Real-input probes require packaged operator identity; unavailable in fake tests.');
    if(liveProbe)throw new Error('Probe already running');
    await pause('Bounded real-input probe: switch to disposable Krita document within five seconds');
    const child=liveProbe=spawn(path.join(resourcesRoot(),'bin','SteadyNative'),['--probe','--real-input',...(status.selectedDisplayId===undefined?[]:['--probe-display',String(status.selectedDisplayId)])],{stdio:['pipe','pipe','pipe']});
    const directory=path.join(app.getPath('userData'),'phase01-evidence');mkdirSync(directory,{recursive:true});
    child.stdout.on('data',data=>appendFileSync(path.join(directory,'native-probe.jsonl'),data));
    child.stderr.on('data',()=>{});
    liveProbeLifecycle=new LiveProbe(child,releaseRealInput,message=>{if(liveProbe===child){liveProbe=null;liveProbeLifecycle=null;}fault(message);});
  });
  handle('quit',()=>app.quit());
  ipcMain.on('steady:register-buttons',(event,value:unknown)=>{trusted(event);if(event.sender!==panel?.webContents||!Array.isArray(value)||value.length>100) return;buttons=value.filter(x=>isObject(x)&&isLocalAction(x.actionId)&&rect(x.rect)) as typeof buttons;});
  ipcMain.on('steady:sample',(event,sample:unknown)=>{
    trusted(event); if(event.sender!==panel?.webContents||!isObject(sample)||!uint(sample.generation)||!uint(sample.frameId)||!finite(sample.captureTimestamp)||typeof sample.valid!=='boolean'||!['head','palm'].includes(sample.mode as string)||(sample.valid?!point(sample.anchor):sample.anchor!==null)||typeof sample.qualityReason!=='string')return;
    if(sample.generation!==generation)return;
    // Feasibility capture establishes freshness only. No uncalibrated pointer mapping.
    if(status.native?.generation)supervisor?.submit({...sample,valid:false} as unknown as TrackingSample,null,sample.captureTimestamp);
  });
  ipcMain.on('steady:mapped-probe',(event,sample:unknown,position:unknown)=>{
    trusted(event);
    if(event.sender!==panel?.webContents || !mappedSampleAllowed(sample,position,{...status,generation},performance.now()))return;
    pointer = sample.valid ? { position: position as Point, timestamp: sample.captureTimestamp, generation } : null;
    if(supervisor?.state?.generation===generation)supervisor.submit(sample, sample.valid ? position as Point : null, sample.captureTimestamp);
  });
  ipcMain.on('steady:voice-frame',(event,pcm:unknown)=>{if(event.sender!==panel?.webContents||event.senderFrame!==event.sender.mainFrame)return;voice?.frame(pcm);});
  ipcMain.on('steady:voice-report',(event,report:unknown)=>{
    if(event.sender!==panel?.webContents||!isObject(report)||typeof report.type!=='string')return;
    if(['opened','deviceChanged'].includes(report.type))voice?.report({type:report.type} as VoiceCaptureReport);
    else if(report.type==='failed'&&typeof report.reason==='string')voice?.report({type:'failed',reason:report.reason.slice(0,200)});
    else if((report.type==='earconStarted'||report.type==='earconStopped')&&typeof report.playId==='string'&&report.playId.length<=64)voice?.report({type:report.type,playId:report.playId});
  });
  ipcMain.on('steady:voice-button',(event,kind:unknown)=>{trusted(event);if(kind==='press'||kind==='longpress')voice?.button(kind);});
  ipcMain.on('steady:voice-cancel',(event)=>{trusted(event);voice?.cancel();});
  ipcMain.on('steady:clock-fault',(event,message:unknown)=>{trusted(event);void pause(typeof message==='string'?message:'Renderer clock synchronization failed');});
}
async function startNative(): Promise<void> {
  const next = new NativeSupervisor(path.join(resourcesRoot(),'bin','SteadyNative'), realInput, testFakeBackend);
  supervisor = next;
  let recordedLoss: number | undefined;
  next.on('state',state=>{
    if(supervisor!==next)return;
    if(!state.buttonDown && status.native?.buttonDown && state.lastReleaseTimestamp!=null && state.lastReleaseTimestamp!==recordedLoss){
      recordedLoss=state.lastReleaseTimestamp;
      trackingEvidence('button-release',{realInput:next.realInput,generation:state.generation,nativeReason:state.reason,
        previousState:status.native.state,lastValidCaptureTimestamp:state.lastValidCaptureTimestamp??null,lastReleaseTimestamp:state.lastReleaseTimestamp,
        releaseAfterCaptureMs:state.lastValidCaptureTimestamp==null?null:state.lastReleaseTimestamp-state.lastValidCaptureTimestamp,
        buttonDown:state.buttonDown,clockUncertaintyMs:next.clock.uncertainty});
    }
    status.native=state;if(state.reason==='microphone-enabled'&&speechSession!==null)status.microphoneEnabled=true;if(state.reason==='microphone-disabled')status.microphoneEnabled=false;if(state.reason==='speech-assets-ready')status.speechDiagnostics={...(status.speechDiagnostics??emptySpeechDiagnostics(speechSession)),assets:'ready'};publish();});
  next.on('fault',(message)=>{if(supervisor!==next)return;speechSession=null;status.microphoneEnabled=false;status.nativeClockReady=false;status.nativeFault=message;trackingEvidence('native-fault',{message});fault(message);});
  next.on('clock-ready',ready=>{if(supervisor!==next)return;status.nativeClockReady=ready;publish();});
  next.on('hello',(ack)=>{updateDisplays(ack.displays??[]);status.targetPid=ack.targetPid??null;publish();});
  next.on('displays',displays=>updateDisplays(displays));
  next.on('target',pid=>{if(supervisor!==next)return;status.targetPid=pid;publish();});
  const speechDiagnosticRecorder=new SpeechDiagnosticRecorder(path.join(app.getPath('userData'),'phase01-evidence','speech-diagnostics.jsonl'));
  next.on('speech-diagnostics',diagnostics=>{status.speechDiagnostics=diagnostics;try{speechDiagnosticRecorder.write(diagnostics);}catch{fault('Speech diagnostic evidence could not be saved');}publish();});
  next.on('native-fault',code=>{const errorCode=code==='microphone-failed'?'microphone-setup-failed':code;if(isSpeechDiagnosticError(errorCode)){status.speechDiagnostics={...(status.speechDiagnostics??emptySpeechDiagnostics(speechSession)),phase:'error',...(code==='speech-assets-failed'?{assets:'error' as const}:{}),errorCode};try{speechDiagnosticRecorder.write(status.speechDiagnostics);}catch{fault('Speech diagnostic evidence could not be saved');}publish();}});
  next.on('speech',event=>{
    const key=`${event.speechSession}:${event.utterance}`;
    if(event.speechSession!==speechSession||speechSeen.has(key))return;
    speechSeen.add(key); if(speechSeen.size>1000) {void microphone(false);return;}
    const record=(ack:Ack|null)=>{
      const timing={speechSession:event.speechSession,utterance:event.utterance,actionId:event.actionId,speechEndTimestamp:event.speechEndTimestamp,recognitionTimestamp:event.acceptedTimestamp,actionTimestamp:ack?.nativeTimestamp??null,latencyMs:ack?.nativeTimestamp==null?null:ack.nativeTimestamp-event.speechEndTimestamp,accepted:ack?.accepted??false};
      const directory=path.join(app.getPath('userData'),'phase01-evidence');mkdirSync(directory,{recursive:true});appendFileSync(path.join(directory,'speech-timings.jsonl'),JSON.stringify(timing)+'\n');
    };
    if(event.actionId===null){record(null);fault(event.reason==='late-result-retry'?'Speech result expired; retry':`Speech command rejected: ${event.reason}`);return;}
    let currentNative:number;
    try{currentNative=supervisor!.clock.convert(performance.now(),performance.now());}catch{fault('Speech clock requires synchronization; retry');return;}
    if(event.acceptedTimestamp-event.speechEndTimestamp>1500||currentNative-event.speechEndTimestamp>1500){record(null);fault('Speech result expired; retry');return;}
    void dispatch(event.actionId,key).then(record).catch(error=>{record(null);fault(String(error));});
  });
  try { await next.start(); generation++; await configureControl(); }
  catch(error) { status.nativeFault=String(error); fault(String(error)); }
}
async function recoverNative(): Promise<void> {
  await pause('Recovering helper; canvas must be reconfirmed.');
  const old=supervisor; supervisor=null; await old?.stop();
  invalidateCanvas(); nativeConfiguredTarget=null; status.native=null; status.nativeFault=null; status.nativeClockReady=false;
  status.fault=null; generation++;
  await startNative(); publish();
}
async function main(): Promise<void> {
  await app.whenReady(); app.dock?.hide();
  settingsStore=new SettingsStore(path.join(app.getPath('userData'),'settings-v1.json'));
  const loaded=settingsStore.load();savedSettings=loaded.settings;status.settings=savedSettings;status.bindings=savedSettings.bindings??defaultBindings();status.profile=savedSettings.profile??kritaProfile();status.canvasConfirmed=false;if(loaded.warning)status.fault=loaded.warning;
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
    const url = new URL(details.url);
    const dev = !app.isPackaged && MAIN_WINDOW_VITE_DEV_SERVER_URL && url.origin===new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
    callback({cancel:!(['file:','steady-resource:','data:','blob:','devtools:'].includes(url.protocol)||dev)});
  });
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>callback([panel?.webContents,settings?.webContents].includes(contents)&&permission==='media'));
  protocol.handle('steady-resource',request=>{
    if(!resourcesReady)return new Response('Local resource integrity check failed',{status:503});
    const url=new URL(request.url); const name=decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const root=path.resolve(resourcesRoot(),'assets');const filename=path.resolve(root,name);
    if(url.hostname!=='assets'||!filename.startsWith(root+path.sep))return new Response('Forbidden',{status:403});
    return net.fetch(pathToFileURL(filename).href);
  });
  try { verifyResources();resourcesReady=true; } catch(error) { fault(String(error)); }
  panel=new BrowserWindow({ ...initialPanelPosition(),width:PANEL_WIDTH,height:PANEL_HEIGHT,resizable:false,frame:false,transparent:true,hasShadow:true,show:false,type:'panel',focusable:false,alwaysOnTop:true,skipTaskbar:true,title:'Steady',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false} });
  panel.setAlwaysOnTop(true,'floating'); panel.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}); secureWindow(panel);
  panel.on('close',()=>{if(!quitting)app.quit();});
  let panelGeometryTimer: ReturnType<typeof setTimeout> | undefined;
  knownPanelOrigin=panel.getBounds();
  panel.on('move',()=>{
    const bounds=panel?.getBounds();
    if(movingPanelProgrammatically){if(bounds)knownPanelOrigin=bounds;return;}
    if(!bounds || (knownPanelOrigin?.x===bounds.x && knownPanelOrigin?.y===bounds.y))return;
    knownPanelOrigin=bounds; panelGeometryPending=true; const epoch=++panelGeometryEpoch;
    clearTimeout(panelGeometryTimer);
    void pause('Panel moved; input paused.');
    panelGeometryTimer=setTimeout(()=>{void configuration.run(async()=>{
      if(canvasCapture.active)invalidateCanvas();generation++;await configureControl();publish();
    }).catch(error=>fault(String(error))).finally(()=>{if(epoch===panelGeometryEpoch)panelGeometryPending=false;});},100);
  });
  installIPC();await loadView(panel,'panel');panel.showInactive();
  voice=new ElectronVoice({buildDir:__dirname,voiceRoot:path.join(resourcesRoot(),'voice'),packaged:app.isPackaged,userData:app.getPath('userData'),
    panel:()=>panel,windows:()=>[panel,settings],execute:executeVoiceCommand,microphoneChanged:open=>{status.microphoneEnabled=open;publish();}});
  voice.start();
  app.on('browser-window-focus',()=>voice?.appFocused());
  await startNative(); installBindings();
  powerMonitor.on('suspend',()=>{void pause('suspend');});
  powerMonitor.on('lock-screen',()=>{void pause('lock-screen');});
  powerMonitor.on('resume',()=>{void pause('Wake requires explicit Resume');for(const win of [panel,settings])win?.webContents.send('steady:resync-clocks');void supervisor?.synchronize().catch(error=>fault(String(error)));});
  const layout = new DisplayLayoutGuard(screen.getAllDisplays());
  const displayChanged=()=>{
    if (!layout.changed(screen.getAllDisplays())) return;
    void configuration.run(async()=>{
      await pause('Display geometry changed; canvas invalidated');
      generation++;status.canvasConfirmed=false;buttons=[];
      // Pause refreshes native metadata; ping returns its authoritative displays.
      await supervisor?.request('ping',{senderTimestamp:performance.now()});
      invalidateCanvas(); await configureControl();publish();
    }).catch(error=>fault(String(error)));
  };
  screen.on('display-added',displayChanged);screen.on('display-removed',displayChanged);screen.on('display-metrics-changed',displayChanged);
  publish();
}
app.on('before-quit',event=>{
  if(shutdownStarted)return;event.preventDefault();shutdownStarted=true;quitting=true;bindingInstaller.clear();
  stopLiveProbe();
  void Promise.allSettled([voice?.stop(),supervisor?.stop()]).finally(()=>app.quit());
});
app.on('window-all-closed',()=>{if(!quitting)app.quit();});
void main().catch(error=>fault(String(error)));
