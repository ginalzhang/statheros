import Foundation
@preconcurrency import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import SteadyCore

/// AX and WindowServer metadata only. This code never captures pixels, requests
/// permissions, injects input, or runs under the native input/watchdog lock.
final class CanvasAccessibility:@unchecked Sendable {
 private let timer:DispatchSourceTimer
 init(engine:NativeEngine,fake:Bool,output:@escaping @Sendable (CanvasObservation)->Void){
  let inspector=CanvasInspector()
  let queue=DispatchQueue(label:"org.steady.native.canvas-accessibility",qos:.utility)
  timer=DispatchSource.makeTimerSource(queue:queue)
  timer.schedule(deadline:.now() + .milliseconds(250),repeating:.milliseconds(500),leeway:.milliseconds(50))
  timer.setEventHandler{[engine,inspector] in
   let generation=engine.snapshot.generation
   if fake {
    let bounds=Rect(x:-1920,y:-200,width:1920,height:1080)
    let diagnostics=CanvasAccessibilityDiagnostics(inspected:1,complete:true,nodes:[CanvasDiagnosticNode(path:"0",role:"AXWindow",subrole:"AXStandardWindow",identifier:nil,bounds:bounds,childCount:0)],windowSource:"none")
    output(CanvasObservation(generation:generation,targetPid:123,windowId:"fake-krita-window",windowBounds:bounds,windowToken:"fake-krita-document",layoutToken:"fake-krita-layout",reason:"Automatic detection is unavailable in the fake backend. Select with mouse.",diagnostics:diagnostics));return
   }
   let observation=inspector.inspect(generation:generation)
   guard engine.snapshot.generation==generation else{return}
   output(observation)
  }
  timer.resume()
 }
 deinit{timer.cancel()}
}

private struct AXNode:Hashable {
 let element:AXUIElement
 static func ==(a:Self,b:Self)->Bool{CFEqual(a.element,b.element)}
 func hash(into hasher:inout Hasher){hasher.combine(CFHash(element))}
}
private struct WindowRecord {let id:CGWindowID;let bounds:Rect}
private struct NodeAttributes {
 var values:[String:CFTypeRef]
 var role:String{values[kAXRoleAttribute] as? String ?? ""}
 var identifier:String{values[kAXIdentifierAttribute] as? String ?? ""}
 var description:String{values[kAXDescriptionAttribute] as? String ?? ""}
 var title:String?{values[kAXTitleAttribute] as? String}
 var hidden:Bool{values["AXHidden"] as? Bool == true}
 var bounds:Rect? {
  guard let p=values[kAXPositionAttribute],CFGetTypeID(p)==AXValueGetTypeID(),let s=values[kAXSizeAttribute],CFGetTypeID(s)==AXValueGetTypeID() else{return nil}
  var origin=CGPoint.zero,size=CGSize.zero
  guard AXValueGetValue(p as! AXValue,.cgPoint,&origin),AXValueGetValue(s as! AXValue,.cgSize,&size) else{return nil}
  let r=Rect(x:origin.x,y:origin.y,width:size.width,height:size.height);return r.valid ? r : nil
 }
 var canvasElement:CanvasElement? {bounds.map{CanvasElement(role:role,identifier:identifier,description:description,title:title ?? "",bounds:$0)}}
}

/// Queue confined. A complete scan may take several polls; one deadline never
/// discards prior progress. A confirmed candidate is thereafter checked directly.
private final class CanvasInspector:@unchecked Sendable {
 private var search=CanvasTreeSearch<AXNode>()
 private var cachedPath:[AXNode]?
 private var cachedChildKeys:[String]?
 private var completedAt:Double = -Double.infinity
 private var lastWindowId:String?
 private var lastTitle:String?
 private var previousRoot:AXNode?
 private var knownRootId:String?
 private var knownRootRecord:WindowRecord?
 private var knownPid:Int32?
 private var workspaceSuggestion:Rect?
 private var workspaceSignature:String?
 private var attributes:[AXNode:NodeAttributes]=[:]
 private var childCounts:[AXNode:Int]=[:]
 private var diagnosticRows:[AXNode:CanvasDiagnosticNode]=[:]
 private var deadline:Double=0
 private let names=[kAXRoleAttribute,kAXSubroleAttribute,kAXIdentifierAttribute,kAXDescriptionAttribute,kAXTitleAttribute,kAXPositionAttribute,kAXSizeAttribute,"AXHidden",kAXMinimizedAttribute,kAXModalAttribute]

 func inspect(generation:UInt64)->CanvasObservation {
  attributes=[:];childCounts=[:];deadline=monotonicMilliseconds()+200
  guard let app=NSRunningApplication.runningApplications(withBundleIdentifier:"org.krita").first else {
   reset();return CanvasObservation(generation:generation,targetPid:nil,reason:"Open a document in Krita, then select its canvas.")
  }
  let pid=app.processIdentifier
  let windows=windowRecords(pid:pid)
  // With no readable AX root, multiple windows cannot be associated with the
  // active document safely. Do not reuse a previously focused window here.
  let fallback=windows.count==1 ? windows.first : nil
  func metadataUnavailable(_ message:String)->CanvasObservation {
   let diagnostics=CanvasAccessibilityDiagnostics(inspected:0,complete:false,nodes:[],windowSource:fallback == nil ? "none" : "window-server")
   guard let fallback else{return CanvasObservation(generation:generation,targetPid:pid,reason:message,diagnostics:diagnostics)}
   let id=knownPid==pid && knownRootRecord?.id==fallback.id ? knownRootId ?? "cg:\(pid):\(fallback.id)" : "cg:\(pid):\(fallback.id)"
   return CanvasObservation(generation:generation,targetPid:pid,windowId:id,windowBounds:fallback.bounds,reason:message,diagnostics:diagnostics)
  }
  guard AXIsProcessTrusted() else {
   cachedPath=nil;cachedChildKeys=nil
   return metadataUnavailable("Accessibility permission is needed for automatic detection. Window geometry is still monitored where available; Select with mouse.")
  }
  let application=AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(application,0.025)
  guard let focused=copyElement(application,kAXFocusedWindowAttribute) ?? copyElement(application,kAXMainWindowAttribute) else {
   cachedPath=nil;cachedChildKeys=nil
   return metadataUnavailable("Krita did not expose a readable document window. Select with mouse.")
  }
  let root=AXNode(element:focused)
  guard let rootAttributes=read(root),let measuredBounds=rootAttributes.bounds else {
   cachedPath=nil;cachedChildKeys=nil
   return metadataUnavailable("Krita window Accessibility read timed out. Window geometry is still monitored where available; Select with mouse.")
  }
  // Match only equal bounds, never the largest or frontmost arbitrary window.
  let matching=windows.filter{sameWindowBounds($0.bounds,measuredBounds)}
  let record=matching.count==1 ? matching.first : nil
  let sameRoot=previousRoot==root && knownPid==pid
  let windowId=CanvasGeometry.stableWindowID(previousID:knownRootId,sameRoot:sameRoot,matchedID:record.map{"cg:\(pid):\($0.id)"},fallbackID:"ax:\(pid):\(CFHash(focused))")
  let bounds=record?.bounds ?? measuredBounds
  if let record {knownRootRecord=record} else if !sameRoot {knownRootRecord=nil}
  previousRoot=root;knownRootId=windowId;knownPid=pid
  if lastWindowId != windowId {lastWindowId=windowId;lastTitle=nil}
  let documentSignature=rootAttributes.title.flatMap{CanvasGeometry.documentSignature(title:$0)}
  if documentSignature != nil {lastTitle=rootAttributes.title}
  let windowToken=documentSignature.map(hash)
  // A temporarily missing title must not reset an in-progress search or invent
  // a new document identity. The wire token stays null when the title is unknown.
  let signature=hash(CanvasGeometry.windowSignature(id:windowId,bounds:bounds,title:lastTitle))
  if workspaceSignature != signature {workspaceSuggestion=nil;workspaceSignature=signature}
  func observation(_ message:String,layout:String?=nil,rect:Rect?=nil)->CanvasObservation {
   CanvasObservation(generation:generation,targetPid:pid,windowId:windowId,windowBounds:bounds,windowToken:windowToken,layoutToken:layout,rect:rect,workspaceSuggestion:rect == nil ? workspaceSuggestion : nil,kind:rect == nil ? nil : "viewport",availability:rect == nil ? "unavailable" : "available",reason:message,diagnostics:diagnostics())
  }
  if search.signature != signature {restart(signature:signature,root:root)}
  if rootAttributes.values[kAXMinimizedAttribute] as? Bool == true {
   cachedPath=nil;cachedChildKeys=nil;workspaceSuggestion=nil
   return observation("Restore the Krita window before selecting its canvas.")
  }
  let subrole=rootAttributes.values[kAXSubroleAttribute] as? String ?? ""
  if rootAttributes.values[kAXModalAttribute] as? Bool == true || ["AXDialog","AXSystemDialog"].contains(subrole) {
   cachedPath=nil;cachedChildKeys=nil;workspaceSuggestion=nil
   return observation("Close the Krita dialog before selecting its canvas.")
  }
  if let path=cachedPath {
   if let checked=validate(path:path,root:root,window:bounds),cachedChildKeys==checked.children {
    return observation("Krita drawing viewport detected. Includes workspace around the artwork.",layout:hash(signature+checked.layout),rect:checked.rect)
   }
   // A deadline is not evidence that the cached ancestor chain changed. Keep
   // it for a fresh verification budget, but never publish unverified bounds.
   if monotonicMilliseconds()>=deadline {
    return observation("Krita viewport search finished; verifying its current geometry on the next poll. Select with mouse is available.")
   }
   restart(signature:signature,root:root)
  }

  if search.finished && monotonicMilliseconds()-completedAt>=2000 {restart(signature:signature,root:root)}
  search.advance(nodeBudget:96,mayContinue:{monotonicMilliseconds()<self.deadline}){node in self.treeNode(node,window:bounds)}
  if !search.finished {
   return observation("Searching Krita Accessibility (\(search.inspected) elements inspected; continuing). You can Select with mouse while it searches.")
  }
  if completedAt == -Double.infinity {completedAt=monotonicMilliseconds()}
  guard search.complete else {
   workspaceSuggestion=nil
   return observation("Krita Accessibility search exhausted its node/depth budget or repeatedly timed out (\(search.inspected) elements). Window geometry is still monitored; Select with mouse.")
  }
  workspaceSuggestion=CanvasGeometry.suggestedWorkspace(nodes:diagnosticNodes(),window:bounds,complete:true)
  switch CanvasGeometry.candidate(elements:search.elements,window:bounds,complete:true) {
  case .available:
   // Candidate paths are retained so later polls avoid walking unrelated docks.
   for path in search.paths.values {
    if let checked=validate(path:path,root:root,window:bounds) {
     cachedPath=path;cachedChildKeys=checked.children
     return observation("Krita drawing viewport detected. Includes workspace around the artwork.",layout:hash(signature+checked.layout),rect:checked.rect)
    }
   }
   if monotonicMilliseconds()>=deadline {
    return observation("Krita viewport search finished; verifying its current geometry on the next poll. Select with mouse is available.")
   }
   restart(signature:signature,root:root)
   return observation("Krita changed while its viewport was being inspected. Searching again; Select with mouse is available.")
  case .ambiguous:
   workspaceSuggestion=nil
   return observation("Krita exposed multiple canvas regions. Select with mouse.",layout:hash(signature+search.layout.sorted().joined(separator:"\n")))
  case .incomplete:return observation("Krita Accessibility search is still in progress. Select with mouse is available.")
  case .missing:return observation("Krita exposed no identifiable canvas or drawing viewport after inspecting \(search.inspected) elements. Select with mouse.",layout:hash(signature+search.layout.sorted().joined(separator:"\n")))
  }
 }

 private func restart(signature:String,root:AXNode){search.reset(signature:signature,root:root);cachedPath=nil;cachedChildKeys=nil;diagnosticRows=[:];completedAt = -Double.infinity}
 private func reset(){search=CanvasTreeSearch<AXNode>();cachedPath=nil;cachedChildKeys=nil;lastWindowId=nil;lastTitle=nil;previousRoot=nil;knownRootId=nil;knownRootRecord=nil;knownPid=nil;diagnosticRows=[:];workspaceSuggestion=nil;workspaceSignature=nil;completedAt = -Double.infinity}
 private func diagnosticNodes()->[CanvasDiagnosticNode] {
  search.diagnosticPaths.compactMap{node,path -> CanvasDiagnosticNode? in
   guard let row=diagnosticRows[node] else{return nil}
   return CanvasDiagnosticNode(path:path,role:row.role,subrole:row.subrole,identifier:row.identifier,bounds:row.bounds,childCount:row.childCount)
  }
 }
 private func diagnostics()->CanvasAccessibilityDiagnostics {
  let structural:Set<String>=["AXWindow","AXGroup","AXScrollArea","AXTabGroup","AXSplitGroup","AXSplitter","AXUnknown","AXLayoutArea","AXImage","AXRadioButton","AXCanvas","AXScrollBar","AXRuler"]
  let nodes=diagnosticNodes().sorted{a,b in
   func priority(_ row:CanvasDiagnosticNode)->Int {
    if row.role=="AXWindow" {return 0}
    if structural.contains(row.role),let bounds=row.bounds,bounds.width>=100,bounds.height>=100{return 1}
    return structural.contains(row.role) ? 2 : 3
   }
   let ap=priority(a),bp=priority(b)
   if ap != bp{return ap<bp}
   let ac=a.path.split(separator:"/").compactMap{Int($0)},bc=b.path.split(separator:"/").compactMap{Int($0)}
   if ac.count != bc.count{return ac.count<bc.count}
   return ac.lexicographicallyPrecedes(bc)
  }
  return CanvasAccessibilityDiagnostics(inspected:search.inspected,complete:search.complete,truncated:nodes.count<search.inspected,nodes:nodes,windowSource:"ax")
 }
 private func hash(_ string:String)->String{SHA256.hash(data:Data(string.utf8)).map{String(format:"%02x",$0)}.joined()}
 private func copyElement(_ application:AXUIElement,_ attribute:String)->AXUIElement? {
  guard monotonicMilliseconds()<deadline else{return nil}
  var value:CFTypeRef?
  guard AXUIElementCopyAttributeValue(application,attribute as CFString,&value) == .success,let value,CFGetTypeID(value)==AXUIElementGetTypeID() else{return nil}
  return (value as! AXUIElement)
 }
 private func read(_ node:AXNode)->NodeAttributes? {
  if let known=attributes[node]{return known}
  guard monotonicMilliseconds()<deadline else{return nil}
  AXUIElementSetMessagingTimeout(node.element,0.025)
  var raw:CFArray?
  guard AXUIElementCopyMultipleAttributeValues(node.element,names as CFArray,AXCopyMultipleAttributeOptions(rawValue:0),&raw) == .success,let values=raw as? [CFTypeRef],values.count==names.count else{return nil}
  var result:[String:CFTypeRef]=[:]
  for (index,value) in values.enumerated() {
   if CFGetTypeID(value)==CFNullGetTypeID(){continue}
   if CFGetTypeID(value)==AXValueGetTypeID(),AXValueGetType(value as! AXValue) == .axError {
    var error=AXError.success
    if AXValueGetValue(value as! AXValue,.axError,&error),error == .cannotComplete {return nil}
    continue
   }
   result[names[index]]=value
  }
  guard result[kAXRoleAttribute] is String else{return nil}
  let parsed=NodeAttributes(values:result);attributes[node]=parsed;return parsed
 }
 private func childCount(_ node:AXNode)->Int? {
  if let known=childCounts[node]{return known}
  guard monotonicMilliseconds()<deadline else{return nil}
  var count:CFIndex=0
  let status=AXUIElementGetAttributeValueCount(node.element,kAXChildrenAttribute as CFString,&count)
  if [.attributeUnsupported,.noValue].contains(status){childCounts[node]=0;return 0}
  guard status == .success,count>=0,count<=4096 else{return nil}
  childCounts[node]=count;return count
 }
 private func children(_ node:AXNode)->[AXNode]? {
  guard let count=childCount(node) else{return nil}
  if count==0{return []}
  guard monotonicMilliseconds()<deadline else{return nil}
  var raw:CFArray?
  guard AXUIElementCopyAttributeValues(node.element,kAXChildrenAttribute as CFString,0,count,&raw) == .success,let values=raw as? [AXUIElement],values.count==count else{return nil}
  return values.map{AXNode(element:$0)}
 }
 private func treeNode(_ node:AXNode,window:Rect)->CanvasTreeNode<AXNode>? {
  guard let metadata=read(node) else{return nil}
  if metadata.hidden{return CanvasTreeNode(element:nil,children:[])}
  if let rect=metadata.bounds,!rect.intersects(window){return CanvasTreeNode(element:nil,children:[])}
  let candidate=metadata.canvasElement
  let recurse=CanvasElement.searchesChildren(role:metadata.role,identifier:metadata.identifier) && candidate?.isExplicitCanvas != true
  guard let descendants=recurse ? children(node) : [] else{return nil}
  if let count=recurse ? descendants.count : childCount(node) {
   diagnosticRows[node]=CanvasDiagnosticNode(path:"0",role:metadata.role,subrole:metadata.values[kAXSubroleAttribute] as? String ?? "",identifier:metadata.identifier,bounds:metadata.bounds,childCount:count)
  }
  let layoutRoles:Set<String>=["AXWindow","AXGroup","AXScrollArea","AXTabGroup","AXSplitGroup","AXSplitter"]
  let layout=layoutRoles.contains(metadata.role) || candidate?.isExplicitCanvas == true ? layoutEntry(metadata) : nil
  return CanvasTreeNode(element:candidate,children:descendants,layout:layout)
 }
 private func layoutEntry(_ metadata:NodeAttributes)->String {
  let r=metadata.bounds
  return "\(metadata.role)|\(metadata.identifier)|\(r?.x ?? 0),\(r?.y ?? 0),\(r?.width ?? 0),\(r?.height ?? 0)"
 }
 private func validate(path:[AXNode],root:AXNode,window:Rect)->(rect:Rect,layout:String,children:[String])? {
  guard path.first==root,let candidate=path.last else{return nil}
  var entries:[String]=[],childKeys:[String]=[]
  for (index,node) in path.enumerated() {
   guard let metadata=read(node),!metadata.hidden else{return nil}
   if let rect=metadata.bounds,!rect.intersects(window){return nil}
   entries.append(layoutEntry(metadata))
   if index+1<path.count {
    guard let nodes=children(node),nodes.contains(path[index+1]) else{return nil}
    childKeys.append(nodes.map{String(CFHash($0.element))}.sorted().joined(separator:","))
   }
  }
  guard let element=read(candidate)?.canvasElement,case .available(let rect)=CanvasGeometry.candidate(elements:[element],window:window,complete:true) else{return nil}
  return(rect,entries.joined(separator:"\n"),childKeys)
 }
 private func sameWindowBounds(_ a:Rect,_ b:Rect)->Bool{abs(a.x-b.x)<2 && abs(a.y-b.y)<2 && abs(a.width-b.width)<2 && abs(a.height-b.height)<2}
 private func windowRecords(pid:Int32)->[WindowRecord] {
  guard let raw=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] else{return []}
  return raw.compactMap{item in
   guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value==pid,(item[kCGWindowLayer as String] as? NSNumber)?.intValue==0,
    (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,let id=(item[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
    let dictionary=item[kCGWindowBounds as String] as? [String:Any],let rect=CGRect(dictionaryRepresentation:dictionary as CFDictionary) else{return nil}
   let bounds=Rect(x:rect.origin.x,y:rect.origin.y,width:rect.size.width,height:rect.size.height)
   guard bounds.valid,bounds.width>=100,bounds.height>=100 else{return nil}
   return WindowRecord(id:id,bounds:bounds)
  }
 }
}
