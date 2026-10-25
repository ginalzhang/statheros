import Foundation
import Dispatch
import Testing
@testable import SteadyCore

private let session="00000000-0000-4000-8000-000000000001"
private func envelope(_ type:String,_ payload:[String:JSONValue],seq:UInt64=1)->Envelope {Envelope(session:session,seq:seq,type:type,payload:.object(payload))}
private final class Harness {
 let backend:FakeBackend;let engine:NativeEngine;var seq:UInt64=0
 init(backend:FakeBackend=FakeBackend(),boundedProbe:Bool=false){self.backend=backend;engine=NativeEngine(backend:backend,boundedProbe:boundedProbe);_ = send("hello",["bundleId":.string("org.steady.local")]);_ = send("configure",["generation":.number(1),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.encoded(Rect(x:-1000,y:100,width:500,height:500)),"excludedRects":.array([])])}
 @discardableResult func send(_ type:String,_ p:[String:JSONValue],now:Double=1000)->Envelope{seq+=1;return engine.handle(envelope(type,p,seq:seq),now:now)}
 @discardableResult func sample(_ frame:Int,_ time:Double,now:Double?=nil,point:Point=Point(x:-800,y:200))->Envelope{send("sample",["generation":.number(1),"frameId":.number(Double(frame)),"captureTimestamp":.number(time),"valid":.bool(true),"position":.encoded(point)],now:now ?? time)}
 @discardableResult func action(_ a:ActionID,now:Double=1500,event:String=UUID().uuidString)->Envelope{send("action",["generation":.number(1),"eventId":.string(event),"actionId":.string(a.rawValue)],now:now)}
 func ready(){for i in 0...5{sample(i+1,1000+Double(i)*100)};action(.resume)}
}
private func accepted(_ e:Envelope)->Bool{e.payload.object?["accepted"]?.bool==true}

@Test func sharedProtocolFixtures()throws {
 let root=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
 let json=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:root.appendingPathComponent("fixtures/protocol-v1.json")))
 let decodedPositive=try json.object?["positive"]?.decode([JSONValue].self)
 let positive=try #require(decodedPositive)
 for item in positive{_ = try Wire.parse(JSONEncoder().encode(item))}
 let decodedNegative=try json.object?["negative"]?.decode([[String:JSONValue]].self)
 let negative=try #require(decodedNegative)
 for item in negative{let line=try #require(item["line"]?.string);#expect(throws:(any Error).self){try Wire.parse(Data(line.utf8))}}
}
@Test func framingFragmentationAndCoalescing()throws {var f=LineFramer();#expect(try f.feed(Data("{\"text\":\"é".utf8)).isEmpty);let lines=try f.feed(Data("\"}\n{}\n".utf8));#expect(lines.count==2);#expect(String(data:lines[0],encoding:.utf8)=="{\"text\":\"é\"}");#expect(!f.hasIncompleteLine)}
@Test func byteLimit()throws {var f=LineFramer();#expect(try f.feed(Data(repeating:65,count:16384)).isEmpty);#expect(try f.feed(Data([10])).first?.count==16384);#expect(throws:(any Error).self){try f.feed(Data(repeating:65,count:16385))}}
@Test func invalidUTF8Rejected(){#expect(throws:(any Error).self){try Wire.parse(Data([255]))}}
@Test func unknownFieldsRejected()throws {let e=envelope("shutdown",["shell":.string("x")]);#expect(throws:(any Error).self){try Wire.parse(JSONEncoder().encode(e))}}
@Test func helloHandshakeAndNullableFields(){let h=Harness();let s=h.engine.snapshot;#expect(s.state == .paused);#expect(!s.buttonDown);let r=h.send("ping",["senderTimestamp":.number(1000)]);let p=r.payload.object;#expect(p?["nativeTimestamp"]?.number==1000);#expect(p?["state"]?.object?["latestValidFrame"] == .null)}
@Test func duplicateAndDecreasingSequences(){let h=Harness();let e=envelope("ping",["senderTimestamp":.number(1)],seq:1);#expect(!accepted(h.engine.handle(e,now:1000)));#expect(h.engine.snapshot.state == .paused)}
@Test func replacedSessionFaults(){let h=Harness();var e=envelope("ping",["senderTimestamp":.number(1)],seq:3);e.session=UUID().uuidString;#expect(!accepted(h.engine.handle(e,now:1000)));#expect(h.engine.snapshot.state == .fault)}
@Test func expiredGenerationRejected(){let h=Harness();let r=h.send("action",["generation":.number(0),"eventId":.string("e"),"actionId":.string("resume")]);#expect(!accepted(r));#expect(!h.backend.events.contains("down"))}
@Test func pausedNeverMoves(){let h=Harness();h.sample(1,1000);#expect(!h.backend.events.contains("move"));#expect(!accepted(h.action(.penDown)))}
@Test func resumeRequiresContinuous500ms(){let h=Harness();h.sample(1,1000);#expect(!accepted(h.action(.resume,now:1000)));h.ready();#expect(h.engine.snapshot.state == .hover)}
@Test func staleCaptureWithLiveHeartbeatsReleases(){let h=Harness();h.ready();#expect(accepted(h.action(.penDown)));#expect(h.engine.snapshot.buttonDown);for time in stride(from:1510.0,through:1740,by:10){_ = h.send("ping",["senderTimestamp":.number(time)],now:time);h.engine.watchdog(now:time)};#expect(h.engine.snapshot.buttonDown);h.engine.watchdog(now:1750);#expect(!h.engine.snapshot.buttonDown);#expect(h.engine.snapshot.state == .paused);#expect(h.engine.snapshot.reason=="stale-capture");#expect(h.backend.events.last=="up")}
@Test func eofReleases(){let h=Harness();h.ready();h.action(.penDown);h.engine.disconnect();#expect(!h.engine.snapshot.buttonDown);#expect(h.backend.events.last=="up");#expect(!accepted(h.action(.resume)))}
@Test func emergencyReleaseInFault(){let h=Harness();h.engine.pause("test",fault:true);h.engine.emergencyRelease();#expect(h.backend.events.last=="up");#expect(!h.engine.snapshot.buttonDown)}
@Test func foregroundChangePauses(){let h=Harness();h.ready();h.action(.penDown);h.backend.foregroundBundle="org.other";h.engine.refreshMetadata();h.engine.watchdog(now:1510);#expect(h.engine.snapshot.state == .paused);#expect(h.backend.events.last=="up");h.backend.foregroundBundle="org.krita";h.engine.refreshMetadata();h.sample(7,1520);#expect(h.engine.snapshot.state == .paused)}
@Test func targetPIDMismatchRejects(){let h=Harness();h.ready();h.backend.foregroundPid=456;#expect(!accepted(h.action(.penDown)));#expect(!h.engine.snapshot.buttonDown)}
@Test func canvasExitEndsStrokeWithoutReentryDown(){let h=Harness();h.ready();h.action(.penDown);h.sample(7,1510,point:Point(x:-1100,y:200));#expect(h.engine.snapshot.state == .hover);#expect(!h.engine.snapshot.buttonDown);h.sample(8,1520);#expect(!h.engine.snapshot.buttonDown)}
@Test func staleOrFutureFrameNeverRefreshes(){let h=Harness();h.ready();#expect(!accepted(h.sample(7,1600,now:1500)));#expect(!accepted(h.sample(7,1000,now:1500)));#expect(!accepted(h.sample(2,1501,now:1501)));#expect(h.engine.snapshot.latestValidFrame==6)}
@Test func duplicateEventsNeverPostTwice(){let h=Harness();h.ready();#expect(accepted(h.action(.click,event:"click-1")));let before=h.backend.events.count;#expect(!accepted(h.action(.click,event:"click-1")));#expect(h.backend.events.count==before)}
@Test func shortcutsReleaseFirst(){let h=Harness();h.ready();h.action(.penDown);h.action(.undo);#expect(Array(h.backend.events.suffix(2))==["up","undo"]);#expect(h.engine.snapshot.state == .hover)}
@Test func exactGrammar(){for (phrase,a) in VoiceGrammar.phrases{#expect(VoiceGrammar.parse(phrase)==a)};#expect(VoiceGrammar.parse("Steady, PEN UP!") == .penUp);for text in ["pen up","steady draw","steady pen up and undo","steady click steady click"]{#expect(VoiceGrammar.parse(text)==nil)}}
@Test func finalSpansAndSessionCancellation(){var a=UtteranceAssembler();a.enable(session);a.add(FinalSpan(start:0,end:0.3,text:"Steady"),session:session,final:false);#expect(a.accept(session:session,through:0.4,speechEnd:0.3,audioOrigin:1000,now:1400)?.action==nil);a.enable(session);a.add(FinalSpan(start:0,end:0.3,text:"Steady"),session:session,final:true);a.add(FinalSpan(start:0.3,end:0.6,text:"pen up"),session:session,final:true);#expect(a.accept(session:session,through:1,speechEnd:0.6,audioOrigin:1000,now:2000)?.action == .penUp);#expect(a.accept(session:session,through:1,speechEnd:0.6,audioOrigin:1000,now:2000)==nil);a.disable();#expect(a.accept(session:session,through:2,speechEnd:1,audioOrigin:1000,now:2000)==nil)}
@Test func lateAndOverlongSpeechRejected(){var a=UtteranceAssembler();a.enable(session);a.add(FinalSpan(start:0,end:0.2,text:"steady click"),session:session,final:true);let late=a.accept(session:session,through:0.6,speechEnd:0.2,audioOrigin:1000,now:2800);#expect(late?.action==nil);#expect(late?.reason=="late-result-retry");a.enable(session);a.add(FinalSpan(start:0,end:1,text:"steady click"),session:session,final:true);#expect(a.accept(session:session,through:6,speechEnd:6,audioOrigin:1000,now:7000,tooLong:true)?.action==nil)}

@Test func deferredVoiceCannotScheduleCaptureOrAssetInstallation(){
 let h=Harness();let before=h.engine.snapshot
 for (type,payload) in [("microphone",["enabled":JSONValue.bool(true),"speechSession":.string(session)]),("installSpeechAssets",["locale":.string("en-US")])]{
  let reply=h.send(type,payload);#expect(!accepted(reply));#expect(reply.payload.object?["code"]?.string=="voice-deferred-phase01")
 }
 #expect(h.engine.snapshot.state==before.state);#expect(!h.engine.snapshot.buttonDown)
 #expect(accepted(h.send("microphone",["enabled":.bool(false),"speechSession":.string(session)])))
 #expect(accepted(h.action(.pause)));#expect(accepted(h.action(.penUp)))
}

@Test func pauseAndPenUpReleaseWithoutRecoveringFault(){let h=Harness();h.engine.pause("injected-fault",fault:true);#expect(accepted(h.action(.pause)));#expect(h.engine.snapshot.state == .fault);#expect(accepted(h.action(.penUp)));#expect(h.engine.snapshot.state == .fault);#expect(Array(h.backend.events.suffix(2))==["up","up"])}

@Test func faultCannotRecoverThroughRecenterConfigureOrEmergency(){let h=Harness();h.engine.pause("fault",fault:true);h.action(.recenter);#expect(h.engine.snapshot.state == .fault);h.engine.emergencyRelease();#expect(h.engine.snapshot.state == .fault);let reply=h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.null,"excludedRects":.array([])]);#expect(!accepted(reply));#expect(h.engine.snapshot.state == .fault);#expect(!h.engine.snapshot.buttonDown)}

@Test func pingSnapshotAndWatchdogNeverPerformPlatformReporting(){let h=Harness();h.ready();let reads=h.backend.metadataReads;_ = h.engine.snapshot;_ = h.send("ping",["senderTimestamp":.number(1510)],now:1510);h.engine.watchdog(now:1510);#expect(h.backend.metadataReads==reads)}

@Test func blockedMetadataCannotDelayFreshnessReleaseOrRevivePausedState()throws{
 let h=Harness();h.ready();h.action(.penDown)
 let entered=DispatchSemaphore(value:0),unblock=DispatchSemaphore(value:0),finished=DispatchSemaphore(value:0)
 h.backend.beforeNextMetadataRead={entered.signal();_ = unblock.wait(timeout:.now()+2)}
 DispatchQueue.global().async{[engine=h.engine] in engine.refreshMetadata();finished.signal()}
 defer{unblock.signal()}
 try #require(entered.wait(timeout:.now()+1) == .success)
 h.engine.watchdog(now:1750);#expect(!h.engine.snapshot.buttonDown);#expect(h.engine.snapshot.state == .paused);#expect(h.backend.events.last=="up")
 h.engine.pause("foreground-changed");unblock.signal();try #require(finished.wait(timeout:.now()+1) == .success);#expect(h.engine.snapshot.state == .paused)
}

@Test func rejectedPerPostGuardReleasesAndNeverClaimsButtonHeld(){let h=Harness();h.ready();h.backend.rejectPosts=true;#expect(!accepted(h.action(.penDown)));#expect(!h.engine.snapshot.buttonDown);#expect(h.engine.snapshot.state == .paused);let moving=Harness();moving.ready();moving.action(.penDown);moving.backend.rejectPosts=true;#expect(!accepted(moving.sample(7,1510)));#expect(!moving.engine.snapshot.buttonDown);#expect(moving.backend.events.last=="up")}

@Test func canvaslessProbePausedBeforeSamplesNeverAttemptsHover() {
 let h=Harness()
 h.backend.foregroundBundle="org.other";h.backend.foregroundPid=456;h.engine.refreshMetadata()
 #expect(accepted(h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.null,"excludedRects":.array([])])))
 #expect(h.engine.snapshot.state == .setup)
 #expect(accepted(h.send("action",["generation":.number(2),"eventId":.string("probe-pause"),"actionId":.string("pause")])))
 #expect(accepted(h.send("sample",["generation":.number(2),"frameId":.number(1),"captureTimestamp":.number(1000),"valid":.bool(true),"position":.encoded(Point(x:-800,y:200))])))
 #expect(h.engine.snapshot.state == .paused);#expect(!h.engine.snapshot.buttonDown)
 #expect(!h.backend.events.contains("move"));#expect(!h.backend.events.contains("down"))
}

@Test func equivalentDisplayCallbackPausesWithoutErasingConfiguredGeometry() {
 let h=Harness();h.ready();h.action(.penDown);let epoch=h.engine.beginDisplayChange()
 #expect(h.engine.snapshot.state == .paused);#expect(!h.engine.snapshot.buttonDown);#expect(h.backend.events.last=="up")
 #expect(!accepted(h.action(.resume)))
 #expect(!accepted(h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.null,"excludedRects":.array([])])))
 #expect(accepted(h.sample(7,1510)));#expect(h.engine.snapshot.latestValidFrame==6)
 h.backend.displayInfos[0].workArea.y=0;h.backend.displayInfos[0].workArea.height=900
 h.engine.endDisplayChange(epoch:epoch);#expect(h.engine.snapshot.state == .paused)
 for index in 0...5 {#expect(accepted(h.sample(7+index,1600+Double(index)*100)))}
 #expect(h.engine.snapshot.latestValidFrame==12);#expect(h.engine.snapshot.state == .paused)
 #expect(accepted(h.action(.resume,now:2100)));#expect(h.engine.snapshot.state == .hover)
}
@Test func genuineDisplayGeometryScaleOrTopologyChangeInvalidatesCanvas() {
 for change in ["origin","scale","topology"] {
  let h=Harness();h.ready();h.action(.penDown);let epoch=h.engine.beginDisplayChange()
  switch change {
  case "origin":h.backend.displayInfos[0].bounds.x = -1400
  case "scale":h.backend.displayInfos[0].scaleFactor = 1
  default:h.backend.displayInfos.append(DisplayInfo(id:2,bounds:Rect(x:0,y:0,width:1200,height:900),workArea:Rect(x:0,y:24,width:1200,height:876),builtIn:false,primary:false,scaleFactor:1))
  }
  h.engine.endDisplayChange(epoch:epoch);#expect(h.engine.snapshot.state == .paused);#expect(!h.engine.snapshot.buttonDown)
  for index in 0...5 {#expect(accepted(h.sample(7+index,1600+Double(index)*100)))}
  #expect(h.engine.snapshot.latestValidFrame==6);#expect(!accepted(h.action(.resume,now:2100)))
 }
}

@Test func blockedDisplayRefreshCannotRearmOrClearANewerPendingChange() throws {
 let h=Harness();h.ready();h.action(.penDown);let epoch=h.engine.beginDisplayChange()
 let entered=DispatchSemaphore(value:0),unblock=DispatchSemaphore(value:0),finished=DispatchSemaphore(value:0)
 h.backend.beforeNextMetadataRead={entered.signal();_ = unblock.wait(timeout:.now()+2)}
 DispatchQueue.global().async{[engine=h.engine] in engine.endDisplayChange(epoch:epoch);finished.signal()}
 defer{unblock.signal()}
 try #require(entered.wait(timeout:.now()+1) == .success)
 #expect(!accepted(h.action(.resume)));#expect(!h.engine.snapshot.buttonDown)
 let newerEpoch=h.engine.beginDisplayChange();unblock.signal();try #require(finished.wait(timeout:.now()+1) == .success)
 #expect(!accepted(h.action(.resume)))
 h.engine.endDisplayChange(epoch:newerEpoch)
 for index in 0...5 {#expect(accepted(h.sample(7+index,1600+Double(index)*100)))}
 #expect(h.engine.snapshot.latestValidFrame==12);#expect(h.engine.snapshot.state == .paused)
}

@Test func queuedOldDisplayEndCannotAdoptANewerBeginEpoch() {
 let h=Harness();h.ready();let queuedEndEpoch=h.engine.beginDisplayChange()
 let currentEpoch=h.engine.beginDisplayChange();let reads=h.backend.metadataReads
 h.engine.endDisplayChange(epoch:queuedEndEpoch)
 #expect(h.backend.metadataReads==reads);#expect(!accepted(h.action(.resume)))
 #expect(!accepted(h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.null,"excludedRects":.array([])])))
 h.engine.endDisplayChange(epoch:currentEpoch)
 for index in 0...5 {#expect(accepted(h.sample(7+index,1600+Double(index)*100)))}
 #expect(h.engine.snapshot.latestValidFrame==12);#expect(h.engine.snapshot.state == .paused)
}

// Phase 03: fake input only. Geometry is Quartz logical points, including negative origins.
@Test func phase03SharedCanvasGeometryFixtures() throws {
 let root=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
 let fixtures=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:root.appendingPathComponent("fixtures/phase03-v1.json")))
 for group in ["positive","negative"] {
  let decoded=try fixtures.object?["canvas"]?.object?[group]?.decode([[String:JSONValue]].self)
  let entries=try #require(decoded)
  for entry in entries {
   let h=Harness();let decodedBounds=try entry["display"]?.decode(Rect.self),decodedPanel=try entry["panel"]?.decode(Rect.self),decodedCorners=try entry["corners"]?.decode([Point].self)
   let bounds=try #require(decodedBounds),panel=try #require(decodedPanel),corners=try #require(decodedCorners)
   h.backend.displayInfos[0].bounds=bounds;h.engine.refreshMetadata()
   let rect=Rect(x:corners[0].x,y:corners[0].y,width:corners[1].x-corners[0].x,height:corners[1].y-corners[0].y)
   let reply=h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.encoded(rect),"excludedRects":.encoded([panel])])
   #expect(accepted(reply)==(group=="positive"),"\(entry["name"]?.string ?? "fixture")")
  }
 }
}

@Test func setupHoverIsPenUpAndCannotClickDrawOrDeliverTargetShortcuts() {
 let h=Harness();#expect(accepted(h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.null,"excludedRects":.array([])])))
 for index in 0...5 {
  let t=1000+Double(index)*100
  #expect(accepted(h.send("sample",["generation":.number(2),"frameId":.number(Double(index+1)),"captureTimestamp":.number(t),"valid":.bool(true),"position":.encoded(Point(x:-800,y:200))],now:t)))
 }
 #expect(h.engine.snapshot.state == .setup);#expect(h.backend.events.contains("move"));#expect(!h.engine.snapshot.buttonDown)
 for a in [ActionID.penDown,.penToggle,.click,.undo,.redo,.brush,.toggleErase,.bigger,.smaller,.resume] {
  #expect(!accepted(h.send("action",["generation":.number(2),"eventId":.string(UUID().uuidString),"actionId":.string(a.rawValue)],now:1500)))
 }
 #expect(!h.backend.events.contains("down"));#expect(!h.backend.events.contains("undo"))
 h.engine.watchdog(now:1750);#expect(h.engine.snapshot.state == .paused);#expect(!h.engine.snapshot.buttonDown)
}

@Test func setupWaitsForFirstFrameButFreshnessStillExpiresAt250ms() {
 let h=Harness();h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.null,"excludedRects":.array([])],now:2000)
 h.engine.watchdog(now:2249);#expect(h.engine.snapshot.state == .setup)
 h.engine.watchdog(now:2250);#expect(h.engine.snapshot.state == .paused)
}

@Test func panelEntryReleasesBeforePenUpHoverAndNeverClicksThrough() {
 let h=Harness();h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.encoded(Rect(x:-1000,y:100,width:500,height:500)),"excludedRects":.encoded([Rect(x:-400,y:100,width:320,height:560)])])
 func sample(_ frame:Int,_ time:Double,_ p:Point) {h.send("sample",["generation":.number(2),"frameId":.number(Double(frame)),"captureTimestamp":.number(time),"valid":.bool(true),"position":.encoded(p)],now:time)}
 func action(_ a:ActionID)->Envelope {h.send("action",["generation":.number(2),"eventId":.string(UUID().uuidString),"actionId":.string(a.rawValue)],now:1510)}
 for i in 0...5 {sample(i+1,1000+Double(i)*100,Point(x:-800,y:200))}
 #expect(accepted(action(.resume)));#expect(accepted(action(.penDown)))
 sample(7,1510,Point(x:-300,y:200));#expect(h.engine.snapshot.state == .hover);#expect(!h.engine.snapshot.buttonDown)
 #expect(Array(h.backend.events.suffix(2))==["up","move"])
 let downs=h.backend.events.filter{$0=="down"}.count;#expect(!accepted(action(.click)));#expect(h.backend.events.filter{$0=="down"}.count==downs)
 sample(8,1520,Point(x:-800,y:200));#expect(!h.engine.snapshot.buttonDown);#expect(h.backend.events.last=="move")
}

@Test func invalidFramesFreezeAndResetResumeContinuityWithoutRefreshingFreshness() {
 let h=Harness();h.ready();h.action(.penDown);let positions=h.backend.positions.count
 h.send("sample",["generation":.number(1),"frameId":.number(7),"captureTimestamp":.number(1600),"valid":.bool(false),"position":.null],now:1600)
 #expect(h.backend.positions.count==positions);h.engine.watchdog(now:1749);#expect(h.engine.snapshot.buttonDown)
 h.engine.watchdog(now:1750);#expect(!h.engine.snapshot.buttonDown);#expect(h.engine.snapshot.state == .paused)
 h.sample(8,1760);#expect(!accepted(h.action(.resume,now:1760)));#expect(h.engine.snapshot.state == .paused)
 for i in 0...4 {h.sample(9+i,1860+Double(i)*100)}
 #expect(accepted(h.action(.resume,now:2260)));#expect(!h.engine.snapshot.buttonDown)
}

@Test func pausedTargetShortcutsAreAllowedButMovementAndClicksAreBlocked() {
 let h=Harness();h.sample(1,1000);let count=h.backend.positions.count
 for a in [ActionID.undo,.redo,.brush,.toggleErase,.bigger,.smaller,.swapColors] {#expect(accepted(h.action(a,now:1000)))}
 #expect(h.backend.positions.count==count);#expect(!accepted(h.action(.click,now:1000)));#expect(!h.backend.events.contains("down"))
 h.backend.foregroundBundle="org.other";#expect(!accepted(h.action(.undo)));#expect(h.engine.snapshot.state == .paused)
}

@Test func logicalCoordinatesAreNeverMultipliedByRetinaScale() {
 let h=Harness();h.ready();let p=Point(x:-799.25,y:210.5);h.sample(7,1510,point:p)
 #expect(h.backend.positions.last==p);#expect(h.backend.displayInfos[0].scaleFactor==2)
}

@Test func pauseAndPenUpAlwaysReleaseEvenForAnExpiredGeneration() {
 let h=Harness();h.ready();h.action(.penDown)
 for a in [ActionID.penUp,.pause] {
  let reply=h.send("action",["generation":.number(0),"eventId":.string(UUID().uuidString),"actionId":.string(a.rawValue)])
  #expect(!accepted(reply));#expect(!h.engine.snapshot.buttonDown);#expect(h.backend.events.last=="up")
 }
}

@Test func accessibilityLossReleasesAndRestorationNeverResumes() {
 let h=Harness();h.ready();h.action(.penDown);h.backend.accessibility=false;h.engine.refreshMetadata()
 #expect(h.engine.snapshot.state == .paused);#expect(!h.engine.snapshot.buttonDown)
 h.backend.accessibility=true;h.engine.refreshMetadata();h.sample(7,1510)
 #expect(h.engine.snapshot.state == .paused);#expect(!h.engine.snapshot.buttonDown)
}

@Test func targetDiscoveryIsReportedWithoutForegroundingTheTarget() {
 let h=Harness();let reply=h.send("ping",["senderTimestamp":.number(1500)])
 #expect(reply.payload.object?["targetPid"]?.uint==123)
 h.backend.foregroundBundle="org.other";h.backend.foregroundPid=456;h.engine.refreshMetadata()
 #expect(h.send("ping",["senderTimestamp":.number(1500)]).payload.object?["targetPid"]?.uint==123)
 #expect(!h.backend.events.contains("move"))
}


@Test func ordinaryRealFlagSessionHasNoProbeDeadlineButProbeRemainsBounded() {
 for bounded in [false,true] {
  let h=Harness(backend:FakeBackend(realFlag:true),boundedProbe:bounded);h.ready()
  for index in 1...150 {let time=1500+Double(index)*100;h.sample(6+index,time);h.engine.watchdog(now:time)}
  #expect(h.engine.snapshot.state == (bounded ? .paused : .hover));#expect(!h.engine.snapshot.buttonDown)
 }
}

@Test func sampleAcknowledgmentsDistinguishPostedMovementFromPausedSamples() {
 let h=Harness();#expect(h.sample(1,900).payload.object?["code"]?.string=="ok");h.ready()
 #expect(h.sample(7,1510).payload.object?["code"]?.string=="move-posted")
}

@Test func failedMouseUpFaultsWithoutClaimingReleaseOrPostingMoreInput() {
 for cause in ["pause","penUp","toggle","shortcut","click","canvas","panel","watchdog","foreground","configure","disconnect","emergency"] {
  let h=Harness();h.ready();h.action(.penDown);h.backend.rejectReleases=true
  switch cause {
  case "pause":#expect(!accepted(h.action(.pause)))
  case "penUp":#expect(!accepted(h.action(.penUp)))
  case "toggle":#expect(!accepted(h.action(.penToggle)))
  case "shortcut":#expect(!accepted(h.action(.undo)))
  case "click":#expect(!accepted(h.action(.click)))
  case "canvas":#expect(!accepted(h.sample(7,1510,point:Point(x:-1100,y:200))))
  case "panel":
   // A display change also has to preserve an unsuccessful release as FAULT.
   _ = h.engine.beginDisplayChange()
  case "watchdog":h.engine.watchdog(now:1750)
  case "foreground":h.backend.foregroundBundle="org.other";h.engine.refreshMetadata()
  case "configure":#expect(!accepted(h.send("configure",["generation":.number(2),"targetBundleId":.string("org.krita"),"targetPid":.number(123),"displayId":.number(1),"canvas":.null,"excludedRects":.array([])])))
  case "disconnect":h.engine.disconnect()
  default:h.engine.emergencyRelease()
  }
  #expect(h.engine.snapshot.state == .fault,"\(cause)")
  #expect(h.engine.snapshot.reason == "native-release-failed","\(cause)")
  #expect(h.engine.snapshot.buttonDown,"\(cause)")
  let count=h.backend.events.count;h.sample(8,1520);#expect(h.backend.events.count==count)
  h.backend.rejectReleases=false;h.engine.emergencyRelease()
  #expect(!h.engine.snapshot.buttonDown);#expect(h.engine.snapshot.state == .fault)
 }
}

@Test func faultedHeldButtonGetsIndependentReleaseRetriesWithoutAutomaticRecovery() {
 let h=Harness();h.ready();h.action(.penDown);h.backend.rejectReleases=true
 h.engine.watchdog(now:1750);#expect(h.engine.snapshot.state == .fault);#expect(h.engine.snapshot.buttonDown)
 h.backend.rejectReleases=false;h.engine.watchdog(now:1760)
 #expect(!h.engine.snapshot.buttonDown);#expect(h.engine.snapshot.state == .fault);#expect(h.backend.events.last=="up")
}

@Test func failedClickMouseUpRetainsHeldFlagUntilSuccessfulRelease() {
 let h=Harness();h.ready();h.backend.failReleaseAfterNextDown=true
 #expect(!accepted(h.action(.click)));#expect(h.engine.snapshot.state == .fault);#expect(h.engine.snapshot.buttonDown)
 #expect(h.backend.events.last=="down");h.backend.rejectReleases=false;h.engine.watchdog(now:1510)
 #expect(h.backend.events.last=="up");#expect(!h.engine.snapshot.buttonDown);#expect(h.engine.snapshot.state == .fault)
}

@Test func exactMaximumMappingEdgesProjectInsideSelectedLogicalDisplayOnly() {
 let h=Harness();h.ready();let bounds=h.backend.displayInfos[0].bounds
 let maximum=Point(x:bounds.x+bounds.width,y:bounds.y+bounds.height)
 #expect(accepted(h.sample(7,1510,point:maximum)))
 #expect(h.backend.positions.last==Point(x:maximum.x.nextDown,y:maximum.y.nextDown))
 #expect(h.engine.snapshot.latestValidFrame==7);let positions=h.backend.positions.count
 #expect(h.sample(8,1520,point:Point(x:maximum.x.nextUp,y:maximum.y)).payload.object?["code"]?.string=="invalid-sample")
 #expect(h.sample(9,1530,point:Point(x:maximum.x,y:maximum.y.nextUp)).payload.object?["code"]?.string=="invalid-sample")
 #expect(h.backend.positions.count==positions);#expect(h.engine.snapshot.latestValidFrame==7)
}
