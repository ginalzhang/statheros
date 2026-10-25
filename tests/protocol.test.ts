import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/protocol-v1.json';
import { ClockSync, LineDecoder, validRequest, validReply } from '../src/main/protocol';

describe('shared protocol fixtures',()=>{
  it('accepts every positive request',()=>{for(const item of fixtures.positive)expect(validRequest(item)).toBe(true);});
  it('rejects every negative request',()=>{for(const item of fixtures.negative){let value;try{value=JSON.parse(item.line);}catch{value=null;}expect(validRequest(value),item.name).toBe(false);}});
  it('frames split UTF-8 and coalesced lines',()=>{
    const decoder=new LineDecoder();const input=Buffer.from('{"text":"é"}\n{"v":1}\n');
    const split=input.indexOf(0xc3)+1;expect(decoder.push(input.subarray(0,split))).toEqual([]);
    expect(decoder.push(input.subarray(split))).toEqual([{text:'é'},{v:1}]);
  });
  it('rejects invalid UTF-8 and oversized unterminated frames',()=>{
    expect(()=>new LineDecoder().push(Buffer.from([0xff,10]))).toThrow();
    expect(()=>new LineDecoder().push(Buffer.alloc(16385,32))).toThrow('oversized');
  });
});

describe('canvas protocol',()=>{
  const envelope = {v:1,session:'00000000-0000-4000-8000-000000000001',seq:1};
  const payload = { generation: 1, targetPid: 123, windowId: 'window', windowBounds: {x:-100,y:0,width:900,height:700}, windowToken: 'document', layoutToken: 'layout', diagnostics: null, workspaceSuggestion: null, rect: {x:-100,y:0,width:500,height:400}, kind: 'viewport', availability: 'available', reason: 'Viewport', observedAt: 100 };
  it('accepts explicit canvas observations and unavailable results',()=>{
    expect(validReply({...envelope,type:'canvasObservation',payload})).toBe(true);
    expect(validReply({...envelope,type:'canvasObservation',payload:{...payload,availability:'unavailable',rect:null,kind:null,windowId:null,layoutToken:null}})).toBe(true);
    for (const patch of [{generation:-1},{rect:null},{targetPid:null},{windowId:null},{kind:'window'},{observedAt:-1},{availability:'guess'},{layoutToken:''},{windowBounds:{x:0,y:0,width:-1,height:100}},{windowToken:5}]) expect(validReply({...envelope,type:'canvasObservation',payload:{...payload,...patch}})).toBe(false);
    for (const patch of [{title:'Private document'}, {windowBounds:{...payload.windowBounds,title:'Private document'}}, {rect:{...payload.rect,text:'Private document'}}]) expect(validReply({...envelope,type:'canvasObservation',payload:{...payload,...patch}})).toBe(false);
    expect(validReply({...envelope,type:'canvasObservation',payload:{...payload,availability:'unavailable',kind:null,rect:null,layoutToken:null}})).toBe(true);
  });
  it('restricts focus restoration to an explicit valid PID',()=>{
    expect(validRequest({...envelope,type:'restoreTarget',payload:{targetPid:123}})).toBe(true);
    for(const targetPid of [0,-1,1.5,2147483648,'123',null]) expect(validRequest({...envelope,type:'restoreTarget',payload:{targetPid}})).toBe(false);
    expect(validRequest({...envelope,type:'restoreTarget',payload:{targetPid:123,bundleId:'other'}})).toBe(false);
  });
  it('carries an untrusted workspace suggestion without claiming an identified viewport',()=>{
    const suggested = {...payload,availability:'unavailable',kind:null,rect:null,workspaceSuggestion:{x:0,y:50,width:600,height:500}};
    expect(validReply({...envelope,type:'canvasObservation',payload:suggested})).toBe(true);
    for (const workspaceSuggestion of [{x:-500,y:0,width:600,height:500},{x:0,y:0,width:99,height:500},{x:0,y:0,width:600,height:500,title:'Private'}]) expect(validReply({...envelope,type:'canvasObservation',payload:{...suggested,workspaceSuggestion}})).toBe(false);
    expect(validReply({...envelope,type:'canvasObservation',payload:{...suggested,windowBounds:null}})).toBe(false);
  });
  it('accepts bounded structural diagnostics and rejects raw labels, paths and oversized reports',()=>{
    const node = { path:'0/1',role:'AXGroup',subrole:'',identifier:'qt_scrollarea_viewport',bounds:{x:0,y:0,width:500,height:400},childCount:2 };
    const diagnostics = { inspected:117,complete:true,truncated:false,windowSource:'ax',nodes:[node] };
    const valid = (value:unknown) => validReply({...envelope,type:'canvasObservation',payload:{...payload,diagnostics:value}});
    expect(valid(diagnostics)).toBe(true);
    for (const patch of [{nodes:Array.from({length:33},()=>node)},{nodes:[{...node,identifier:'/Users/artist/private.kra'}]},
      {nodes:[{...node,title:'Private document'}]},{nodes:[{...node,path:'user-document-name'}]},
      {nodes:[{...node,bounds:{...node.bounds,title:'Private document'}}]},
      {nodes:[{...node,identifier:'canvasPrivateSketch'}]},{nodes:[{...node,role:'PrivateDocument'}]},
      {nodes:[{...node,childCount:-1}]},{inspected:4097},{windowSource:'screenshot'}]) expect(valid({...diagnostics,...patch})).toBe(false);
  });
});
describe('clock synchronization',()=>{
  it('requires eight trips and selects smallest RTT',()=>{
    const sync=new ClockSync();expect(()=>sync.choose([],100)).toThrow();
    sync.choose(Array.from({length:8},(_,i)=>({sent:i*10,received:i*10+(i===3?2:10),native:i*10+101})),100);
    expect(sync.offset).toBe(100);expect(sync.convert(200,100)).toBe(300);
  });
  it('rejects uncertain and expired clocks',()=>{
    const sync=new ClockSync();expect(()=>sync.convert(1,0)).toThrow();
    sync.choose(Array.from({length:8},()=>({sent:0,received:22,native:100})),0);expect(()=>sync.convert(1,0)).toThrow();
    sync.choose(Array.from({length:8},()=>({sent:0,received:2,native:100})),0);expect(()=>sync.convert(1,30001)).toThrow();
  });
});
