import Foundation
import Dispatch
import Darwin
import CoreGraphics
@preconcurrency import AppKit
import SteadyCore

private final class Writer:@unchecked Sendable {
 private let lock=NSLock()
 private func write(_ envelope:Envelope){do{var data=try JSONEncoder().encode(envelope);data.append(10);try FileHandle.standardOutput.write(contentsOf:data)}catch{}}
 @discardableResult func response(_ create:()->Envelope)->Envelope{lock.withLock{let e=create();write(e);return e}}
 func event(_ create:()->Envelope?){lock.withLock{if let e=create(){write(e)}}}
 func diagnostic(_ message:String){try? FileHandle.standardError.write(contentsOf:Data((message+"\n").utf8))}
}
private final class FramingBox:@unchecked Sendable {
 private let lock=NSLock();private var value=LineFramer()
 func feed(_ data:Data)throws->[Data]{try lock.withLock{try value.feed(data)}}
}
private final class NativeMetadataMonitor:@unchecked Sendable {
 private let engine:NativeEngine;private let queue=DispatchQueue(label:"org.steady.native.metadata",qos:.userInitiated);private let timer:DispatchSourceTimer
 private var foregroundObserver:(any NSObjectProtocol)?
 init(engine:NativeEngine){
  self.engine=engine;timer=DispatchSource.makeTimerSource(queue:queue);timer.schedule(deadline:.now(),repeating:.milliseconds(100));timer.setEventHandler{ @Sendable [engine] in engine.refreshMetadata()};timer.resume()
  CGDisplayRegisterReconfigurationCallback(steadyDisplayChanged,Unmanaged.passUnretained(self).toOpaque())
  foregroundObserver=NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:nil){ @Sendable [engine] _ in engine.pause("foreground-changed")}
 }
 func displayChanged(begin:Bool){let epoch=engine.beginDisplayChange();if !begin{queue.async{[engine] in engine.endDisplayChange(epoch:epoch)}}}
 deinit{timer.cancel();CGDisplayRemoveReconfigurationCallback(steadyDisplayChanged,Unmanaged.passUnretained(self).toOpaque());if let foregroundObserver{NSWorkspace.shared.notificationCenter.removeObserver(foregroundObserver)}}
}
private func steadyDisplayChanged(_ display:CGDirectDisplayID,_ flags:CGDisplayChangeSummaryFlags,_ context:UnsafeMutableRawPointer?){
 guard let context else{return};Unmanaged<NativeMetadataMonitor>.fromOpaque(context).takeUnretainedValue().displayChanged(begin:flags.contains(.beginConfigurationFlag))
}
@main struct SteadyNative {
 @MainActor static func main()async {
  let args=Set(CommandLine.arguments.dropFirst());let real=args.contains("--real-input")
  let writer=Writer();let fakeTest=args.contains("--test-fake-backend")
  guard !(fakeTest && real) else{writer.diagnostic("Fake test backend cannot be combined with real input.");exit(2)}
  let fakeBackend=fakeTest ? FakeBackend() : nil
  if let fakeBackend,args.contains("--test-system-displays") {
   // Packaged integration keeps desktop events fake while reading host geometry.
   // Pure fake process/unit tests omit this flag and retain synthetic displays.
   fakeBackend.displayInfos=SystemBackend(real:false).displays()
  }
  let backend:any InputBackend=fakeBackend ?? SystemBackend(real:real)
  let logFake:@Sendable ()->Void = {if let fakeBackend,let data=try? JSONEncoder().encode(fakeBackend.events),let line=String(data:data,encoding:.utf8){writer.diagnostic("fake-events: "+line)}}
  if args.contains("--release-and-exit"){backend.button(false,at:Point(x:0,y:0));logFake();writer.diagnostic(real ? "Emergency mouse-up attempted (real input)." : "Emergency release fake mode: no desktop event.");return}
  if real {
   let path=URL(fileURLWithPath:CommandLine.arguments[0]).standardizedFileURL.path
   guard path.contains("/Steady.app/Contents/") else{writer.diagnostic("Real input requires the packaged Steady.app executable identity.");exit(2)}
  }
  let engine=NativeEngine(backend:backend,boundedProbe:args.contains("--probe"))
  let metadata=fakeTest ? nil : NativeMetadataMonitor(engine:engine)
  if args.contains("--probe") {
   guard real || fakeTest else{writer.diagnostic("Supervised probe requires explicit --real-input; automated simulation requires --test-fake-backend.");exit(2)}
   writer.diagnostic("Open a disposable Krita document, keep Krita foreground, then send one line: CONFIRM_DISPOSABLE_KRITA. Probe is bounded to 15 seconds; mouse-up is always attempted.")
   await runProbe(engine:engine,writer:writer,logFake:logFake);withExtendedLifetime(metadata){};logFake();return
  }
  let canvasMonitor=CanvasAccessibility(engine:engine,fake:fakeTest){observation in writer.event{engine.event(type:"canvasObservation",payload:observation.json)}}
  let speech=SpeechProbe(output:{p in writer.event{engine.event(type:"speech",payload:p)}},fault:{message in writer.event{engine.event(type:"fault",payload:.object(["code":.string(message),"message":.string(message)]))}},diagnostics:{value in if let data=try? JSONEncoder().encode(value){writer.diagnostic("steady-speech-probe:"+String(decoding:data,as:UTF8.self))}})
  let parserQueue=DispatchQueue(label:"org.steady.native.protocol",qos:.userInitiated)
  let watchdogQueue=DispatchQueue(label:"org.steady.native.watchdog",qos:.userInteractive)
  let outputQueue=DispatchQueue(label:"org.steady.native.output",qos:.userInitiated)
  let timer=DispatchSource.makeTimerSource(queue:watchdogQueue);timer.schedule(deadline:.now(),repeating:.milliseconds(10),leeway:.milliseconds(1))
  timer.setEventHandler { @Sendable in
   // EOF cleanup and release cannot depend on the parser or a draining stdout pipe.
   var descriptor=pollfd(fd:STDIN_FILENO,events:Int16(POLLHUP),revents:0)
   if poll(&descriptor,1,0)>0 && descriptor.revents & Int16(POLLHUP) != 0 {engine.disconnect();logFake();exit(0)}
   let before=engine.snapshot;engine.watchdog(now:monotonicMilliseconds());let after=engine.snapshot
   if before.state != after.state || before.reason != after.reason {outputQueue.async{writer.event{engine.event(type:"state",payload:stateJSON(engine.snapshot))}}}
  };timer.resume()
  let framer=FramingBox()
  signal(SIGPIPE,SIG_IGN);signal(SIGTERM,SIG_IGN);signal(SIGINT,SIG_IGN)
  let term=DispatchSource.makeSignalSource(signal:SIGTERM,queue:watchdogQueue);term.setEventHandler{ @Sendable in engine.disconnect();logFake();exit(0)};term.resume()
  let interrupt=DispatchSource.makeSignalSource(signal:SIGINT,queue:watchdogQueue);interrupt.setEventHandler{ @Sendable in engine.disconnect();logFake();exit(0)};interrupt.resume()
  let source=DispatchSource.makeReadSource(fileDescriptor:STDIN_FILENO,queue:parserQueue)
  source.setEventHandler { @Sendable in
   var bytes=[UInt8](repeating:0,count:4096);let n=read(STDIN_FILENO,&bytes,bytes.count)
   guard n>0 else{engine.disconnect();logFake();Task{@MainActor in await speech.stop();exit(0)};source.cancel();return}
   do {for line in try framer.feed(Data(bytes.prefix(n))) {
    let request=try Wire.parse(line);let reply=writer.response{engine.handle(request,now:monotonicMilliseconds())}
    let accepted=reply.payload.object?["accepted"]?.bool==true
    if accepted,request.type=="microphone",let p=request.payload.object,let enabled=p["enabled"]?.bool,let session=p["speechSession"]?.string {Task{@MainActor in do{if try await speech.set(enabled:enabled,session:session){engine.report(enabled ? "microphone-enabled" : "microphone-disabled");writer.event{engine.event(type:"state",payload:stateJSON(engine.snapshot))}}}catch{speech.diagnosticError("microphone-setup-failed");writer.event{engine.event(type:"fault",payload:.object(["code":.string("microphone-failed"),"message":.string(String(describing:error))]))}}}}
    if accepted,request.type=="installSpeechAssets" {Task{@MainActor in do{try await speech.install();engine.report("speech-assets-ready");writer.event{engine.event(type:"state",payload:stateJSON(engine.snapshot))}}catch{writer.event{engine.event(type:"fault",payload:.object(["code":.string("speech-assets-failed"),"message":.string(String(describing:error))]))}}}}
    if accepted,request.type=="action",request.payload.object?["actionId"]?.string=="microphoneOff"{Task{@MainActor in await speech.stop()}}
    if accepted,request.type=="shutdown"{Task{@MainActor in await speech.stop();exit(0)}}
   }}catch {writer.response{engine.faultReply(session:"00000000-0000-4000-8000-000000000000",code:"protocol-invalid")};engine.disconnect();logFake();exit(3)}
  };source.resume()
  while !Task.isCancelled {try? await Task.sleep(for:.seconds(30));withExtendedLifetime((source,timer,term,interrupt,metadata,canvasMonitor)) {}}
 }
 private static func readConfirmation()->Bool{
  let deadline=monotonicMilliseconds()+15_000;var bytes:[UInt8]=[]
  while bytes.count<80 {
   let left=deadline-monotonicMilliseconds();guard left>0 else{return false}
   var descriptor=pollfd(fd:STDIN_FILENO,events:Int16(POLLIN),revents:0)
   guard poll(&descriptor,1,Int32(left))>0 else{return false}
   var byte:UInt8=0;guard read(STDIN_FILENO,&byte,1)==1 else{return false}
   if byte==10 {return String(bytes:bytes,encoding:.utf8)=="CONFIRM_DISPOSABLE_KRITA"};bytes.append(byte)
  };return false
 }
 private static func stateJSON(_ s:NativeState)->JSONValue{var p=JSONValue.encoded(s).object ?? [:];p["foregroundTarget"]=s.foregroundTarget.map(JSONValue.string) ?? .null;p["latestValidFrame"]=s.latestValidFrame.map{.number(Double($0))} ?? .null;return .object(p)}
 @MainActor private static func runProbe(engine:NativeEngine,writer:Writer,logFake:@escaping @Sendable ()->Void)async {
  let confirmed=await Task.detached{readConfirmation()}.value
  let values=CommandLine.arguments
  let selectedDisplay:UInt32?=values.firstIndex(of:"--probe-display").flatMap{index in values.count>index+1 ? UInt32(values[index+1]) : nil}
  guard confirmed,let fg=engine.backend.foreground(),fg.bundle=="org.krita",engine.backend.permissions().accessibility,let display=engine.backend.displays().first(where:{display in selectedDisplay.map{$0==display.id} ?? display.primary}) else{writer.diagnostic("Probe rejected: confirmation, foreground, permission, or display missing.");engine.emergencyRelease();return}
  let session=UUID().uuidString;var seq:UInt64=0
  func request(_ type:String,_ p:[String:JSONValue]){seq+=1;let e=Envelope(session:session,seq:seq,type:type,payload:.object(p));writer.response{engine.handle(e,now:monotonicMilliseconds())}}
  request("hello",["bundleId":.string("org.steady.local")])
  let pointer=engine.backend is FakeBackend ? CGPoint(x:-800,y:200) : CGEvent(source:nil)?.location
  guard let cursor=pointer else{writer.diagnostic("Cannot read pointer.");engine.emergencyRelease();return}
  var canvas=Rect(x:cursor.x-50,y:cursor.y-50,width:100,height:100)
  if let index=values.firstIndex(of:"--probe-rect") {
   guard values.count>index+4,let x=Double(values[index+1]),let y=Double(values[index+2]),let width=Double(values[index+3]),let height=Double(values[index+4]) else{writer.diagnostic("Invalid --probe-rect x y width height.");engine.emergencyRelease();return}
   canvas=Rect(x:x,y:y,width:width,height:height)
  }
  guard canvas.valid,canvas.width>=100,canvas.height>=100,display.bounds.contains(canvas) else{writer.diagnostic("Probe rectangle invalid or pointer too close to display edge.");engine.emergencyRelease();return}
  let start=Point(x:cursor.x,y:cursor.y)
  guard canvas.contains(start),canvas.contains(Point(x:start.x+12,y:start.y)) else{writer.diagnostic("Position the physical pointer inside the confirmed disposable canvas with 12 points of room to the right.");engine.emergencyRelease();return}
  request("configure",["generation":.number(1),"targetBundleId":.string("org.krita"),"targetPid":.number(Double(fg.pid)),"displayId":.number(Double(display.id)),"canvas":.encoded(canvas),"excludedRects":.array([])])
  // Small path around current pointer, clamped to display; deliberately bounded.
  var point=start
  let watchdog=DispatchSource.makeTimerSource(queue:DispatchQueue(label:"org.steady.native.probe-watchdog",qos:.userInteractive));watchdog.schedule(deadline:.now(),repeating:.milliseconds(10));watchdog.setEventHandler{ @Sendable in
   var descriptor=pollfd(fd:STDIN_FILENO,events:Int16(POLLHUP),revents:0)
   if poll(&descriptor,1,0)>0 && descriptor.revents & Int16(POLLHUP) != 0 {engine.disconnect();logFake();exit(0)}
   engine.watchdog(now:monotonicMilliseconds())
  };watchdog.resume();defer{watchdog.cancel();engine.emergencyRelease()}
  for frame in 1...24 {
   let now=monotonicMilliseconds();request("sample",["generation":.number(1),"frameId":.number(Double(frame)),"captureTimestamp":.number(now),"valid":.bool(true),"position":.encoded(point)])
   if frame==18 {request("action",["generation":.number(1),"eventId":.string("probe-resume"),"actionId":.string("resume")])}
   if frame==19 {request("action",["generation":.number(1),"eventId":.string("probe-down"),"actionId":.string("penDown")])}
   if frame>19 {point.x+=2}
   engine.watchdog(now:monotonicMilliseconds());try? await Task.sleep(for:.milliseconds(35))
  }
  // Deliberate starvation, with watchdog ticking independently of fresh samples.
  for _ in 0..<30 {engine.watchdog(now:monotonicMilliseconds());try? await Task.sleep(for:.milliseconds(10))}
  engine.emergencyRelease();writer.diagnostic("Supervised bounded probe finished; mouse-up attempted. Inspect document and retain operator evidence separately.")
 }
}
