# Performance and cleanup review

Completed 2026-10-25. All 19 remaining findings from the review were addressed. Existing first-pass fixes remain in place.

## Changes by finding

| Finding | Resolution |
|---|---|
| 1. Voice key changes bypassed activation/instance protection | Key changes cannot start disabled or inactive voice; repeated startup is idempotent. |
| 2. PID-file acquisition raced | Removed the PID lock. Electron now holds its OS-backed application lock for each profile until process exit. A second instance exits before initialization. |
| 3. Advanced settings missed voice updates | Advanced settings now receives the same live voice broadcasts as the panel and Settings. |
| 4. Listening appeared before capture opened | Shared snapshots carry actual capture state; switches reflect it and pending capture displays “Starting microphone…”. Late open reports cannot reactivate a muted microphone. |
| 5. Diagnostic file operations blocked main | Voice, tracking and probe logs use bounded asynchronous batching and rotation. Shutdown flushes logs after stopping producers. Each logger retains at most two 1 MB files and bounds its pending queue to 1 MB. |
| 6. Claude key lookup blocked main | Keychain lookup now uses asynchronous process execution, and concurrent first requests share initialization. |
| 7. Full status snapshots repeated for every sample | Routine native telemetry is coalesced over 100 ms. State, reason, button, generation, foreground and permission changes publish immediately. Diagnostics are cloned only when revised and omitted from auxiliary canvas/preview broadcasts. |
| 8. Camera reports rerendered at inference frequency | Routine reports are limited to 10 Hz; changed rejection/edge/continuity state remains immediate. Every inference sample still reaches mapping. |
| 9. Preview JPEG work repeated at camera rate | Preview encoding is capped at 15 fps before downscaling/encoding; tracking and pointer sample rates are independent. |
| 10. AudioWorklet allocated scratch arrays in every block | Downmixing and resampling reuse scratch storage across blocks, including fractional resampling continuity. Only transferred output frames need replacement. |
| 11. Voice models loaded while muted | The inference worker is created on first microphone activation. It remains available for subsequent activations. |
| 12. Audio WebSocket writes ignored congestion | More than two seconds of queued audio fails and terminates the utterance; further writes are rejected. Synchronous send failures also become session errors. |
| 13. Concurrent self-tests replaced each other's tap | Requests share one in-flight measurement; capture/runtime changes invalidate its result. |
| 14. Dispatch latency omitted executor wait | Final-to-dispatch timing is recorded when execution begins, including time waiting behind earlier commands. |
| 15. Disabled Apple speech still did work | Removed the native recognizer, assembler, diagnostic timer, recorder, dispatch handlers and obsolete scoring script. Protocol-v1 rejection codes and microphone-disable requests remain compatible. Native speech permission reports `unused`. |
| 16. Failed test-server binds waited for timeouts | Voice integration setup now rejects immediately on server errors. |
| 17. Voice asset verification repeated hashing/copying | Model verification streams hashes once per unchanged file. Content, permissions and file lists are compared before staging the native addon; matching staging is preserved, and corrupt/stale trees are replaced. |
| 18. Whitespace environment keys disagreed with Settings | Source detection and retrieval now share trimmed environment-key semantics. |
| 19. Stale text and unused interfaces remained | Updated voice/configuration/permission documentation and microphone-test wording; removed unused RMS and capture-state interfaces and Apple speech permission text. |

The first pass also removed retired rest/lift gesture controls and calculations, the unused libfvad import, unused TypeScript declarations, repeated audio-backlog copies, excessive percentile sorting, preview canvas resets, and stale-callback/resource leaks. Existing gesture settings remain readable for settings-v1 compatibility. Asset integrity checks now stream model files. Release builds use SwiftPM's default backend without the deprecated native-backend flag; packaged helpers omit debug information and dSYM generation.

## Measurements

A synthetic AudioWorklet run compared the original `eda914ea` worklet with the revised implementation using 60 seconds of stereo input in 128-sample blocks. Results are medians of five runs after one warmup, using Node's VM and a stub output port.

| Input rate | Scratch-array allocations before / after | CPU time before / after |
|---|---:|---:|
| 16 kHz | 7,500 / 0 | 114.6 / 114.2 ms |
| 48 kHz | 67,500 / 0 | 184.2 / 174.1 ms |

These measurements isolate audio processing; they do not measure microphone hardware, scheduling jitter, IPC, network latency, or perceived drawing latency. Streaming waveform tests cover mono-rate output, 44.1/48 kHz resampling, stereo downmixing, irregular block sizes and continuity to within one int16 quantization step.

Deterministic camera tests process all 30 inference samples over roughly one second while emitting 9–11 routine UI reports; a changed rejection publishes immediately. Packaged tests verify that 30 routine native updates coalesce and a fault transition publishes synchronously. Preview tests verify that intermediate camera frames are skipped before draw/encode.

## Validation

- Strict TypeScript checking, including unused locals and parameters.
- 346 TypeScript tests across 45 files, including real local keyword/VAD inference against a fake Cartesia server.
- 79 native tests and eight process checks using fake desktop input. Five obsolete native speech tests were removed with their retired implementation.
- SHA-256 asset verification and repeated addon verification without restaging unchanged files.
- Signed arm64 macOS package build.
- Six packaged-app tests covering drawing setup, global bindings, bundled offline inference, exclusions, single-instance ownership, live Advanced voice controls and telemetry coalescing.

A final rerun also identified a sleeping-display dependency in the fake test harness: fake system-display tests now use online display geometry, while real-input enumeration still requires active displays.

Packaged tests use fake desktop input and media. Physical camera/microphone quality, real network service behavior and drawing in a live Krita document still require operator validation.
