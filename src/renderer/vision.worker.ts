/// <reference lib="webworker" />
import { FaceLandmarker, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { Mode } from '../shared/contracts';
import { extractAnchor, initializeDelegate } from './tracking';

type InitMessage = { type: 'initialize'; mode: Mode; assetRoot: string };
type FrameMessage = { type: 'frame'; frameId: number; generation: number; captureTimestamp: number; bitmap: ImageBitmap };
/** Forehead, chin, cheeks, nose tip, eye and mouth corners (Face Mesh indices). */
const FACE_OUTLINE = [10, 152, 234, 454, 1, 33, 133, 362, 263, 61, 291];
let detector: FaceLandmarker | HandLandmarker | null = null;
let mode: Mode = 'head';
let failed = false;
let initializing = false;
self.onmessage = async (event: MessageEvent<InitMessage | FrameMessage>) => {
  const message = event.data;
  if (message.type === 'initialize') {
    if (initializing || detector) return;
    initializing = true;
    mode = message.mode;
    try {
      // Module workers must use the package's ESM loader. Its classic loader only
      // declares a module-local factory when dynamically imported.
      const files = await FilesetResolver.forVisionTasks(new URL('wasm/', message.assetRoot).href, true);
      const runtime = await import(/* @vite-ignore */ files.wasmLoaderPath);
      if (typeof runtime.default !== 'function') throw new Error('Bundled WASM module factory is missing');
      const initialized = await initializeDelegate(async delegate => {
        // Tasks Vision clears this global after constructing a runtime. Restore
        // the exported factory for the single CPU retry; ESM imports are cached.
        (self as unknown as { ModuleFactory: unknown }).ModuleFactory = runtime.default;
        const baseOptions = { modelAssetPath: new URL(mode === 'head' ? 'face_landmarker.task' : 'hand_landmarker.task', message.assetRoot).href, delegate };
        return mode === 'head'
          ? FaceLandmarker.createFromOptions(files, { baseOptions, runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.6, minFacePresenceConfidence: 0.6, minTrackingConfidence: 0.6 })
          : HandLandmarker.createFromOptions(files, { baseOptions, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.6 });
      });
      detector = initialized.detector;
      self.postMessage({ type: 'ready', delegate: initialized.delegate });
    } catch (error) { failed = true; self.postMessage({ type: 'fault', message: `Model initialization failed: ${String(error)}` }); }
    return;
  }
  if (!detector || failed) { message.bitmap.close(); return; }
  try {
    const result = detector.detectForVideo(message.bitmap, message.captureTimestamp);
    const landmarks = 'faceLandmarks' in result ? result.faceLandmarks : result.landmarks;
    const anchor = extractAnchor(mode, landmarks);
    const handedness = 'handedness' in result ? result.handedness : [];
    const label = handedness.length === 1 ? handedness[0]?.[0]?.categoryName : null;
    const selectedHand = label === 'Left' || label === 'Right' ? label : null;
    // Display-only landmarks for the preview overlay: every hand point, or a face outline subset.
    const first = landmarks[0] ?? [];
    const overlay = (mode === 'head' ? FACE_OUTLINE.map(index => first[index]) : first).filter(Boolean).map(point => ({ x: point!.x, y: point!.y }));
    self.postMessage({ type: 'sample', sample: { generation: message.generation, frameId: message.frameId, captureTimestamp: message.captureTimestamp, mode, valid: anchor.valid, anchor: anchor.anchor, qualityReason: anchor.reason, selectedHand }, landmarks: overlay });
  } catch (error) {
    failed = true;
    self.postMessage({ type: 'fault', message: `Inference failed; restart the probe explicitly: ${String(error)}` });
  } finally { message.bitmap.close(); }
};
