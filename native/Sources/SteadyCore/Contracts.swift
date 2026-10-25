import Foundation

public enum InputState: String, Codable, Sendable { case setup = "SETUP", paused = "PAUSED", hover = "HOVER", drawing = "DRAWING", fault = "FAULT" }
public struct Point: Codable, Equatable, Sendable {
 public var x: Double; public var y: Double
 public init(x: Double, y: Double) { self.x=x; self.y=y }
 public var valid: Bool { x.isFinite && y.isFinite }
}
public struct Rect: Codable, Equatable, Sendable {
 public var x: Double; public var y: Double; public var width: Double; public var height: Double
 public init(x: Double, y: Double, width: Double, height: Double) { self.x=x; self.y=y; self.width=width; self.height=height }
 public var valid: Bool { [x,y,width,height,x+width,y+height].allSatisfy(\.isFinite) && width > 0 && height > 0 }
 public func contains(_ p: Point) -> Bool { p.x >= x && p.y >= y && p.x < x+width && p.y < y+height }
 public func contains(_ r: Rect) -> Bool { r.x >= x && r.y >= y && r.x+r.width <= x+width && r.y+r.height <= y+height }
 public func intersects(_ r: Rect) -> Bool { x < r.x+r.width && r.x < x+width && y < r.y+r.height && r.y < y+height }
}
public struct Permissions: Codable, Sendable {
 public var accessibility: Bool; public var camera: String; public var microphone: String; public var speech: String
 public init(accessibility: Bool, camera: String, microphone: String, speech: String) { self.accessibility=accessibility; self.camera=camera; self.microphone=microphone; self.speech=speech }
}
public struct NativeState: Codable, Sendable {
 public var state: InputState = .paused; public var reason = "launch-paused"; public var buttonDown = false
 public var foregroundTarget: String?; public var permissions: Permissions; public var generation: UInt64 = 0; public var latestValidFrame: UInt64?
 public var lastReleaseTimestamp: Double?; public var lastValidCaptureTimestamp: Double?
 public init(permissions: Permissions) { self.permissions=permissions }
}
public struct DisplayInfo: Codable, Sendable {
 public var id: UInt32; public var bounds: Rect; public var workArea: Rect; public var builtIn: Bool; public var primary: Bool; public var scaleFactor: Double
 public init(id: UInt32, bounds: Rect, workArea: Rect, builtIn: Bool, primary: Bool, scaleFactor: Double) { self.id=id; self.bounds=bounds; self.workArea=workArea; self.builtIn=builtIn; self.primary=primary; self.scaleFactor=scaleFactor }
}
public struct TrackingSample: Codable, Sendable { public var generation: UInt64; public var frameId: UInt64; public var captureTimestamp: Double; public var mode: String; public var valid: Bool; public var anchor: Point?; public var qualityReason: String; public var selectedHand: String? = nil }
public struct CalibrationV1: Codable, Sendable {
 public struct Extents: Codable, Sendable { public var left: Double; public var right: Double; public var up: Double; public var down: Double }
 public var schemaVersion: Int; public var cameraId: String; public var mode: String; public var selectedHand: String?; public var neutral: Point; public var extents: Extents; public var jitter: Point; public var gain: Double; public var smoothing: Double
}
public struct Command: Codable, Sendable { public var eventId: String; public var source: String; public var actionId: ActionID; public var generation: UInt64 }
public enum ActionID: String, Codable, CaseIterable, Sendable { case penDown, penUp, penToggle, click, undo, redo, brush, toggleErase, bigger, smaller, pause, resume, recenter, markCorner, microphoneOff }
public enum JSONValue: Codable, Sendable, Equatable {
 case object([String:JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
 public init(from decoder: any Decoder) throws {
  let c=try decoder.singleValueContainer()
  if c.decodeNil() { self = .null } else if let b=try? c.decode(Bool.self) { self = .bool(b) } else if let n=try? c.decode(Double.self), n.isFinite { self = .number(n) } else if let s=try? c.decode(String.self) { self = .string(s) } else if let a=try? c.decode([JSONValue].self) { self = .array(a) } else { self = .object(try c.decode([String:JSONValue].self)) }
 }
 public func encode(to encoder: any Encoder) throws { var c=encoder.singleValueContainer(); switch self { case .object(let v):try c.encode(v);case .array(let v):try c.encode(v);case .string(let v):try c.encode(v);case .number(let v):try c.encode(v);case .bool(let v):try c.encode(v);case .null:try c.encodeNil() } }
 public var object: [String:JSONValue]? { if case .object(let x)=self {return x};return nil }
 public var string: String? { if case .string(let x)=self {return x};return nil }
 public var number: Double? { if case .number(let x)=self {return x};return nil }
 public var bool: Bool? { if case .bool(let x)=self {return x};return nil }
 public var uint: UInt64? { guard let n=number, n >= 0, n <= 9_007_199_254_740_991, n.rounded()==n else {return nil};return UInt64(n) }
 public func decode<T: Decodable>(_ t: T.Type) throws -> T { try JSONDecoder().decode(t,from:JSONEncoder().encode(self)) }
 public static func encoded<T: Encodable>(_ value:T) -> JSONValue { (try? JSONDecoder().decode(JSONValue.self,from:JSONEncoder().encode(value))) ?? .null }
}
public struct Envelope: Codable, Sendable { public var v: Int; public var session: String; public var seq: UInt64; public var type: String; public var payload: JSONValue
 public init(session:String,seq:UInt64,type:String,payload:JSONValue) {v=1;self.session=session;self.seq=seq;self.type=type;self.payload=payload}
}
public struct WireError: Error, CustomStringConvertible { public let description:String; public init(_ s:String){description=s} }
public enum Wire {
 public static let maximumBytes = 16*1024
 public static let requestTypes: Set<String> = ["hello","configure","sample","action","ping","microphone","installSpeechAssets","restoreTarget","shutdown"]
 public static func parse(_ data:Data) throws -> Envelope {
  guard data.count <= maximumBytes, String(data:data,encoding:.utf8) != nil else {throw WireError("invalid-framing")}
  let e=try JSONDecoder().decode(Envelope.self,from:data)
  guard e.v==1, UUID(uuidString:e.session) != nil, e.seq <= 9_007_199_254_740_991, requestTypes.contains(e.type), let p=e.payload.object else {throw WireError("invalid-envelope")}
  func exact(_ fields:Set<String>) throws {guard Set(p.keys)==fields else {throw WireError("invalid-payload-fields")}}
  func uint(_ k:String)throws{guard p[k]?.uint != nil else {throw WireError("invalid-"+k)}}
  switch e.type {
  case "hello":try exact(["bundleId"]);guard p["bundleId"]?.string=="org.steady.local" else {throw WireError("bundle-id")}
  case "configure":
   try exact(["generation","targetBundleId","targetPid","displayId","canvas","excludedRects"]);try uint("generation");try uint("targetPid");try uint("displayId")
   guard p["targetBundleId"]?.string=="org.krita", let pid=p["targetPid"]?.uint,pid>0,pid<=UInt64(Int32.max),let did=p["displayId"]?.uint,did<=UInt64(UInt32.max) else {throw WireError("target")}
   if p["canvas"] != .null {guard let r=try? p["canvas"]?.decode(Rect.self),r.valid else {throw WireError("canvas")}}
   guard let rs=try? p["excludedRects"]?.decode([Rect].self),rs.count<=64,rs.allSatisfy(\.valid) else {throw WireError("excluded-rects")}
  case "sample":
   try exact(["generation","frameId","captureTimestamp","valid","position"]);try uint("generation");try uint("frameId")
   guard let t=p["captureTimestamp"]?.number,t.isFinite,t>=0,let valid=p["valid"]?.bool else {throw WireError("sample")}
   if valid {guard let point=try? p["position"]?.decode(Point.self),point.valid else {throw WireError("position")}} else if p["position"] != .null {throw WireError("invalid-position")}
  case "action":try exact(["generation","eventId","actionId"]);try uint("generation");guard let id=p["eventId"]?.string,!id.isEmpty,id.utf8.count<=128,let a=p["actionId"]?.string,ActionID(rawValue:a) != nil else {throw WireError("action")}
  case "ping":try exact(["senderTimestamp"]);guard let t=p["senderTimestamp"]?.number,t.isFinite,t>=0 else {throw WireError("timestamp")}
  case "microphone":try exact(["enabled","speechSession"]);guard p["enabled"]?.bool != nil, let s=p["speechSession"]?.string,UUID(uuidString:s) != nil else {throw WireError("microphone")}
  case "installSpeechAssets":try exact(["locale"]);guard p["locale"]?.string=="en-US" else {throw WireError("locale")}
  case "restoreTarget":try exact(["targetPid"]);guard let pid=p["targetPid"]?.uint,pid>0,pid<=UInt64(Int32.max) else{throw WireError("target-pid")}
  case "shutdown":try exact([])
  default:throw WireError("type")
  }
  return e
 }
}
/// Bounded byte framing, including incomplete lines. A protocol error invalidates the session.
public struct LineFramer: Sendable {
 private var buffer=Data(); public init(){}
 public mutating func feed(_ chunk:Data)throws->[Data] {
  var lines:[Data]=[]
  for byte in chunk {if byte==10 {lines.append(buffer);buffer.removeAll(keepingCapacity:true)} else {guard buffer.count<Wire.maximumBytes else {throw WireError("message-too-large")};buffer.append(byte)}}
  return lines
 }
 public var hasIncompleteLine:Bool{!buffer.isEmpty}
}
public func monotonicMilliseconds()->Double {Double(DispatchTime.now().uptimeNanoseconds)/1_000_000}
