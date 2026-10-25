import Foundation

public protocol InputBackend: AnyObject, Sendable {
 var isReal:Bool {get}
 func setTarget(pid:Int32)
 @discardableResult func restoreTarget(pid:Int32)->Bool
 func kritaPid()->Int32?
 func permissions()->Permissions
 func foreground()->(bundle:String,pid:Int32)?
 func displays()->[DisplayInfo]
 @discardableResult func move(_ point:Point,dragging:Bool)->Bool
 @discardableResult func button(_ down:Bool,at:Point)->Bool
 @discardableResult func shortcut(_ action:ActionID)->Bool
}
public final class FakeBackend: InputBackend, @unchecked Sendable {
 public let isReal:Bool
 private let lock=NSLock();private var storage:[String]=[];private var positionStorage:[Point]=[]
 private var reportReads=0
 public var metadataReads:Int{lock.withLock{reportReads}}
 public var beforeNextMetadataRead:(@Sendable ()->Void)?
 public var rejectPosts=false;public var rejectReleases=false;public var failReleaseAfterNextDown=false;public var accessibility=true
 public var positions:[Point]{lock.withLock{positionStorage}}
 public var events:[String]{lock.withLock{storage}}
 public var foregroundBundle="org.krita";public var foregroundPid:Int32=123
 public var displayInfos=[DisplayInfo(id:1,bounds:Rect(x:-1200,y:0,width:1200,height:900),workArea:Rect(x:-1200,y:24,width:1200,height:876),builtIn:true,primary:true,scaleFactor:2)]
 public init(realFlag:Bool=false){isReal=realFlag}
 public func setTarget(pid:Int32){}
 @discardableResult public func restoreTarget(pid:Int32)->Bool{guard pid==kritaPid() else{return false};foregroundBundle="org.krita";foregroundPid=pid;return true}
 public func kritaPid()->Int32?{foregroundBundle=="org.krita" ? foregroundPid : 123}
 private func reportRead(){let callback=lock.withLock{reportReads+=1;let callback=beforeNextMetadataRead;beforeNextMetadataRead=nil;return callback};callback?()}
 public func permissions()->Permissions{reportRead();return Permissions(accessibility:accessibility,camera:"fake",microphone:"fake",speech:"fake")}
 public func foreground()->(bundle:String,pid:Int32)?{reportRead();return (foregroundBundle,foregroundPid)}
 public func displays()->[DisplayInfo]{reportRead();return displayInfos}
 private func append(_ e:String){lock.withLock{storage.append(e)}}
 @discardableResult public func move(_ p:Point,dragging:Bool)->Bool{guard !rejectPosts else{return false};lock.withLock{positionStorage.append(p)};append(dragging ? "drag" : "move");return true}
 @discardableResult public func button(_ d:Bool,at:Point)->Bool{guard d ? !rejectPosts : !rejectReleases else{return false};append(d ? "down" : "up");if d && failReleaseAfterNextDown {rejectReleases=true;failReleaseAfterNextDown=false};return true}
 @discardableResult public func shortcut(_ a:ActionID)->Bool{guard !rejectPosts else{return false};append(a.rawValue);return true}
}
public final class NativeEngine: @unchecked Sendable {
 private let lock=NSRecursiveLock();public let backend:any InputBackend
 private var state:NativeState
 private var session:String?;private var lastSeq:UInt64?;private var responseSeq:UInt64=0
 private var targetPid:Int32=0;private var display:DisplayInfo?;private var canvas:Rect?;private var excluded:[Rect]=[]
 private var reportedDisplays:[DisplayInfo]=[];private var foregroundPid:Int32?;private var discoveredTargetPid:Int32?
 private var position=Point(x:0,y:0);private var lastCapture:Double?;private var lastFrame:UInt64?;private var validSince:Double?
 private var events=Set<String>();private var closed=false
 private var displayChangePending=false;private var displayChangeEpoch:UInt64=0
 private var setupStartedAt:Double?
 private var realDeadline:Double?
 private let boundedProbe:Bool
 public init(backend:any InputBackend,boundedProbe:Bool=false){self.backend=backend;self.boundedProbe=boundedProbe;state=NativeState(permissions:backend.permissions());refreshMetadata()}
 public var snapshot:NativeState {lock.withLock{state}}
 /// Platform reporting may block. Collect outside the input lock and never on the freshness timer.
 public func refreshMetadata(){
  let permissions=backend.permissions(),foreground=backend.foreground(),displays=backend.displays(),kritaPid=backend.kritaPid()
  lock.withLock{guard !closed else{return};applyMetadata(permissions:permissions,foreground:foreground,displays:displays,kritaPid:kritaPid)}
 }
 private func applyMetadata(permissions:Permissions,foreground:(bundle:String,pid:Int32)?,displays:[DisplayInfo],kritaPid:Int32?) {
  let changed=reportedDisplays.count != displays.count || reportedDisplays.contains{old in !displays.contains{$0.id==old.id && $0.bounds==old.bounds && $0.scaleFactor==old.scaleFactor}}
  state.permissions=permissions;state.foregroundTarget=foreground?.bundle;foregroundPid=foreground?.pid;reportedDisplays=displays;discoveredTargetPid=kritaPid
  if (state.state == .setup || state.state == .hover || state.state == .drawing) && !guarded() {pause("foreground-or-permission-change")}
  if display != nil && changed {invalidateDisplay()}
 }
 /// Raw callbacks release immediately, but equivalent geometry need not erase calibration setup.
 @discardableResult public func beginDisplayChange()->UInt64{lock.withLock{
  displayChangePending=true;displayChangeEpoch &+= 1;guard release() else{return displayChangeEpoch};validSince=nil
  if state.state != .fault {state.state = .paused;state.reason="display-change-pending"}
  return displayChangeEpoch
 }}
 /// Platform reporting remains outside the input/watchdog lock. Newer callbacks win.
 public func endDisplayChange(epoch:UInt64){
  guard lock.withLock({!closed && displayChangePending && epoch==displayChangeEpoch}) else{return}
  let permissions=backend.permissions(),foreground=backend.foreground(),displays=backend.displays(),kritaPid=backend.kritaPid()
  lock.withLock{guard !closed,displayChangePending,epoch==displayChangeEpoch else{return}
   applyMetadata(permissions:permissions,foreground:foreground,displays:displays,kritaPid:kritaPid);displayChangePending=false
   if state.state != .fault {state.state = .paused;if state.reason != "display-reconfigured"{state.reason="display-change-complete"}}
  }
 }
 public func invalidateDisplay(){lock.withLock{let released=release();canvas=nil;display=nil;validSince=nil;guard released else{return};if state.state != .fault {state.state = .paused};state.reason="display-reconfigured"}}
 @discardableResult private func release()->Bool {
  guard backend.button(false,at:position) else{state.state = .fault;state.reason="native-release-failed";validSince=nil;return false}
  if backend.isReal {state.lastReleaseTimestamp=monotonicMilliseconds()};state.buttonDown=false;return true
 }
 public func pause(_ reason:String,fault:Bool=false){lock.withLock{guard release() else{return};state.state=fault || state.state == .fault ? .fault : .paused;state.reason=reason;validSince=nil}}
 public func disconnect(){lock.withLock{let released=release();closed=true;guard released else{return};state.state = .paused;state.reason="parent-eof"}}
 public func report(_ reason:String){refreshMetadata();lock.withLock{state.reason=reason}}
 public func emergencyRelease(){lock.withLock{guard release() else{return};if state.state != .fault {state.state = .paused};state.reason="emergency-release"}}
 private func guarded()->Bool{state.permissions.accessibility && state.foregroundTarget=="org.krita" && foregroundPid==targetPid}
 public func watchdog(now:Double){lock.withLock{
  guard !closed else{return}
  if state.state == .fault && state.buttonDown {_ = release();return}
  if let deadline=realDeadline,now>=deadline {guard release() else{return};state.state = .paused;state.reason="probe-deadline";realDeadline=nil;validSince=nil;return}
  if state.state == .drawing || state.state == .hover || state.state == .setup {
   if (lastCapture ?? setupStartedAt).map({now-$0 >= 250}) ?? true {guard release() else{return};state.state = .paused;state.reason="stale-capture";validSince=nil;return}
   guard guarded() else {guard release() else{return};state.state = .paused;state.reason="foreground-or-permission-change";validSince=nil;return}
  }
 }}
 private func encodeState()->JSONValue {
  var value=JSONValue.encoded(state).object ?? [:]
  value["foregroundTarget"]=state.foregroundTarget.map(JSONValue.string) ?? .null
  value["latestValidFrame"]=state.latestValidFrame.map{.number(Double($0))} ?? .null
  return .object(value)
 }
 private func reply(_ req:Envelope,accepted:Bool,code:String,now:Double,extra:[String:JSONValue]=[:])->Envelope {
  responseSeq+=1
  var p:[String:JSONValue]=["requestSeq":.number(Double(req.seq)),"accepted":.bool(accepted),"code":.string(code),"state":encodeState(),"nativeTimestamp":.number((req.type=="action" || req.type=="sample") && accepted && backend.isReal ? monotonicMilliseconds() : now)]
  p.merge(extra){_,new in new}
  return Envelope(session:session ?? req.session,seq:responseSeq,type:"ack",payload:.object(p))
 }
 public func faultReply(session fallback:String,code:String)->Envelope{lock.withLock{pause(code,fault:true);responseSeq+=1;return Envelope(session:session ?? fallback,seq:responseSeq,type:"fault",payload:.object(["code":.string(code),"message":.string(code)]))}}
 public func event(type:String,payload:JSONValue)->Envelope?{lock.withLock{guard let session else{return nil};responseSeq+=1;return Envelope(session:session,seq:responseSeq,type:type,payload:payload)}}
 public func handle(_ req:Envelope,now:Double)->Envelope {
  if req.type != "ping" && req.type != "sample" {refreshMetadata()}
  var restorePid:Int32?
  var response=lock.withLock{
  guard !closed else{return reply(req,accepted:false,code:"closed",now:now)}
  if session == nil {
   guard req.type=="hello" else{return reply(req,accepted:false,code:"hello-required",now:now)}
   session=req.session
  }
  guard req.session==session else {pause("session-mismatch",fault:true);return reply(req,accepted:false,code:"session-mismatch",now:now)}
  guard lastSeq == nil || req.seq>lastSeq! else{return reply(req,accepted:false,code:"sequence",now:now)}
  lastSeq=req.seq
  let p=req.payload.object ?? [:]
  if req.type=="hello" {
   guard req.seq==0 || responseSeq==0 else{return reply(req,accepted:false,code:"already-hello",now:now)}
   return reply(req,accepted:true,code:"hello",now:now,extra:["protocolVersion":.number(1),"displays":.encoded(reportedDisplays),"targetPid":discoveredTargetPid.map{.number(Double($0))} ?? .null,"capabilities":.array([.string(backend.isReal ? (boundedProbe ? "bounded-real-input" : "real-input") : "fake-input"),.string("voice-deferred-phase01"),.string("watchdog-10ms"),.string("canvas-accessibility")])])
  }
  var resultCode="ok"
  switch req.type {
  case "configure":
   guard !displayChangePending else{return reply(req,accepted:false,code:"display-reconfiguration-pending",now:now)}
   guard state.state != .fault else{return reply(req,accepted:false,code:"fresh-session-required",now:now)}
   guard let generation=p["generation"]?.uint,generation>state.generation,let pid=p["targetPid"]?.uint,let did=p["displayId"]?.uint,let d=reportedDisplays.first(where:{UInt64($0.id)==did}) else{return reply(req,accepted:false,code:"configuration",now:now)}
   let c = p["canvas"] == .null ? nil : try? p["canvas"]?.decode(Rect.self)
   let rs=(try? p["excludedRects"]?.decode([Rect].self)) ?? []
   if let c, (c.width<100 || c.height<100 || !d.bounds.contains(c) || rs.contains(where:{$0.intersects(c)})) {return reply(req,accepted:false,code:"canvas-bounds",now:now)}
   guard release() else{return reply(req,accepted:false,code:"native-release-failed",now:now)};targetPid=Int32(pid);backend.setTarget(pid:targetPid);display=d;canvas=c;excluded=rs;state.generation=generation;state.state = c==nil ? .setup : .paused;state.reason="configured";setupStartedAt=c==nil ? now : nil;lastCapture=nil;lastFrame=nil;state.latestValidFrame=nil;state.lastValidCaptureTimestamp=nil;validSince=nil;events.removeAll()
  case "sample":
   guard p["generation"]?.uint==state.generation,state.generation>0 else{return reply(req,accepted:false,code:"generation",now:now)}
   guard !displayChangePending else{return reply(req,accepted:true,code:"display-change-pending",now:now)}
   guard let frame=p["frameId"]?.uint,lastFrame==nil || frame>lastFrame!, let capture=p["captureTimestamp"]?.number, capture<=now+10, now-capture<250, lastCapture==nil || capture>lastCapture! else{return reply(req,accepted:false,code:"stale-or-unordered",now:now)}
   lastFrame=frame
   guard p["valid"]?.bool==true,let mappedPoint=try? p["position"]?.decode(Point.self),let display,mappedPoint.x>=display.bounds.x,mappedPoint.y>=display.bounds.y,mappedPoint.x<=display.bounds.x+display.bounds.width,mappedPoint.y<=display.bounds.y+display.bounds.height else{validSince=nil;return reply(req,accepted:true,code:"invalid-sample",now:now)}
   // The fixed mapping formula reaches the mathematical max edge at fraction1.
   // Quartz display interiors are half-open; project only that exact boundary
   // inward by one representable logical value, never into a neighboring display.
   let point=Point(x:min(mappedPoint.x,(display.bounds.x+display.bounds.width).nextDown),y:min(mappedPoint.y,(display.bounds.y+display.bounds.height).nextDown))
   if let old=lastCapture,capture-old>=250 {validSince=nil}
   lastCapture=capture;state.lastValidCaptureTimestamp=capture;state.latestValidFrame=frame;if validSince==nil {validSince=capture}
   position=point
   if excluded.contains(where:{$0.contains(point)}) {if state.buttonDown {guard release() else{return reply(req,accepted:false,code:"native-release-failed",now:now)};state.state = .hover};state.reason="panel-excluded"}
   if state.buttonDown && !(canvas?.contains(point) ?? false) {guard release() else{return reply(req,accepted:false,code:"native-release-failed",now:now)};state.state = .hover;state.reason="canvas-exit"}
   if state.state == .hover || state.state == .drawing || state.state == .setup {
    guard guarded() else{pause("foreground-or-permission-change");return reply(req,accepted:false,code:"foreground-or-permission",now:now)}
    guard backend.move(point,dragging:state.buttonDown) else{pause("native-post-guard");return reply(req,accepted:false,code:"native-post-guard",now:now)}
    resultCode="move-posted"
   }
  case "action":
   // Safety release attempts must survive stale generations and event-capacity rejection.
   if p["actionId"]?.string == "pause" || p["actionId"]?.string == "penUp" {guard release() else{return reply(req,accepted:false,code:"native-release-failed",now:now)};if state.state == .drawing {state.state = .hover}}
   guard p["generation"]?.uint==state.generation,let event=p["eventId"]?.string,let raw=p["actionId"]?.string,let action=ActionID(rawValue:raw) else{return reply(req,accepted:false,code:"generation",now:now)}
   guard !events.contains(event) else{return reply(req,accepted:false,code:"duplicate-event",now:now)}
   guard events.count<4096 else{pause("event-capacity");return reply(req,accepted:false,code:"event-capacity-reconfigure",now:now)}
   events.insert(event)
   let code=perform(action,now:now)
   if code != "ok" {return reply(req,accepted:false,code:code,now:now)}
  case "restoreTarget":
   guard let pid=p["targetPid"]?.uint,pid>0,pid<=UInt64(Int32.max),Int32(pid)==discoveredTargetPid else{return reply(req,accepted:false,code:"target-unavailable",now:now)}
   guard release() else{return reply(req,accepted:false,code:"native-release-failed",now:now)}
   state.state = state.state == .fault ? .fault : .paused;validSince=nil
   restorePid=Int32(pid);resultCode="target-activation-requested"
  case "ping":return reply(req,accepted:true,code:"pong",now:now,extra:["senderTimestamp":p["senderTimestamp"] ?? .null,"displays":.encoded(reportedDisplays),"targetPid":discoveredTargetPid.map{.number(Double($0))} ?? .null])
  case "microphone":
   // Compatibility requests cannot enable native speech; Electron owns voice capture.
   guard p["enabled"]?.bool==false else{return reply(req,accepted:false,code:"voice-deferred-phase01",now:now)}
   return reply(req,accepted:true,code:"scheduled",now:now)
  case "installSpeechAssets":return reply(req,accepted:false,code:"voice-deferred-phase01",now:now)
  case "shutdown":let released=release();closed=true;guard released else{return reply(req,accepted:false,code:"native-release-failed",now:now)};state.state = .paused;state.reason="shutdown"
  default:return reply(req,accepted:false,code:"type",now:now)
  }
  return reply(req,accepted:true,code:resultCode,now:now)
  }
  // App activation may involve platform IPC; never hold the freshness/input lock.
  if let restorePid,!backend.restoreTarget(pid:restorePid),var payload=response.payload.object {
   payload["accepted"] = .bool(false);payload["code"] = .string("target-activation-failed");response.payload = .object(payload)
  }
  return response
 }
 private func perform(_ a:ActionID,now:Double)->String {
  switch a {
  case .pause,.penUp:guard release() else{return "native-release-failed"};state.state = a == .pause ? (state.state == .fault ? .fault : .paused) : (state.state == .drawing ? .hover : state.state);state.reason=a.rawValue;validSince = a == .pause ? nil : validSince;return "ok"
  case .microphoneOff:return "ok"
  case .recenter:pause("recenter-required");return "ok"
  default:break
  }
  guard state.state != .fault else{return "fault"}
  guard guarded() else{pause("foreground-or-permission-change");return "foreground-or-permission"}
  switch a {
  case .resume:
   guard !displayChangePending else{return "display-reconfiguration-pending"}
   guard state.state == .paused,canvas != nil,let since=validSince,now-since>=500,let last=lastCapture,now-last<250 else{return "prerequisites"}
   guard release() else{return "native-release-failed"};state.state = .hover;state.reason="resumed";if boundedProbe {realDeadline=now+15_000};return "ok"
  case .penDown,.penToggle:
   if a == .penToggle && state.buttonDown {guard release() else{return "native-release-failed"};state.state = .hover;return "ok"}
   guard state.state == .hover,canvas?.contains(position)==true,!excluded.contains(where:{$0.contains(position)}),let last=lastCapture,now-last<250 else{return "not-hover-or-canvas"}
   guard guarded() else{return "foreground"};guard backend.button(true,at:position) else{pause("native-post-guard");return "native-post-guard"};state.buttonDown=true;state.state = .drawing;return "ok"
  case .click:
   guard release() else{return "native-release-failed"};if state.state == .drawing {state.state = .hover}
   guard state.state == .hover,!excluded.contains(where:{$0.contains(position)}),canvas?.contains(position)==true,let last=lastCapture,now-last<250 else{return "not-hover-or-panel"}
   guard guarded() else{return "foreground"};guard backend.button(true,at:position) else{pause("native-post-guard");return "native-post-guard"};state.buttonDown=true;guard release() else{return "native-release-failed"};return "ok"
  case .undo,.redo,.brush,.toggleErase,.bigger,.smaller,.swapColors:
   guard release() else{return "native-release-failed"};if state.state == .drawing {state.state = .hover}
   guard state.state == .hover || state.state == .paused else{return "state"}
   guard guarded() else{return "foreground"};guard backend.shortcut(a) else{pause("native-post-guard");return "native-post-guard"};return "ok"
  case .markCorner:return "parent-canvas-marking-required"
  default:return "state"
  }
 }
}
