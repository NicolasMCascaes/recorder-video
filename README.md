# Recorder Video

Recorder Video is a Windows-first screen recorder focused on clarity. It captures the screen with cursor-free raw video, tracks mouse movement and clicks with a native sidecar, and renders a polished export with smart zoom around attention moments. The goal is to deliver a clean, professional recording without forcing you into a heavyweight editor.

It ships as a desktop app and keeps project data organized: raw capture + a timeline of cursor events + export presets. Every visible control in the UI is wired to real behavior, so the product is always functional, even while features are still evolving.

## Stack

<p>
	<img alt="Electron" src="https://cdn.simpleicons.org/electron/47848F" width="28" height="28" />
	<img alt="React" src="https://cdn.simpleicons.org/react/61DAFB" width="28" height="28" />
	<img alt="TypeScript" src="https://cdn.simpleicons.org/typescript/3178C6" width="28" height="28" />
	<img alt="Rust" src="https://cdn.simpleicons.org/rust/000000" width="28" height="28" />
	<img alt="FFmpeg" src="https://cdn.simpleicons.org/ffmpeg/007808" width="28" height="28" />
</p>

- Electron provides the Windows desktop shell and native windowing.
- React and TypeScript power the full editing and preview experience.
- Rust handles native capture tasks and cursor event tracking.
- FFmpeg drives the initial export pipeline.

## What It Does

- Records display video while suppressing the native cursor.
- Captures mouse movement and clicks in a high-resolution timeline.
- Creates automatic or manual zoom segments around moments of interest.
- Renders an export with a custom cursor, background, and framing.
- Keeps projects and exports organized under the Videos folder.

## How It Works

1. The desktop app coordinates capture and stores a project directory.
2. The Rust sidecar emits cursor events as JSON lines.
3. The renderer previews edits and produces a render stream.
4. FFmpeg encodes the final MP4 with a chosen preset.

Projects store raw media and editing metadata separately:

- `capture.webm` or `capture.mp4`: raw recording
- `timeline.json`: cursor events and zoom instructions
- `assets/`: derived assets such as thumbnails

## Product Principles

- Every visible UI control triggers real behavior.
- Focus on clean capture, clear motion, and fast export.
- Keep the experience Windows-native and reliable.

## Commands

```powershell
pnpm install
pnpm dev
pnpm check
```

## Structure

```text
apps/desktop           Electron + React desktop app
crates/recorder-core   Rust capture and cursor sidecar
docs                   Product architecture and roadmap
```
