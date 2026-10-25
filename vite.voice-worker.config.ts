import { defineConfig } from 'vite';
// Voice inference thread (local command words + VAD); loads sherpa-onnx-node from node_modules (dev) or resources/voice/addon (packaged).
export default defineConfig({ build: { lib: { entry: 'src/main/voice/inference-worker.ts', formats: ['cjs'], fileName: () => 'voice-worker.cjs' }, rollupOptions: { external: ['electron', /^node:/, 'sherpa-onnx-node'] } } });
