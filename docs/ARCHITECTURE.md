# Architecture

Recorder Video is split into three layers:

1. Desktop shell: Electron main process, preload bridge, and IPC contracts.
2. Renderer: React UI for recording, preview, timeline, settings, and export controls.
3. Native engine: Rust sidecar for Windows capture, mouse events, cursor timeline, and render/export helpers.

## Desktop App

Path: `apps/desktop`

- `src/main`: Electron lifecycle, windows, native process orchestration, IPC handlers.
- `src/preload`: Safe bridge exposed to the renderer.
- `src/shared`: Shared IPC names and types.
- `src/renderer`: React application.

## Native Engine

Path: `crates/recorder-core`

Initial responsibility:

- Report health and environment.
- Capture mouse movement and left/right clicks through Win32 polling.
- Later: coordinate screen capture and frame/timeline metadata.
- Later: drive export jobs with FFmpeg or native encoders.

## Recording Model

The product should store raw media and editing metadata separately:

- `capture.webm` or `capture.mp4`: base screen recording.
- `timeline.json`: mouse positions, clicks, zoom segments, edits, and export settings.
- `assets/`: cursor overlays, audio stems, thumbnails, and generated preview frames.

Export renders the base recording plus timeline instructions into a final MP4.

## IPC Boundary

The renderer never calls Node APIs directly. It talks through `window.recorderApi`.

Current channels:

- `app:get-version`
- `recorder:get-environment`
- `recorder:list-sources`
- `recorder:start`
- `recorder:append-chunk`
- `recorder:stop`
- `project:open`
- `export:start`
- `export:append-chunk`
- `export:finish`
- `export:progress`

The first MVP records display video with Electron `MediaRecorder`, records cursor events with the Rust sidecar, renders zoom/cursor overlays from the renderer canvas, and lets the main process convert the rendered WebM to MP4 through FFmpeg.
