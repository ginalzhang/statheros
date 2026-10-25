import Foundation
import Testing
@testable import SteadyCore

private let window=Rect(x:-1200,y:-100,width:1100,height:850)
private let viewport=Rect(x:-1100,y:0,width:700,height:600)
private func canvas(_ rect:Rect=viewport)->CanvasElement{CanvasElement(role:"AXGroup",identifier:"KisOpenGLCanvas2",description:"",bounds:rect)}
@Test func modifiedDocumentMarkersDoNotChangeLayoutIdentity(){
 #expect(CanvasGeometry.documentTitle("Sketch.kra * — Krita") == CanvasGeometry.documentTitle("Sketch.kra — Krita"))
 #expect(CanvasGeometry.documentTitle("Sketch.kra • — Krita") == CanvasGeometry.documentTitle("Sketch.kra — Krita"))
 #expect(CanvasGeometry.documentTitle("Other.kra — Krita") != CanvasGeometry.documentTitle("Sketch.kra — Krita"))
}
@Test func periodicKritaMemoryTitleUpdatesDoNotChangeDocumentIdentity(){
 let expected=CanvasGeometry.documentSignature(title:"Sketch.kra")
 for title in ["Sketch.kra (12.3 MiB) [*]", "Sketch.kra (19.8 MiB) *", "Sketch.kra (20.0 MiB) • — Krita", "Sketch.kra (21,5 MiB) — Krita", "Sketch.kra (1\u{202f}234,5 MiB) — Krita", "Krita - [Sketch.kra (22.1 MiB) [*]]", "Krita - [Sketch.kra (22.2 MiB) *]", "Sketch.kra (1024 B)", "Sketch.kra (1.0 GiB)"] {
  #expect(CanvasGeometry.documentSignature(title:title)==expected)
 }
 #expect(CanvasGeometry.documentSignature(title:"Other.kra (12.3 MiB) [*]") != expected)
 #expect(CanvasGeometry.documentSignature(title:"Sketch.kra (12.3 MiB) [*]") == CanvasGeometry.documentSignature(title:"Sketch.kra (99.1 MiB)"))
}
@Test func titleNormalizationPreservesDocumentNamePunctuationAndUnsupportedDecorations(){
 for title in ["Stars*.kra", "Stars•.kra", "Sketch (final).kra", "Sketch (50%).kra", "Sketch (12.3 MiB).kra", "Sketch (15 layers).kra", "Sketch (private-data)"] {
  #expect(CanvasGeometry.documentTitle(title)==title)
 }
 #expect(CanvasGeometry.documentSignature(title:"Sketch (12.3 MiB).kra (24 MiB) [*]") != CanvasGeometry.documentSignature(title:"Sketch (20.1 MiB).kra (24 MiB) [*]"))
 #expect(CanvasGeometry.documentSignature(title:"Sketch.kra (unknown-format)") != CanvasGeometry.documentSignature(title:"Sketch.kra"))
 for title in ["", "  \n\t ", "[*]", "•", "* — Krita"] {
  #expect(CanvasGeometry.documentSignature(title:title)==nil)
 }
}
@Test func memoryRefreshDoesNotRestartWindowSearchButResizeAndDocumentSwitchDo(){
 let baseline=CanvasGeometry.windowSignature(id:"cg:123:7",bounds:window,title:"Krita - [Sketch.kra (12.3 MiB) [*]]")
 #expect(baseline==CanvasGeometry.windowSignature(id:"cg:123:7",bounds:window,title:"Krita - [Sketch.kra (29.8 MiB)]"))
 #expect(baseline != CanvasGeometry.windowSignature(id:"cg:123:7",bounds:Rect(x:window.x,y:window.y,width:window.width-100,height:window.height),title:"Krita - [Sketch.kra (29.8 MiB)]"))
 #expect(baseline != CanvasGeometry.windowSignature(id:"cg:123:7",bounds:window,title:"Krita - [Other.kra (29.8 MiB)]"))
}
@Test func explicitCanvasViewportRequiresCompleteUnambiguousGeometry(){
 #expect(CanvasGeometry.candidate(elements:[canvas()],window:window,complete:true) == .available(viewport))
 #expect(CanvasGeometry.candidate(elements:[canvas()],window:window,complete:false) == .incomplete)
 #expect(CanvasGeometry.candidate(elements:[canvas(),canvas(Rect(x:-1000,y:10,width:500,height:400))],window:window,complete:true) == .ambiguous)
 #expect(CanvasGeometry.candidate(elements:[canvas(),canvas()],window:window,complete:true) == .available(viewport))
}
@Test func arbitraryWindowGroupOrGenericScrollViewportNeverSubstitutesForCanvas(){
 let elements=[CanvasElement(role:"AXWindow",identifier:"",description:"",bounds:window),CanvasElement(role:"AXGroup",identifier:"",description:"",bounds:viewport),CanvasElement(role:"AXScrollArea",identifier:"qt_scrollarea_viewport",description:"",bounds:viewport),CanvasElement(role:"AXButton",identifier:"",description:"Canvas",bounds:viewport)]
 #expect(CanvasGeometry.candidate(elements:elements,window:window,complete:true) == .missing)
 #expect(CanvasGeometry.candidate(elements:[CanvasElement(role:"AXCanvas",identifier:"",description:"",bounds:viewport)],window:window,complete:true) == .available(viewport))
}
@Test func canvasBoundsAreClippedToVisibleWindowAndInvalidOrTinyBoundsRejected(){
 let partlyVisible=Rect(x:-1300,y:-200,width:500,height:500)
 #expect(CanvasGeometry.candidate(elements:[canvas(partlyVisible)],window:window,complete:true) == .available(Rect(x:-1200,y:-100,width:400,height:400)))
 for r in [Rect(x:0,y:0,width:500,height:500),Rect(x:-1100,y:0,width:99,height:500),Rect(x:Double.nan,y:0,width:500,height:500)] {
  #expect(CanvasGeometry.candidate(elements:[canvas(r)],window:window,complete:true) == .missing)
 }
}
@Test func unavailableObservationEncodesExplicitNullsAndFreshness(){
 let observation=CanvasObservation(generation:3,targetPid:nil,reason:"Unavailable",observedAt:1234).json.object
 #expect(observation?["targetPid"] == .null);#expect(observation?["windowId"] == .null);#expect(observation?["layoutToken"] == .null);#expect(observation?["rect"] == .null);#expect(observation?["kind"] == .null)
 #expect(observation?["windowBounds"] == .null);#expect(observation?["windowToken"] == .null)
 #expect(observation?["diagnostics"] == .null)
 #expect(observation?["workspaceSuggestion"] == .null)
 #expect(observation?["generation"]?.uint==3);#expect(observation?["observedAt"]?.number==1234)
}

private func workspaceRows(window:Rect,pane:Rect,path:String="0/7")->[CanvasDiagnosticNode] {
 [CanvasDiagnosticNode(path:"0",role:"AXWindow",subrole:"AXStandardWindow",identifier:nil,bounds:window,childCount:10),
  CanvasDiagnosticNode(path:path,role:"AXGroup",subrole:"",identifier:nil,bounds:pane,childCount:1),
  CanvasDiagnosticNode(path:path+"/0",role:"AXGroup",subrole:"",identifier:nil,bounds:pane,childCount:2)]
}

@Test func anonymousWorkspaceShapeOnlyProducesAnUntrustedSuggestion(){
 let root=Rect(x:0,y:30,width:1200,height:900),pane=Rect(x:60,y:70,width:900,height:800)
 let rows=workspaceRows(window:root,pane:pane)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows,window:root,complete:true)==pane)
 #expect(CanvasGeometry.candidate(elements:[CanvasElement(role:"AXGroup",identifier:"",description:"",bounds:pane)],window:root,complete:true) == .missing)
 let observation=CanvasObservation(generation:1,targetPid:123,windowId:"window",windowBounds:root,workspaceSuggestion:pane,reason:"Workspace requires review").json.object
 #expect(observation?["availability"]?.string=="unavailable")
 #expect(observation?["rect"] == .null);#expect(observation?["kind"] == .null)
 #expect((try? observation?["workspaceSuggestion"]?.decode(Rect.self))==pane)
}

@Test func workspaceSuggestionUsesStructureAfterDisplayTranslationAndWindowResize(){
 let root=Rect(x:-1600,y:-300,width:1400,height:1000),pane=Rect(x:-1500,y:-240,width:1000,height:850)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:root,pane:pane,path:"0/19"),window:root,complete:true)==pane)
 let resized=Rect(x:-1600,y:-300,width:1200,height:850),smallerPane=Rect(x:-1500,y:-240,width:800,height:700)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:resized,pane:smallerPane,path:"0/19"),window:resized,complete:true)==smallerPane)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:root,pane:pane),window:resized,complete:true)==nil)
}

@Test func workspaceSuggestionRejectsIncompleteControlsSidebarsAndWholeWindows(){
 let root=Rect(x:0,y:30,width:1200,height:900),pane=Rect(x:60,y:70,width:900,height:800)
 let rows=workspaceRows(window:root,pane:pane)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows,window:root,complete:false)==nil)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:root,pane:root),window:root,complete:true)==nil)
 let sidebar=Rect(x:950,y:70,width:250,height:800)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:root,pane:sidebar),window:root,complete:true)==nil)
 var controls=rows;controls[1].role="AXButton"
 #expect(CanvasGeometry.suggestedWorkspace(nodes:controls,window:root,complete:true)==nil)
 var notAChain=rows;notAChain[1].childCount=2
 #expect(CanvasGeometry.suggestedWorkspace(nodes:notAChain,window:root,complete:true)==nil)
 var emptyInner=rows;emptyInner[2].childCount=0
 #expect(CanvasGeometry.suggestedWorkspace(nodes:emptyInner,window:root,complete:true)==nil)
 var mismatched=rows;mismatched[2].bounds=Rect(x:60,y:100,width:900,height:770)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:mismatched,window:root,complete:true)==nil)
 let offWindow=Rect(x:-10,y:70,width:900,height:800)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:root,pane:offWindow),window:root,complete:true)==nil)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows,window:Rect(x:Double.nan,y:0,width:1200,height:900),complete:true)==nil)
}

@Test func workspaceSuggestionRejectsAmbiguityRatherThanChoosingLargestGroup(){
 let root=Rect(x:0,y:30,width:1200,height:900),first=Rect(x:60,y:70,width:900,height:800),second=Rect(x:20,y:65,width:1050,height:820)
 var rows=workspaceRows(window:root,pane:first)
 rows.append(contentsOf:workspaceRows(window:root,pane:second,path:"0/8").dropFirst())
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows,window:root,complete:true)==nil)
 let duplicates=workspaceRows(window:root,pane:first)+Array(workspaceRows(window:root,pane:first,path:"0/8").dropFirst())
 #expect(CanvasGeometry.suggestedWorkspace(nodes:duplicates,window:root,complete:true)==first)
}

private func statusRow(_ bounds:Rect,path:String="0/1",role:String="AXStaticText",children:Int=8)->CanvasDiagnosticNode {
 CanvasDiagnosticNode(path:path,role:role,subrole:"",identifier:nil,bounds:bounds,childCount:children)
}

@Test func reviewedWorkspaceExcludesMeasuredBottomStatusBarWithoutClaimingViewportRecognition(){
 let root=Rect(x:0,y:30,width:1200,height:900),pane=Rect(x:60,y:70,width:900,height:860)
 let bar=Rect(x:0,y:899,width:1200,height:31),rows=workspaceRows(window:root,pane:pane)+[statusRow(bar)]
 let suggested=CanvasGeometry.suggestedWorkspace(nodes:rows,window:root,complete:true)
 #expect(suggested==Rect(x:60,y:70,width:900,height:829))
 let observation=CanvasObservation(generation:1,targetPid:123,workspaceSuggestion:suggested,reason:"Workspace requires review").json.object
 #expect(observation?["availability"]?.string=="unavailable");#expect(observation?["rect"] == .null);#expect(observation?["kind"] == .null)
 let anonymous=CanvasElement(role:"AXGroup",identifier:"",description:"",bounds:pane)
 #expect(CanvasGeometry.candidate(elements:[anonymous],window:root,complete:true) == .missing)
}

@Test func previouslyReportedWorkspaceAlreadyExcludesTheStatusBar(){
 let root=Rect(x:0,y:33,width:1512,height:949),pane=Rect(x:72,y:69,width:1172,height:882)
 let bar=Rect(x:0,y:951,width:1512,height:31)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:root,pane:pane)+[statusRow(bar)],window:root,complete:true)==pane)
}

@Test func statusBarCroppingUsesMeasuredLogicalBoundsAfterTranslationAndResize(){
 let root=Rect(x:-1600,y:-300,width:1400,height:1000),pane=Rect(x:-1500,y:-240,width:1000,height:940)
 for height in [23.0,47.5] {
  let bar=Rect(x:root.x,y:root.y+root.height-height,width:root.width,height:height)
  let rows=workspaceRows(window:root,pane:pane)+[statusRow(bar)]
  #expect(CanvasGeometry.suggestedWorkspace(nodes:rows,window:root,complete:true)==Rect(x:pane.x,y:pane.y,width:pane.width,height:bar.y-pane.y))
 }
 let resized=Rect(x:-1600,y:-300,width:1200,height:850),smallerPane=Rect(x:-1500,y:-240,width:800,height:790)
 let bar=Rect(x:-1600,y:519,width:1200,height:31)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:resized,pane:smallerPane)+[statusRow(bar)],window:resized,complete:true)==Rect(x:-1500,y:-240,width:800,height:759))
}

@Test func uncertainStatusBarGeometryLeavesTheReviewedWorkspaceUncropped(){
 let root=Rect(x:0,y:30,width:1200,height:900),pane=Rect(x:60,y:70,width:900,height:860)
 let actual=Rect(x:0,y:899,width:1200,height:31),rows=workspaceRows(window:root,pane:pane)
 let rejected=[statusRow(actual,path:"0/9/0"),statusRow(actual,role:"AXGroup"),statusRow(actual,children:0),
  statusRow(Rect(x:60,y:899,width:900,height:31)),statusRow(Rect(x:0,y:800,width:1200,height:31)),
  statusRow(Rect(x:0,y:600,width:1200,height:330)),statusRow(Rect(x:Double.nan,y:899,width:1200,height:31))]
 for candidate in rejected {#expect(CanvasGeometry.suggestedWorkspace(nodes:rows+[candidate],window:root,complete:true)==pane)}
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows,window:root,complete:true)==pane)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows+[statusRow(actual)],window:root,complete:false)==nil)
}

@Test func duplicateStatusFramesAreEquivalentButDifferentBottomStripsRemainAmbiguous(){
 let root=Rect(x:0,y:30,width:1200,height:900),pane=Rect(x:60,y:70,width:900,height:860)
 let bar=Rect(x:0,y:899,width:1200,height:31),rows=workspaceRows(window:root,pane:pane)
 let duplicate=[statusRow(bar),statusRow(bar,path:"0/2",role:"AXStatusBar",children:0)]
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows+duplicate,window:root,complete:true)==Rect(x:60,y:70,width:900,height:829))
 let conflicting=Rect(x:0,y:910,width:1200,height:20)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows+[statusRow(bar),statusRow(conflicting,path:"0/2")],window:root,complete:true)==pane)
 let subpoint=Rect(x:0,y:899.5,width:1200,height:30.5)
 let ambiguous=[statusRow(bar),statusRow(subpoint,path:"0/2")]
 for order in [ambiguous,Array(ambiguous.reversed())] {
  #expect(CanvasGeometry.suggestedWorkspace(nodes:rows+order,window:root,complete:true)==pane)
 }
}

@Test func statusCroppingPreservesMinimumCanvasSizeAndUsesOnlySmallAlignmentTolerance(){
 let smallRoot=Rect(x:0,y:0,width:400,height:220),smallPane=Rect(x:30,y:80,width:300,height:140)
 let smallBar=Rect(x:0,y:176,width:400,height:44)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:workspaceRows(window:smallRoot,pane:smallPane)+[statusRow(smallBar)],window:smallRoot,complete:true)==smallPane)
 let root=Rect(x:0,y:30,width:1200,height:900),pane=Rect(x:60,y:70,width:900,height:860),rows=workspaceRows(window:root,pane:pane)
 let aligned=Rect(x:0.5,y:899,width:1199,height:30.5)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows+[statusRow(aligned)],window:root,complete:true)==Rect(x:60,y:70,width:900,height:829))
 let shifted=Rect(x:2,y:899,width:1198,height:31)
 #expect(CanvasGeometry.suggestedWorkspace(nodes:rows+[statusRow(shifted)],window:root,complete:true)==pane)
}

@Test func documentIdentityDoesNotDependOnWindowSourceOrGeometry(){
 let identity=CanvasGeometry.documentSignature(title:"Sketch.kra * — Krita")
 #expect(identity == CanvasGeometry.documentSignature(title:"Sketch.kra — Krita"))
 #expect(identity != CanvasGeometry.documentSignature(title:"Other.kra — Krita"))
 #expect(CanvasGeometry.stableWindowID(previousID:"ax:123:7",sameRoot:true,matchedID:"cg:123:8",fallbackID:"ax:123:7") == "ax:123:7")
 #expect(CanvasGeometry.stableWindowID(previousID:"cg:123:8",sameRoot:true,matchedID:nil,fallbackID:"ax:123:7") == "cg:123:8")
 #expect(CanvasGeometry.stableWindowID(previousID:"ax:123:7",sameRoot:false,matchedID:"cg:123:9",fallbackID:"ax:123:10") == "cg:123:9")
}

@Test func structuralDiagnosticsRedactUserTextAndInvalidGeometry()throws{
 let secret="private-artwork.kra /Users/artist/My Work"
 let invalid=Rect(x:Double.nan,y:0,width:100,height:100)
 let row=CanvasDiagnosticNode(path:"0/1/2",role:"AXGroup",subrole:"AXLayoutArea",identifier:secret,bounds:invalid,childCount:2)
 let diagnostics=CanvasAccessibilityDiagnostics(inspected:1,complete:true,nodes:[row],windowSource:"ax")
 let json=diagnostics.json.object!
 let nodes: [JSONValue]
 if case .array(let values)=json["nodes"]! {nodes=values} else {nodes=[]}
 #expect(nodes.first?.object?["identifier"] == .null);#expect(nodes.first?.object?["bounds"] == .null)
 let data=try JSONEncoder().encode(diagnostics.json)
 #expect(!String(decoding:data,as:UTF8.self).contains(secret))
 let unsupportedRole=CanvasDiagnosticNode(path:"0",role:"AXCustom_Content",subrole:"AXCustom_Content",identifier:nil,bounds:nil,childCount:0)
 #expect(unsupportedRole.role=="AXUnknown");#expect(unsupportedRole.subrole=="")
 for identifier in ["qt_scrollarea_viewport","KisOpenGLCanvas2","view_12","canvasWidget","centralWidget","viewport"] {#expect(CanvasDiagnosticNode.safeIdentifier(identifier)==identifier)}
 for identifier in [secret,"My sketch","file.kra","/tmp/canvas","canvas:private","random_user_text",String(repeating:"q",count:200)] {#expect(CanvasDiagnosticNode.safeIdentifier(identifier)==nil)}
}

@Test func diagnosticNodeAndPayloadCapsStayBelowWireLimit()throws{
 let path=Array(repeating:"1234",count:24).joined(separator:"/")
 let row=CanvasDiagnosticNode(path:path,role:"AX"+String(repeating:"R",count:62),subrole:"AX"+String(repeating:"S",count:62),identifier:"qt_"+String(repeating:"x",count:60),bounds:Rect(x:1e200,y:1e200,width:1e190,height:1e190),childCount:9000)
 let diagnostics=CanvasAccessibilityDiagnostics(inspected:5000,complete:false,nodes:Array(repeating:row,count:64),windowSource:"unexpected source")
 #expect(diagnostics.nodes.count<=32);#expect(diagnostics.truncated);#expect(diagnostics.inspected==4096);#expect(diagnostics.windowSource=="none")
 #expect(diagnostics.nodes.allSatisfy{$0.path.count<=80 && $0.role.count<=64 && $0.subrole.count<=64 && $0.childCount<=4096})
 #expect(try JSONEncoder().encode(diagnostics.json).count<=10*1024)
 let event=CanvasObservation(generation:3,targetPid:123,windowId:"cg:123:1",windowBounds:window,windowToken:"document",reason:"No identifiable viewport",diagnostics:diagnostics)
 let frame=Envelope(session:"00000000-0000-4000-8000-000000000001",seq:1,type:"canvasObservation",payload:event.json)
 #expect(try JSONEncoder().encode(frame).count<Wire.maximumBytes)
}

@Test func diagnosticPathsRemainIndexedAndStableAcrossSearchPolls(){
 var search=CanvasTreeSearch<Int>();search.reset(signature:"document",root:0)
 search.advance(nodeBudget:1,mayContinue:{true}){_ in CanvasTreeNode(element:nil,children:[5,8])}
 #expect(search.diagnosticPaths[0]=="0")
 search.advance(nodeBudget:4,mayContinue:{true}){node in CanvasTreeNode(element:nil,children:node==5 ? [9] : [])}
 #expect(search.diagnosticPaths[5]=="0/0");#expect(search.diagnosticPaths[8]=="0/1");#expect(search.diagnosticPaths[9]=="0/0/0")
 search.reset(signature:"other",root:10);#expect(search.diagnosticPaths.isEmpty)
}

@Test func incompleteViewportSearchStillPublishesWindowResizeAndDocumentIdentity(){
 let first=Rect(x:-1200,y:-100,width:1100,height:850)
 let moved=Rect(x:-1100,y:-100,width:1100,height:850)
 let resized=Rect(x:-1200,y:-100,width:1000,height:850)
 let baseline=CanvasGeometry.windowSignature(id:"cg:123:7",bounds:first,title:"Sketch.kra * — Krita")
 #expect(baseline==CanvasGeometry.windowSignature(id:"cg:123:7",bounds:first,title:"Sketch.kra — Krita"))
 #expect(baseline != CanvasGeometry.windowSignature(id:"cg:123:7",bounds:moved,title:"Sketch.kra — Krita"))
 #expect(baseline != CanvasGeometry.windowSignature(id:"cg:123:7",bounds:resized,title:"Sketch.kra — Krita"))
 #expect(baseline != CanvasGeometry.windowSignature(id:"cg:123:7",bounds:first,title:"Other.kra — Krita"))
 let observation=CanvasObservation(generation:1,targetPid:123,windowId:"cg:123:7",windowBounds:resized,windowToken:"resized-document",reason:"Search continuing").json.object
 #expect(observation?["layoutToken"] == .null)
 #expect((try? observation?["windowBounds"]?.decode(Rect.self)) == resized)
 #expect(observation?["windowToken"]?.string == "resized-document")
 #expect(observation?["availability"]?.string == "unavailable")
}

@Test func canvasNameCanBeExposedAsAccessibleTitleWithoutIdentifier(){
 let titled=CanvasElement(role:"AXGroup",identifier:"",description:"",title:"Drawing Canvas",bounds:viewport)
 #expect(CanvasGeometry.candidate(elements:[titled],window:window,complete:true) == .available(viewport))
 let unrelated=CanvasElement(role:"AXButton",identifier:"",description:"",title:"Drawing Canvas",bounds:viewport)
 #expect(CanvasGeometry.candidate(elements:[unrelated],window:window,complete:true) == .missing)
}

@Test func incrementalSearchFinishesAViewportBeyondTwoHundredNodes(){
 var search=CanvasTreeSearch<Int>()
 search.reset(signature:"document-1",root:0)
 var reads:[Int]=[]
 func read(_ node:Int)->CanvasTreeNode<Int> {
  reads.append(node)
  return CanvasTreeNode(element:node==350 ? canvas() : nil,children:node==0 ? Array(1...350) : [])
 }
 search.advance(nodeBudget:96,mayContinue:{true},read:read)
 #expect(!search.finished);#expect(search.inspected==96)
 search.advance(nodeBudget:96,mayContinue:{true},read:read)
 #expect(!search.finished);#expect(search.inspected==192)
 search.advance(nodeBudget:96,mayContinue:{true},read:read)
 #expect(!search.finished);#expect(search.inspected==288)
 search.advance(nodeBudget:96,mayContinue:{true},read:read)
 #expect(search.complete);#expect(reads.count==351);#expect(Set(reads).count==351)
 #expect(CanvasGeometry.candidate(elements:search.elements,window:window,complete:search.complete) == .available(viewport))
 #expect(search.paths[350] == [0,350])
}

@Test func incrementalSearchPreservesProgressAtDeadlineAndResetsForDocumentChange(){
 var search=CanvasTreeSearch<Int>();search.reset(signature:"document-1",root:0)
 var budget=3
 search.advance(nodeBudget:96,mayContinue:{budget>0}){node in budget-=1;return CanvasTreeNode(element:nil,children:node==0 ? [1,2,3,4] : [])}
 #expect(search.inspected==3);#expect(!search.finished)
 search.advance(nodeBudget:96,mayContinue:{true}){node in CanvasTreeNode(element:node==4 ? canvas() : nil,children:[])}
 #expect(search.complete);#expect(search.inspected==5);#expect(search.paths[4]==[0,4])
 search.reset(signature:"document-2",root:10)
 #expect(search.elements.isEmpty);#expect(search.paths.isEmpty);#expect(search.inspected==0)
 search.advance(nodeBudget:96,mayContinue:{true}){_ in CanvasTreeNode(element:nil,children:[])}
 #expect(search.signature=="document-2");#expect(search.complete);#expect(search.elements.isEmpty)
}

@Test func dockControlPruningAvoidsEnumeratingLargeUnrelatedLists(){
 var search=CanvasTreeSearch<Int>();search.reset(signature:"document-1",root:0)
 var visited:[Int]=[]
 search.advance(nodeBudget:96,mayContinue:{true}){node in
  visited.append(node)
  if node==0{return CanvasTreeNode(element:nil,children:[1,2])}
  if node==1{
   let controls=CanvasElement.searchesChildren(role:"AXList",identifier:"layers") ? Array(100...10000) : []
   return CanvasTreeNode(element:nil,children:controls)
  }
  return CanvasTreeNode(element:canvas(),children:[])
 }
 #expect(search.complete);#expect(visited==[0,1,2])
 #expect(CanvasGeometry.candidate(elements:search.elements,window:window,complete:search.complete) == .available(viewport))
 #expect(!CanvasElement.searchesChildren(role:"AXToolbar",identifier:""))
 #expect(CanvasElement.searchesChildren(role:"AXGroup",identifier:""))
}

@Test func incrementalSearchRetriesFailedReadsWithoutDiscardingOtherBranches(){
 var search=CanvasTreeSearch<Int>();search.reset(signature:"document-1",root:0)
 var attempts=0
 search.advance(nodeBudget:96,mayContinue:{true}){node in
  if node==0{return CanvasTreeNode(element:nil,children:[1,2])}
  if node==1{attempts+=1;if attempts==1{return nil}}
  return CanvasTreeNode(element:node==1 ? canvas() : nil,children:[])
 }
 #expect(search.complete);#expect(search.inspected==3);#expect(attempts==2)
 #expect(search.paths[1]==[0,1])
}

@Test func searchCannotAcceptAmbiguousOrUnfinishedGeometry(){
 var search=CanvasTreeSearch<Int>(maximumNodes:5);search.reset(signature:"document-1",root:0)
 search.advance(nodeBudget:96,mayContinue:{true}){node in CanvasTreeNode(element:node==1 ? canvas() : nil,children:node==0 ? Array(1...7) : [])}
 #expect(search.finished);#expect(!search.complete)
 #expect(CanvasGeometry.candidate(elements:search.elements,window:window,complete:search.complete) == .incomplete)
 var ambiguous=CanvasTreeSearch<Int>();ambiguous.reset(signature:"document-1",root:0)
 ambiguous.advance(nodeBudget:96,mayContinue:{true}){node in
  CanvasTreeNode(element:node==1 ? canvas() : node==2 ? canvas(Rect(x:-1000,y:10,width:500,height:400)) : nil,children:node==0 ? [1,2] : [])
 }
 #expect(ambiguous.complete)
 #expect(CanvasGeometry.candidate(elements:ambiguous.elements,window:window,complete:ambiguous.complete) == .ambiguous)
}
@Test func restoreTargetProtocolOnlyAcceptsBoundedPositivePIDs()throws{
 let session="00000000-0000-4000-8000-000000000001"
 func wire(_ fields:[String:JSONValue])throws->Envelope{try Wire.parse(JSONEncoder().encode(Envelope(session:session,seq:1,type:"restoreTarget",payload:.object(fields))))}
 _ = try wire(["targetPid":.number(123)])
 for value in [JSONValue.number(0),.number(-1),.number(2147483648),.string("123")] {
  #expect(throws:(any Error).self){try wire(["targetPid":value])}
 }
 #expect(throws:(any Error).self){try wire(["targetPid":.number(123),"bundleId":.string("org.other")])}
}
@Test func restoreTargetStaysPausedAndCannotActivateAnotherPID(){
 let backend=FakeBackend()
 let tested=NativeEngine(backend:backend);let session="00000000-0000-4000-8000-000000000001"
 func send(_ seq:UInt64,_ type:String,_ fields:[String:JSONValue])->Envelope{tested.handle(Envelope(session:session,seq:seq,type:type,payload:.object(fields)),now:1000)}
 _ = send(1,"hello",["bundleId":.string("org.steady.local")])
 backend.foregroundBundle="org.steady.local";backend.foregroundPid=456
 let denied=send(2,"restoreTarget",["targetPid":.number(456)])
 #expect(denied.payload.object?["accepted"]?.bool==false);#expect(backend.foregroundPid==456)
 let restored=send(3,"restoreTarget",["targetPid":.number(123)])
 #expect(restored.payload.object?["accepted"]?.bool==true);#expect(backend.foregroundPid==123);#expect(backend.foregroundBundle=="org.krita")
 #expect(tested.snapshot.state == .paused);#expect(!tested.snapshot.buttonDown);#expect(!backend.events.contains("down"));#expect(!backend.events.contains("move"))
}
