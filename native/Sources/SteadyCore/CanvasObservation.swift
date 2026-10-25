import Foundation

/// Accessibility geometry is a viewport unless Krita supplies a separate document region.
/// These value types keep candidate selection testable without accessing the desktop.
public struct CanvasElement: Sendable {
 public var role:String;public var identifier:String;public var description:String;public var title:String;public var bounds:Rect
 public init(role:String,identifier:String,description:String,title:String="",bounds:Rect){self.role=role;self.identifier=identifier;self.description=description;self.title=title;self.bounds=bounds}
 public var isExplicitCanvas:Bool {
  let ids:Set<String>=["kisopenglcanvas2","kisqpaintercanvas","kritacanvas","canvaswidget","krita_canvas","canvas"]
  let labels:Set<String>=["canvas","drawing canvas","canvas viewport","drawing viewport"]
  let containerRoles:Set<String>=["AXGroup","AXScrollArea","AXImage","AXUnknown","AXLayoutArea"]
  return role == "AXCanvas" || (containerRoles.contains(role) && (ids.contains(identifier.lowercased()) || [description,title].contains{labels.contains($0.lowercased().trimmingCharacters(in:.whitespacesAndNewlines))}))
 }
 /// A viewport cannot be nested inside these interactive controls. Pruning them
 /// avoids enumerating thousands of layer/resource rows or toolbar descendants.
 public static func searchesChildren(role:String,identifier:String)->Bool {
  let leaves:Set<String>=["AXToolbar","AXMenuBar","AXMenu","AXList","AXTable","AXOutline","AXGrid","AXButton","AXCheckBox","AXRadioButton","AXSlider","AXTextField","AXTextArea","AXStaticText","AXScrollBar","AXComboBox","AXPopUpButton","AXMenuButton","AXColorWell"]
  return !leaves.contains(role)
 }
}
public enum CanvasCandidateResult: Equatable, Sendable {case available(Rect),missing,ambiguous,incomplete}
public enum CanvasGeometry {
 public static func documentTitle(_ title:String)->String {
  // KisView::slotUpdateDocumentTitle appends a periodically refreshed memory
  // size and Qt's [*] modification placeholder to the document caption. Neither
  // identifies a different document. Keep the caption itself (including internal
  // punctuation, parentheses and literal percent signs) intact.
  var caption=title.split(whereSeparator:{$0.isWhitespace}).joined(separator:" ")
  // QMdiSubWindow may wrap its child title as "Krita - [<child title>]".
  caption=caption.replacingOccurrences(of:#"^Krita\s+[-–—]\s+\[(.*)\]$"#,with:"$1",options:.regularExpression)
  caption=caption.replacingOccurrences(of:#"\s+[-–—]\s+Krita$"#,with:"",options:.regularExpression)
  caption=caption.replacingOccurrences(of:#"\s*(?:\[\*\]|[*•])\s*$"#,with:"",options:.regularExpression)
  // Match only a trailing byte-size statistic, never arbitrary parentheses or
  // a number in a filename. KFormat uses locale-specific grouping/decimal marks.
  caption=caption.replacingOccurrences(of:#"\s+\(\s*\p{Nd}[\p{Nd}.,'’\s]*\s+(?:[KMGTPEZY]i?B|B|bytes?)\s*\)\s*$"#,with:"",options:[.regularExpression,.caseInsensitive])
  return caption.trimmingCharacters(in:.whitespacesAndNewlines)
 }
 public static func windowSignature(id:String,bounds:Rect,title:String?)->String {
  "\(id)|\(bounds.x),\(bounds.y),\(bounds.width),\(bounds.height)|\(documentTitle(title ?? ""))"
 }
 public static func documentSignature(title:String)->String? {
  let caption=documentTitle(title)
  return caption.isEmpty ? nil : caption
 }
 public static func stableWindowID(previousID:String?,sameRoot:Bool,matchedID:String?,fallbackID:String)->String {
  (sameRoot ? previousID : nil) ?? matchedID ?? fallbackID
 }
 /// A structural workspace suggestion is deliberately not a recognized viewport.
 /// It may include tabs, rulers or scrollbars and must be reviewed by the user.
 public static func suggestedWorkspace(nodes:[CanvasDiagnosticNode],window:Rect,complete:Bool)->Rect? {
  guard complete,window.valid,
   nodes.contains(where:{$0.path=="0" && $0.role=="AXWindow" && $0.bounds.map{sameWorkspaceBounds($0,window)}==true}) else{return nil}
  let center=Point(x:window.x+window.width/2,y:window.y+window.height/2)
  var suggestions:[Rect]=[]
  for outer in nodes {
   let parts=outer.path.split(separator:"/")
   guard parts.count==2,parts.first=="0",outer.role=="AXGroup",outer.childCount==1,
    let bounds=outer.bounds,bounds.valid,bounds.width>=100,bounds.height>=100,
    bounds.width>window.width*0.4,bounds.height>window.height*0.5,
    window.contains(bounds),bounds.contains(center),!sameWorkspaceBounds(bounds,window) else{continue}
   let children=nodes.filter{node in
    let childParts=node.path.split(separator:"/")
    return childParts.count==parts.count+1 && Array(childParts.dropLast())==Array(parts)
   }
   guard children.count==1,let inner=children.first,inner.role=="AXGroup",inner.childCount>=1,
    let childBounds=inner.bounds,childBounds.valid,childBounds.width>=100,childBounds.height>=100,
    window.contains(childBounds),sameWorkspaceBounds(bounds,childBounds) else{continue}
   if !suggestions.contains(where:{sameWorkspaceBounds($0,bounds)}){suggestions.append(bounds)}
  }
  guard suggestions.count==1,let suggestion=suggestions.first else{return nil}
  return excludingSuggestedStatusBar(from:suggestion,nodes:nodes,window:window)
 }
 /// Qt Cocoa maps StatusBar to AXStaticText, so role alone is insufficient.
 /// A unique, root-level, full-width thin strip at the window's bottom is
 /// supporting evidence only for the explicitly reviewed workspace suggestion.
 private static func excludingSuggestedStatusBar(from suggestion:Rect,nodes:[CanvasDiagnosticNode],window:Rect)->Rect {
  var strips:[Rect]=[]
  for node in nodes {
   let path=node.path.split(separator:"/")
   guard path.count==2,path.first=="0",
    node.role=="AXStatusBar" || (node.role=="AXStaticText" && node.childCount>0),
    let bounds=node.bounds,bounds.valid,
    bounds.height<=window.height*0.2,bounds.y>=window.y,
    abs(bounds.x-window.x)<=1,abs(bounds.x+bounds.width-window.x-window.width)<=1,
    abs(bounds.y+bounds.height-window.y-window.height)<=1 else{continue}
   if !strips.contains(bounds){strips.append(bounds)}
  }
  guard strips.count==1,let bar=strips.first,suggestion.intersects(bar) else{return suggestion}
  let cropped=Rect(x:suggestion.x,y:suggestion.y,width:suggestion.width,height:bar.y-suggestion.y)
  guard cropped.valid,cropped.width>=100,cropped.height>=100,window.contains(cropped) else{return suggestion}
  return cropped
 }
 private static func sameWorkspaceBounds(_ a:Rect,_ b:Rect)->Bool {
  abs(a.x-b.x)<=1 && abs(a.y-b.y)<=1 && abs(a.width-b.width)<=1 && abs(a.height-b.height)<=1
 }
 public static func candidate(elements:[CanvasElement],window:Rect,complete:Bool)->CanvasCandidateResult {
  guard complete else{return .incomplete}
  var candidates:[Rect]=[]
  for element in elements where element.isExplicitCanvas && element.bounds.valid {
   let r=element.bounds
   let clipped=Rect(x:max(r.x,window.x),y:max(r.y,window.y),width:min(r.x+r.width,window.x+window.width)-max(r.x,window.x),height:min(r.y+r.height,window.y+window.height)-max(r.y,window.y))
   guard clipped.valid,clipped.width>=100,clipped.height>=100 else{continue}
   if !candidates.contains(clipped){candidates.append(clipped)}
  }
  guard candidates.count<2 else{return .ambiguous}
  return candidates.first.map(CanvasCandidateResult.available) ?? .missing
 }
}

/// Structural diagnostics deliberately exclude accessible titles, descriptions,
/// values and arbitrary identifiers. The payload is bounded before it crosses stdio.
public struct CanvasDiagnosticNode:Sendable {
 public var path:String;public var role:String;public var subrole:String;public var identifier:String?;public var bounds:Rect?;public var childCount:Int
 fileprivate var wasTruncated:Bool
 public init(path:String,role:String,subrole:String,identifier:String?,bounds:Rect?,childCount:Int){
  let validPath=path.range(of:"^[0-9]+(?:/[0-9]+)*$",options:.regularExpression) != nil
  self.path=validPath ? String(path.prefix(80)).trimmingCharacters(in:CharacterSet(charactersIn:"/")) : "0"
  func technicalRole(_ value:String,otherwise fallback:String)->String {
   value.range(of:"^AX[A-Za-z0-9]{0,62}$",options:.regularExpression) != nil ? String(value.prefix(64)) : fallback
  }
  self.role=technicalRole(role,otherwise:"AXUnknown");self.subrole=subrole.isEmpty ? "" : technicalRole(subrole,otherwise:"")
  self.identifier=identifier.flatMap(Self.safeIdentifier)
  self.bounds=bounds?.valid == true ? bounds : nil;self.childCount=max(0,min(4096,childCount))
  wasTruncated = !validPath || path.count>80 || role.count>64 || subrole.count>64 || childCount<0 || childCount>4096
 }
 public static func safeIdentifier(_ value:String)->String? {
  // These are technical Qt/Krita widget names, not general user-provided labels.
  let pattern="^(?:qt_[A-Za-z0-9_]{1,60}|Kis[A-Za-z0-9_]{1,60}|view_[0-9]{1,12}|canvas(?:Widget|Frame|Controller|View)?|centralWidget|scrollArea|viewport)$"
  guard value.count<=80,value.range(of:pattern,options:[.regularExpression,.caseInsensitive]) != nil else{return nil}
  return value
 }
 public var json:JSONValue{.object(["path":.string(path),"role":.string(role),"subrole":.string(subrole),"identifier":identifier.map(JSONValue.string) ?? .null,"bounds":bounds.map(JSONValue.encoded) ?? .null,"childCount":.number(Double(childCount))])}
}
public struct CanvasAccessibilityDiagnostics:Sendable {
 public var inspected:Int;public var complete:Bool;public var truncated:Bool;public var nodes:[CanvasDiagnosticNode];public var windowSource:String
 public init(inspected:Int,complete:Bool,truncated:Bool=false,nodes:[CanvasDiagnosticNode],windowSource:String){
  self.inspected=max(0,min(4096,inspected));self.complete=complete
  self.truncated=truncated || nodes.count>32 || nodes.contains(where:{$0.wasTruncated}) || inspected<0 || inspected>4096
  self.nodes=Array(nodes.prefix(32));self.windowSource=["ax","window-server","none"].contains(windowSource) ? windowSource : "none"
  // Leave several KiB for the observation envelope, identities and reason.
  while let data=try? JSONEncoder().encode(json),data.count>10*1024,!self.nodes.isEmpty {self.nodes.removeLast();self.truncated=true}
 }
 public var json:JSONValue{.object(["inspected":.number(Double(inspected)),"complete":.bool(complete),"truncated":.bool(truncated),"nodes":.array(nodes.map(\.json)),"windowSource":.string(windowSource)])}
}
public struct CanvasObservation: Sendable {
 public var generation:UInt64;public var targetPid:Int32?;public var windowId:String?;public var windowBounds:Rect?;public var windowToken:String?;public var layoutToken:String?;public var rect:Rect?;public var workspaceSuggestion:Rect?;public var kind:String?;public var availability:String;public var reason:String;public var observedAt:Double;public var diagnostics:CanvasAccessibilityDiagnostics?
 public init(generation:UInt64,targetPid:Int32?,windowId:String?=nil,windowBounds:Rect?=nil,windowToken:String?=nil,layoutToken:String?=nil,rect:Rect?=nil,workspaceSuggestion:Rect?=nil,kind:String?=nil,availability:String="unavailable",reason:String,observedAt:Double=monotonicMilliseconds(),diagnostics:CanvasAccessibilityDiagnostics?=nil){
  self.generation=generation;self.targetPid=targetPid;self.windowId=windowId;self.windowBounds=windowBounds;self.windowToken=windowToken;self.layoutToken=layoutToken;self.rect=rect;self.workspaceSuggestion=workspaceSuggestion;self.kind=kind;self.availability=availability;self.reason=reason;self.observedAt=observedAt;self.diagnostics=diagnostics
 }
 public var json:JSONValue{.object(["generation":.number(Double(generation)),"targetPid":targetPid.map{.number(Double($0))} ?? .null,"windowId":windowId.map(JSONValue.string) ?? .null,"windowBounds":windowBounds.map(JSONValue.encoded) ?? .null,"windowToken":windowToken.map(JSONValue.string) ?? .null,"layoutToken":layoutToken.map(JSONValue.string) ?? .null,"rect":rect.map(JSONValue.encoded) ?? .null,"workspaceSuggestion":workspaceSuggestion.map(JSONValue.encoded) ?? .null,"kind":kind.map(JSONValue.string) ?? .null,"availability":.string(availability),"reason":.string(reason),"observedAt":.number(observedAt),"diagnostics":diagnostics?.json ?? .null])}
}

/// One fully read node, supplied by the platform adapter or a deterministic test.
public struct CanvasTreeNode<Node:Hashable> {
 public var element:CanvasElement?;public var children:[Node];public var layout:String?;public var complete:Bool
 public init(element:CanvasElement?,children:[Node],layout:String?=nil,complete:Bool=true){self.element=element;self.children=children;self.layout=layout;self.complete=complete}
}

/// Search work survives the per-poll deadline. It only resets when the root/document
/// signature changes, never because a large tree did not fit in one timer tick.
public struct CanvasTreeSearch<Node:Hashable> {
 private struct Work {var node:Node;var path:[Node];var retries:Int;var diagnosticPath:String}
 private var pending:[Work]=[];private var cursor=0;private var visited=Set<Node>()
 public private(set) var signature:String?;public private(set) var inspected=0
 public private(set) var failed=false;public private(set) var elements:[CanvasElement]=[]
 public private(set) var paths:[Node:[Node]]=[:];public private(set) var layout:[String]=[]
 public private(set) var diagnosticPaths:[Node:String]=[:]
 private let maximumNodes:Int;private let maximumDepth:Int
 public init(maximumNodes:Int=4096,maximumDepth:Int=24){self.maximumNodes=maximumNodes;self.maximumDepth=maximumDepth}
 public var finished:Bool{cursor>=pending.count}
 public var complete:Bool{finished && !failed}
 public mutating func reset(signature:String,root:Node){
  self.signature=signature;pending=[Work(node:root,path:[],retries:0,diagnosticPath:"0")];cursor=0;visited=[];inspected=0;failed=false;elements=[];paths=[:];layout=[];diagnosticPaths=[:]
 }
 public mutating func advance(nodeBudget:Int,mayContinue:()->Bool,read:(Node)->CanvasTreeNode<Node>?) {
  var remaining=max(0,nodeBudget)
  while cursor<pending.count && remaining>0 && mayContinue() {
   let work=pending[cursor];cursor+=1
   if visited.contains(work.node){continue}
   guard inspected<maximumNodes else{failed=true;cursor=pending.count;break}
   remaining-=1
   guard let result=read(work.node) else {
    if work.retries<2 {pending.append(Work(node:work.node,path:work.path,retries:work.retries+1,diagnosticPath:work.diagnosticPath))}
    else {failed=true;visited.insert(work.node);inspected+=1}
    continue
   }
   visited.insert(work.node);inspected+=1
   diagnosticPaths[work.node]=work.diagnosticPath
   if !result.complete{failed=true}
   if let element=result.element{elements.append(element);if element.isExplicitCanvas{paths[work.node]=work.path+[work.node]}}
   if let token=result.layout{layout.append(token)}
   guard !result.children.isEmpty else{continue}
   guard work.path.count<maximumDepth,pending.count+result.children.count<=maximumNodes*2 else{failed=true;continue}
   pending.append(contentsOf:result.children.enumerated().map{index,node in Work(node:node,path:work.path+[work.node],retries:0,diagnosticPath:"\(work.diagnosticPath)/\(index)")})
  }
 }
}
