import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
// Node resolution (ws ships a browser stub). ws's optional native accelerators are never installed;
// the native voice addon loads from resources at runtime.
export default defineConfig({
  resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext', 'main'] },
  build: { lib: { entry: 'src/main/index.ts', formats: ['cjs'], fileName: () => 'main.cjs' }, rollupOptions: { external: ['electron', /^node:/, ...builtinModules, 'bufferutil', 'utf-8-validate', 'sherpa-onnx-node'] } },
});
