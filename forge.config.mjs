import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerZIP } from '@electron-forge/maker-zip';
export default {
  packagerConfig: {
    name: 'Steady', executableName: 'Steady', appBundleId: 'org.steady.local', icon: 'resources/icon/statheros',
    appVersion: '0.1.0', asar: true, osxSign: { identity: '-', identityValidation: false, preAutoEntitlements: false, continueOnError: false, optionsForFile: () => ({ hardenedRuntime: false }) },
    extraResource: ['resources/bin', 'resources/assets', 'resources/asset-manifest.json', 'resources/voice'],
    extendInfo: {
      LSMinimumSystemVersion: '26.0', LSUIElement: true,
      NSCameraUsageDescription: 'Steady uses your selected camera for local head or palm tracking.',
      NSMicrophoneUsageDescription: 'Steady listens locally for its wake phrase and, only while the red dot shows, streams your spoken command to Cartesia for transcription.',
      NSSpeechRecognitionUsageDescription: 'Steady recognizes local en-US drawing commands.',
      NSAccessibilityUsageDescription: 'Steady posts pointer and key events to Krita when explicitly enabled.'
    }
  },
  makers: [new MakerZIP({}, ['darwin'])],
  plugins: [new VitePlugin({
    build: [
      { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
      { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      { entry: 'src/main/voice/inference-worker.ts', config: 'vite.voice-worker.config.ts', target: 'main' }
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }]
  })]
};
