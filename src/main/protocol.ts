import { ACTIONS, MAX_MESSAGE_BYTES, type Envelope, type NativeState, type Reply, type Rect, type Point, type Request } from '../shared/contracts';
export const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const uint = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export const point = (x: unknown): x is Point => isObject(x) && finite(x.x) && finite(x.y);
export const rect = (x: unknown): x is Rect => point(x) && isObject(x) && finite(x.width) && x.width > 0 && finite(x.height) && x.height > 0 && finite(x.x+x.width) && finite(x.y+x.height);
export const uuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export function envelope(x: unknown): x is Envelope {
  return isObject(x) && x.v === 1 && uuid(x.session) && uint(x.seq) && typeof x.type === 'string' && isObject(x.payload);
}
export function validRequest(x: unknown): x is Request {
  if (!envelope(x)) return false;
  const p = x.payload;
  const fields: Record<string,string[]> = {hello:['bundleId'],configure:['generation','targetBundleId','targetPid','displayId','canvas','excludedRects'],sample:['generation','frameId','captureTimestamp','valid','position'],action:['generation','eventId','actionId'],ping:['senderTimestamp'],restoreTarget:['targetPid'],microphone:['enabled','speechSession'],installSpeechAssets:['locale'],shutdown:[]};
  const expected=fields[x.type];if(!expected||Object.keys(p).length!==expected.length||expected.some(k=>!(k in p)))return false;
  switch (x.type) {
    case 'hello': return p.bundleId === 'org.steady.local';
    case 'configure': return uint(p.generation) && p.targetBundleId === 'org.krita' && uint(p.targetPid) && p.targetPid>0 && p.targetPid<=2147483647 && uint(p.displayId) && p.displayId<=4294967295 && (p.canvas === null || rect(p.canvas)) && Array.isArray(p.excludedRects) && p.excludedRects.length<=64 && p.excludedRects.every(rect);
    case 'sample': return uint(p.generation) && uint(p.frameId) && finite(p.captureTimestamp) && p.captureTimestamp >= 0 && typeof p.valid === 'boolean' && (p.valid ? point(p.position) : p.position === null);
    case 'action': return uint(p.generation) && typeof p.eventId === 'string' && p.eventId.length > 0 && Buffer.byteLength(p.eventId)<=128 && ACTIONS.includes(p.actionId as never);
    case 'ping': return finite(p.senderTimestamp) && p.senderTimestamp >= 0;
    case 'restoreTarget': return uint(p.targetPid) && p.targetPid > 0 && p.targetPid <= 2147483647;
    case 'microphone': return typeof p.enabled === 'boolean' && uuid(p.speechSession);
    case 'installSpeechAssets': return p.locale === 'en-US';
    case 'shutdown': return Object.keys(p).length === 0;
    default: return false;
  }
}
function nativeState(x: unknown): x is NativeState {
  return isObject(x) && ['lastReleaseTimestamp','lastValidCaptureTimestamp'].every(k=>x[k]===undefined||x[k]===null||(finite(x[k])&&x[k]>=0)) && ['SETUP','PAUSED','HOVER','DRAWING','FAULT'].includes(x.state as string) && typeof x.reason === 'string' && typeof x.buttonDown === 'boolean' && (x.foregroundTarget === null || typeof x.foregroundTarget === 'string') && uint(x.generation) && (x.latestValidFrame === null || uint(x.latestValidFrame)) && isObject(x.permissions) && typeof x.permissions.accessibility === 'boolean' && ['camera','microphone','speech'].every(k => typeof (x.permissions as Record<string, unknown>)[k] === 'string');
}
function canvasRect(value: unknown): value is Rect {
  return rect(value) && Object.keys(value).length === 4 && Object.keys(value).every(key => ['x','y','width','height'].includes(key));
}
function canvasDiagnostics(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value) || Object.keys(value).some(key => !['inspected','complete','truncated','nodes','windowSource'].includes(key)) ||
    !uint(value.inspected) || value.inspected > 4096 || typeof value.complete !== 'boolean' || typeof value.truncated !== 'boolean' ||
    !['ax','window-server','none'].includes(value.windowSource as string) || !Array.isArray(value.nodes) || value.nodes.length > 32) return false;
  return value.nodes.every(node => isObject(node) && Object.keys(node).length === 6 && Object.keys(node).every(key => ['path','role','subrole','identifier','bounds','childCount'].includes(key)) &&
    typeof node.path === 'string' && node.path.length <= 80 && /^[0-9]+(?:\/[0-9]+)*$/.test(node.path) &&
    typeof node.role === 'string' && /^AX[A-Za-z0-9]{0,62}$/.test(node.role) &&
    typeof node.subrole === 'string' && (node.subrole === '' || /^AX[A-Za-z0-9]{0,62}$/.test(node.subrole)) &&
    (node.identifier === null || (typeof node.identifier === 'string' && /^(?:qt_[A-Za-z0-9_]{1,60}|kis[A-Za-z0-9_]{1,60}|view_[0-9]{1,12}|canvas(?:Widget|Frame|Controller|View)?|centralWidget|scrollArea|viewport)$/i.test(node.identifier))) &&
    (node.bounds === null || canvasRect(node.bounds)) && uint(node.childCount) && node.childCount <= 4096);
}
export function validReply(x: unknown): x is Reply {
  if (!envelope(x)) return false;
  const p = x.payload;
  switch (x.type) {
    case 'ack': return uint(p.requestSeq) && typeof p.accepted === 'boolean' && typeof p.code === 'string' && nativeState(p.state) && (p.nativeTimestamp === null || finite(p.nativeTimestamp)) && (p.protocolVersion===undefined||p.protocolVersion===1) && (p.displays===undefined||(Array.isArray(p.displays)&&p.displays.every(display=>isObject(display)&&uint(display.id)&&rect(display.bounds)&&rect(display.workArea)&&typeof display.builtIn==='boolean'&&typeof display.primary==='boolean'&&finite(display.scaleFactor)&&display.scaleFactor>0))) && (p.capabilities===undefined||(Array.isArray(p.capabilities)&&p.capabilities.every(item=>typeof item==='string'))) && (p.senderTimestamp===undefined||finite(p.senderTimestamp)) && (p.targetPid===undefined||p.targetPid===null||(uint(p.targetPid)&&p.targetPid>0&&p.targetPid<=2147483647));
    case 'state': return nativeState(p);
    case 'canvasObservation': return Object.keys(p).length === 13 && Object.keys(p).every(key => ['generation','targetPid','windowId','windowBounds','windowToken','layoutToken','diagnostics','workspaceSuggestion','rect','kind','availability','reason','observedAt'].includes(key)) &&
      uint(p.generation) && (p.targetPid === null || (uint(p.targetPid) && p.targetPid > 0 && p.targetPid <= 2147483647)) &&
      canvasDiagnostics(p.diagnostics) &&
      ['windowId', 'windowToken', 'layoutToken'].every(key => p[key] === null || (typeof p[key] === 'string' && (p[key] as string).length > 0 && (p[key] as string).length <= 256)) && (p.windowBounds === null || canvasRect(p.windowBounds)) &&
      (p.workspaceSuggestion === null || (canvasRect(p.workspaceSuggestion) && canvasRect(p.windowBounds) && p.workspaceSuggestion.width >= 100 && p.workspaceSuggestion.height >= 100 &&
        p.workspaceSuggestion.x >= p.windowBounds.x && p.workspaceSuggestion.y >= p.windowBounds.y &&
        p.workspaceSuggestion.x + p.workspaceSuggestion.width <= p.windowBounds.x + p.windowBounds.width && p.workspaceSuggestion.y + p.workspaceSuggestion.height <= p.windowBounds.y + p.windowBounds.height)) &&
      typeof p.reason === 'string' && p.reason.length <= 2048 && finite(p.observedAt) && p.observedAt >= 0 &&
      (p.availability === 'available' ? canvasRect(p.rect) && ['document', 'viewport'].includes(p.kind as string) && p.targetPid !== null && p.windowId !== null && p.layoutToken !== null :
        p.availability === 'unavailable' && p.rect === null && p.kind === null);
    case 'fault': return typeof p.code === 'string' && typeof p.message === 'string';
    case 'speech': return uuid(p.speechSession) && uint(p.utterance) && (p.actionId === null || ACTIONS.includes(p.actionId as never)) && finite(p.speechEndTimestamp) && p.speechEndTimestamp>=0 && finite(p.acceptedTimestamp) && p.acceptedTimestamp>=p.speechEndTimestamp && p.final === true && typeof p.reason === 'string';
    default: return false;
  }
}

/** Byte framing preserves split UTF-8 and imposes a bound before JSON parsing. */
export class LineDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const index = this.buffer.indexOf(10);
      if (index < 0) { if (this.buffer.length > MAX_MESSAGE_BYTES) throw new Error('oversized frame'); break; }
      if (index > MAX_MESSAGE_BYTES) throw new Error('oversized frame');
      const line = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1);
      if (!line.length) throw new Error('empty frame');
      messages.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
    }
    return messages;
  }
}

export class ClockSync {
  offset = 0; uncertainty = Infinity; synchronizedAt = -Infinity;
  choose(roundTrips: { sent: number; received: number; native: number }[], now: number): void {
    if (roundTrips.length !== 8) throw new Error('eight clock probes required');
    const samples = roundTrips.filter(s => [s.sent,s.received,s.native].every(Number.isFinite) && s.received >= s.sent);
    if (samples.length !== 8) throw new Error('invalid clock probe');
    const best = samples.reduce((a,b) => a.received-a.sent <= b.received-b.sent ? a : b);
    this.uncertainty = (best.received-best.sent)/2;
    this.offset = best.native-(best.sent+best.received)/2;
    this.synchronizedAt = now;
  }
  convert(timestamp: number, now: number): number {
    if (!finite(timestamp) || this.uncertainty > 10 || now-this.synchronizedAt > 30_000) throw new Error('clock synchronization required');
    return timestamp + this.offset;
  }
}
