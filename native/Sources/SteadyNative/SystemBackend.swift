import Foundation
@preconcurrency import AppKit
@preconcurrency import AVFoundation
import ApplicationServices
import SteadyCore

final class SystemBackend: InputBackend, @unchecked Sendable {
 let isReal:Bool
 private let targetLock=NSLock();private var targetPid:Int32=0
 func setTarget(pid:Int32){targetLock.withLock{targetPid=pid}}
 private func mayPost()->Bool{guard AXIsProcessTrusted(),let fg=foreground() else{return false};return fg.bundle=="org.krita" && fg.pid==targetLock.withLock{targetPid}}
 init(real:Bool){isReal=real}
 func permissions()->Permissions {
  func status(_ s:AVAuthorizationStatus)->String{switch s{case .authorized:return "authorized";case .denied:return "denied";case .restricted:return "restricted";case .notDetermined:return "notDetermined";@unknown default:return "unknown"}}
  return Permissions(accessibility:AXIsProcessTrusted(),camera:status(AVCaptureDevice.authorizationStatus(for:.video)),microphone:status(AVCaptureDevice.authorizationStatus(for:.audio)),speech:"unused")
 }
 @discardableResult func restoreTarget(pid:Int32)->Bool {guard let app=NSRunningApplication(processIdentifier:pid),app.bundleIdentifier=="org.krita",!app.isTerminated else{return false};return app.activate(options:[])}
 func kritaPid()->Int32? {NSRunningApplication.runningApplications(withBundleIdentifier:"org.krita").first?.processIdentifier}
 func foreground()->(bundle:String,pid:Int32)? {guard let app=NSWorkspace.shared.frontmostApplication,let bundle=app.bundleIdentifier else{return nil};return(bundle,app.processIdentifier)}
 func displays()->[DisplayInfo] {displayInfos(includeSleeping:false)}
 /// Fake desktop tests can use online geometry while the physical display sleeps.
 /// Real input always uses the active-display list through displays().
 func testDisplays()->[DisplayInfo] {displayInfos(includeSleeping:true)}
 private func displayInfos(includeSleeping:Bool)->[DisplayInfo] {
  var count:UInt32=0
  let counted=includeSleeping ? CGGetOnlineDisplayList(0,nil,&count) : CGGetActiveDisplayList(0,nil,&count)
  guard counted == .success else{return []}
  var ids=[CGDirectDisplayID](repeating:0,count:Int(count))
  let listed=includeSleeping ? CGGetOnlineDisplayList(count,&ids,&count) : CGGetActiveDisplayList(count,&ids,&count)
  guard listed == .success else{return []}
  let primary=CGMainDisplayID();let mainHeight=CGDisplayBounds(primary).height
  return ids.prefix(Int(count)).map{id in
   let bounds=CGDisplayBounds(id)
   let ns=NSScreen.screens.first{($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value==id}
   let visible=ns?.visibleFrame
   let work=visible.map{Rect(x:$0.minX,y:mainHeight-$0.maxY,width:$0.width,height:$0.height)} ?? Rect(x:bounds.minX,y:bounds.minY,width:bounds.width,height:bounds.height)
   return DisplayInfo(id:id,bounds:Rect(x:bounds.minX,y:bounds.minY,width:bounds.width,height:bounds.height),workArea:work,builtIn:CGDisplayIsBuiltin(id) != 0,primary:id==primary,scaleFactor:Double(ns?.backingScaleFactor ?? 1))
  }
 }
 @discardableResult func move(_ p:Point,dragging:Bool)->Bool{guard isReal else{return true};guard mayPost(),let event=CGEvent(mouseEventSource:nil,mouseType:dragging ? .leftMouseDragged : .mouseMoved,mouseCursorPosition:CGPoint(x:p.x,y:p.y),mouseButton:.left) else{return false};event.post(tap:.cghidEventTap);return true}
 @discardableResult func button(_ down:Bool,at p:Point)->Bool{guard isReal else{return true};guard !down || mayPost() else{return false};let point=down ? CGPoint(x:p.x,y:p.y) : (CGEvent(source:nil)?.location ?? CGPoint(x:p.x,y:p.y));guard let event=CGEvent(mouseEventSource:nil,mouseType:down ? .leftMouseDown : .leftMouseUp,mouseCursorPosition:point,mouseButton:.left) else{return false};event.post(tap:.cghidEventTap);return true}
 @discardableResult func shortcut(_ action:ActionID)->Bool{guard isReal else{return true};let key:CGKeyCode;let flags:CGEventFlags
  switch action {case .undo:key=6;flags = .maskCommand;case .redo:key=6;flags=[.maskCommand,.maskShift];case .brush:key=11;flags=[];case .toggleErase:key=14;flags=[];case .bigger:key=30;flags=[];case .smaller:key=33;flags=[];case .swapColors:key=7;flags=[];default:return false}
  // Guard immediately before each down event as well as the engine's prior check.
  guard mayPost() else{return false}
  for down in [true,false]{let e=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:down);e?.flags=flags;e?.post(tap:.cghidEventTap)}
  return true
 }
}
