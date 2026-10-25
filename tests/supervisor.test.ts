import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
const fake=vi.hoisted(()=>({child:null as any,release:vi.fn(),hold:new Set<string>(),held:[] as (()=>void)[],spawnCalls:[] as unknown[][],beforeAck:null as null|((request:any)=>void),transform:null as null|((request:any,payload:any)=>any)}));
vi.mock('node:child_process',()=>({spawn:(...args:unknown[])=>{fake.spawnCalls.push(args);return fake.child;},spawnSync:fake.release}));
import { NativeSupervisor } from '../src/main/supervisor';
import type { NativeState } from '../src/shared/contracts';
const state:NativeState={state:'PAUSED',reason:'test',buttonDown:false,foregroundTarget:null,permissions:{accessibility:false,camera:'notDetermined',microphone:'notDetermined',speech:'notDetermined'},generation:0,latestValidFrame:null};
beforeEach(()=>{
  vi.useRealTimers();fake.release.mockReset();fake.hold.clear();fake.held=[];fake.spawnCalls=[];fake.beforeAck=null;fake.transform=null;let replySeq=0;
  const child=new EventEmitter() as any;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdin=Object.assign(new EventEmitter(),{destroy:vi.fn(),end:vi.fn(),write:vi.fn((line:string,callback:()=>void)=>{
    const request=JSON.parse(line);queueMicrotask(()=>{const acknowledge=()=>{fake.beforeAck?.(request);const payload={requestSeq:request.seq,accepted:true,code:'ok',state,nativeTimestamp:performance.now(),...(request.type==='hello'?{protocolVersion:1,displays:[],capabilities:['fake-input'],targetPid:123}:{})};child.stdout.emit('data',Buffer.from(JSON.stringify({v:1,session:request.session,seq:++replySeq,type:'ack',payload:fake.transform?.(request,payload)??payload})+'\n'));};if(fake.hold.has(request.type))fake.held.push(acknowledge);else acknowledge();callback?.();});return true;
  })});fake.child=child;
});
describe('native supervision',()=>{
  it('performs hello and eight clock probes, accepts state, releases on EOF',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();
    expect(fake.child.stdin.write).toHaveBeenCalledTimes(9);expect(supervisor.state).toEqual(state);
    fake.child.emit('exit',0);expect(fake.release).toHaveBeenCalledWith('/fake/helper',['--release-and-exit'],expect.anything());
    await supervisor.stop();
  });
  it('faults and releases at the 500ms acknowledgment deadline',async()=>{
    vi.useFakeTimers();fake.child.stdin.write.mockImplementation(()=>true);
    const supervisor=new NativeSupervisor('/fake/helper',false);const faults:string[]=[];supervisor.on('fault',value=>faults.push(value));
    const start=supervisor.start();const rejection=expect(start).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(500);await rejection;
    expect(faults).toEqual(['Native acknowledgment timeout']);expect(fake.release).toHaveBeenCalled();vi.useRealTimers();
  });
  it('rejects replaced reply sessions',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();const faults:string[]=[];supervisor.on('fault',x=>faults.push(x));
    fake.child.stdout.emit('data',Buffer.from(JSON.stringify({v:1,session:'00000000-0000-4000-8000-000000000001',seq:100,type:'state',payload:state})+'\n'));
    expect(faults[0]).toMatch(/session/);await supervisor.stop();
  });
  it('drops a latest old-generation sample queued behind an in-flight sample before configure',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();
    fake.hold.add('sample');fake.hold.add('configure');
    const sample=(frameId:number,generation=1)=>({generation,frameId,captureTimestamp:performance.now(),mode:'head' as const,valid:true,anchor:{x:.5,y:.5},qualityReason:'valid'});
    supervisor.submit(sample(1),{x:100,y:100},performance.now());
    supervisor.submit(sample(2),{x:110,y:100},performance.now());
    const configure=supervisor.request('configure',{generation:2,targetBundleId:'org.krita',targetPid:123,displayId:1,canvas:null,excludedRects:[]});
    supervisor.submit(sample(3,2),{x:120,y:100},performance.now());
    await Promise.resolve();expect(fake.held).toHaveLength(2);
    const acknowledgments=fake.held.splice(0);for(const ack of acknowledgments)ack();await configure;await Promise.resolve();
    const requests=()=>fake.child.stdin.write.mock.calls.map((call:any[])=>JSON.parse(call[0]));
    expect(requests().filter((r:any)=>r.type==='sample')).toHaveLength(1);
    fake.hold.clear();supervisor.submit(sample(4,2),{x:130,y:100},performance.now());
    await Promise.resolve();await Promise.resolve();
    expect(requests().filter((r:any)=>r.type==='sample').at(-1).payload).toMatchObject({generation:2,frameId:4});
    await supervisor.stop();
  });
  it('drops samples during an eight-round-trip clock refresh without terminating the helper',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();
    const faults:string[]=[];supervisor.on('fault',x=>faults.push(x));fake.hold.add('ping');
    const refresh=supervisor.synchronize().then(()=>null,error=>error);
    supervisor.submit({generation:1,frameId:1,captureTimestamp:performance.now(),mode:'head',valid:true,anchor:{x:.5,y:.5},qualityReason:'valid'},{x:100,y:100},performance.now());
    await Promise.resolve();fake.hold.clear();for(const ack of fake.held.splice(0))ack();
    expect(await refresh).toBeNull();expect(faults).toEqual([]);
    await supervisor.request('action',{generation:0,eventId:'still-alive',actionId:'pause'});
    await supervisor.stop();
  });

});


describe('phase03 input supervision',()=>{
  it('routes target discovery and selects the explicit fake backend for desktop-free integration',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',false,true);const targets:(number|null)[]=[];supervisor.on('target',value=>targets.push(value));
    await supervisor.start();expect(targets).toEqual([123]);expect(fake.spawnCalls[0]?.[1]).toEqual(['--test-fake-backend','--test-system-displays']);await supervisor.stop();
  });
  it('keeps only the most recent sample while a prior acknowledgment is outstanding',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();fake.hold.add('sample');
    for(let frameId=1;frameId<=10;frameId++)supervisor.submit({generation:1,frameId,captureTimestamp:performance.now(),mode:'head',valid:true,anchor:{x:.5,y:.5},qualityReason:'valid'},{x:frameId,y:100},performance.now());
    await Promise.resolve();expect(fake.held).toHaveLength(1);fake.hold.clear();fake.held.shift()!();
    await new Promise(resolve=>setImmediate(resolve));
    const frames=fake.child.stdin.write.mock.calls.map((call:any[])=>JSON.parse(call[0])).filter((request:any)=>request.type==='sample').map((request:any)=>request.payload.frameId);
    expect(frames).toEqual([1,10]);await supervisor.stop();
  });
  it('pauses and resynchronizes eight trips when uncertainty exceeds ten milliseconds',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();
    let now=1000,pings=0;const clock=vi.spyOn(performance,'now').mockImplementation(()=>now);
    fake.beforeAck=request=>{if(request.type==='ping'){pings++;now+=pings<=8?24:2;}};
    const uncertainty:number[]=[];supervisor.on('clock-uncertain',value=>uncertainty.push(value));
    try{
      await supervisor.synchronize();expect(pings).toBe(16);expect(uncertainty).toEqual([12]);expect(supervisor.clock.uncertainty).toBe(1);
      const actions=fake.child.stdin.write.mock.calls.map((call:any[])=>JSON.parse(call[0])).filter((request:any)=>request.type==='action');
      expect(actions).toHaveLength(1);expect(actions[0].payload.actionId).toBe('pause');
    }finally{clock.mockRestore();await supervisor.stop();}
  });
  it('fails closed and releases if both eight-trip estimates remain uncertain',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();
    let now=1000;const clock=vi.spyOn(performance,'now').mockImplementation(()=>now);fake.beforeAck=request=>{if(request.type==='ping')now+=24;};
    const faults:string[]=[];supervisor.on('fault',value=>faults.push(value));
    try{await expect(supervisor.synchronize()).rejects.toThrow('after resynchronization');expect(faults).toEqual(['Clock uncertainty exceeds 10 ms after resynchronization']);expect(fake.release).toHaveBeenCalled();}
    finally{clock.mockRestore();await supervisor.stop();}
  });
  it('refreshes after thirty seconds without posting a resume',async()=>{
    vi.useFakeTimers();const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const requests=fake.child.stdin.write.mock.calls.map((call:any[])=>JSON.parse(call[0]));
    expect(requests.filter((request:any)=>request.type==='ping')).toHaveLength(16);expect(requests.some((request:any)=>request.payload.actionId==='resume')).toBe(false);
    await supervisor.stop();vi.useRealTimers();
  });
  it('rejects protocol mismatches and releases the session',async()=>{
    fake.transform=(request,payload)=>request.type==='hello'?{...payload,protocolVersion:2}:payload;
    const supervisor=new NativeSupervisor('/fake/helper',false);const faults:string[]=[];supervisor.on('fault',value=>faults.push(value));
    await expect(supervisor.start()).rejects.toThrow('Invalid native reply');expect(faults).toHaveLength(1);expect(fake.release).toHaveBeenCalled();await supervisor.stop();
  });
  it('passes the real-input flag to the release executable after helper death',async()=>{
    const supervisor=new NativeSupervisor('/fake/helper',true);await supervisor.start();fake.child.emit('exit',1);
    expect(fake.release).toHaveBeenCalledWith('/fake/helper',['--release-and-exit','--real-input'],expect.anything());await supervisor.stop();
  });
});

it('reports timing only as a posted update when native acknowledges a movement post',async()=>{
  const supervisor=new NativeSupervisor('/fake/helper',false);await supervisor.start();const timings:any[]=[];supervisor.on('sample-timing',value=>timings.push(value));
  const submit=(frameId:number)=>supervisor.submit({generation:1,frameId,captureTimestamp:performance.now(),mode:'head',valid:true,anchor:{x:.5,y:.5},qualityReason:'valid'},{x:100,y:100},performance.now());
  submit(1);await new Promise(resolve=>setImmediate(resolve));expect(timings[0]).toMatchObject({frameId:1,posted:false,state:'PAUSED'});
  fake.transform=(request,payload)=>request.type==='sample'?{...payload,code:'move-posted',state:{...state,state:'HOVER'}}:payload;
  submit(2);await new Promise(resolve=>setImmediate(resolve));expect(timings[1]).toMatchObject({frameId:2,posted:true,state:'HOVER'});expect(timings[1].nativeActionTimestamp).toEqual(expect.any(Number));await supervisor.stop();
});

it('handles EPIPE from both the write callback and stream error exactly once', async () => {
  const supervisor = new NativeSupervisor('/fake/helper', false); await supervisor.start();
  const faults: string[] = []; supervisor.on('fault', value => faults.push(value));
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  fake.child.stdin.write.mockImplementation((_line: string, callback: (error: Error) => void) => {
    queueMicrotask(() => { callback(error); fake.child.stdin.emit('error', error); }); return false;
  });
  await expect(supervisor.request('ping', { senderTimestamp: performance.now() })).rejects.toThrow('EPIPE');
  expect(faults).toHaveLength(1); expect(fake.release).toHaveBeenCalled();
  await expect(supervisor.request('ping', { senderTimestamp: performance.now() })).rejects.toThrow('unavailable');
  await supervisor.stop();
  expect(() => fake.child.stdin.emit('error', error)).not.toThrow();
});
it('rejects a synchronous pipe write failure and a pipe already closed before write', async () => {
  const supervisor = new NativeSupervisor('/fake/helper', false); await supervisor.start();
  fake.child.stdin.writableEnded = true;
  await expect(supervisor.request('ping', { senderTimestamp: performance.now() })).rejects.toThrow('unavailable');
  fake.child.stdin.writableEnded = false;
  fake.child.stdin.write.mockImplementation(() => { throw new Error('write EPIPE'); });
  await expect(supervisor.request('ping', { senderTimestamp: performance.now() })).rejects.toThrow('EPIPE');
  await supervisor.stop();
});
