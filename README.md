# Recorder Video

Windows screen recorder with automatic zoom around mouse movement and clicks.

## Stack

- Electron for the Windows desktop shell.
- React and TypeScript for the app UI.
- Rust for the native recording engine.
- FFmpeg for the first export pipeline.

## Commands

```powershell
pnpm install
pnpm dev
pnpm check
```

## Structure

```text
apps/desktop           Electron and React app
crates/recorder-core   Native Rust engine
docs                   Architecture and roadmap
```
