import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  protocol,
  screen,
  session,
  shell
} from "electron";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  IPC_CHANNELS,
  type AppSettings,
  type AudioInputDevice,
  type CancelCapturePickerRequest,
  type CancelExportRequest,
  type CaptureTargetKind,
  type CaptureEngine,
  type CapturePickerState,
  type CaptureSelection,
  type CaptureSelectionUi,
  type CaptureSource,
  type CursorSuppression,
  type CursorEvent,
  type CompleteCapturePickerRequest,
  type ExportJob,
  type ExportPreset,
  type ManualZoomSegment,
  type OpenedProject,
  type OpenExportFileRequest,
  type OpenExportFolderRequest,
  type PauseRecordingRequest,
  type PickCaptureTargetRequest,
  type PickExportOutputPathRequest,
  type PickExportOutputPathResult,
  type ProjectAppearanceEdit,
  type ProjectEdit,
  type ProjectExportEntry,
  type ProjectExportId,
  type ProjectExportRecord,
  type ProjectManifest,
  type ProjectMotionEdit,
  type Rect,
  type RecordingAudioOptions,
  type RecordingSegmentSummary,
  type ProjectSummary,
  type RecorderEnvironment,
  type RecordingSession,
  type ResumeRecordingRequest,
  type StartRecordingRequest,
  type StartExportRequest,
  type Timeline
} from "../shared/ipc";

const MEDIA_PROTOCOL = "recorder-media";
const currentDir = __dirname;
const activeRecordings = new Map<string, ActiveRecording>();
const activeExportJobs = new Map<string, ActiveExportJob>();
const EXPORT_PRESETS: ExportPreset[] = ["high-quality", "balanced", "small-file"];
let mainWindow: BrowserWindow | null = null;
let capturePickerWindow: BrowserWindow | null = null;
let activeCapturePicker: ActiveCapturePicker | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

type ActiveRecording = {
  session: RecordingSession;
  selection: CaptureSelection;
  source: CaptureSource;
  targetKind: CaptureTargetKind;
  captureEngine: CaptureEngine;
  cursorSuppression: CursorSuppression;
  selectionUi: CaptureSelectionUi;
  projectDir: string;
  capturePath: string;
  rawCapturePath?: string;
  timelinePath: string;
  timelineRawPath: string;
  manifestPath: string;
  captureStream?: ReturnType<typeof createWriteStream>;
  timelineStream: ReturnType<typeof createWriteStream>;
  cursorEvents: CursorEvent[];
  sidecar: ChildProcess;
  ffmpegCapture?: ActiveFfmpegCapture;
  intervals: RecordingInterval[];
  audio: RecordingAudioOptions;
  fps: number;
  quality: number;
  captureBounds: Rect;
  region?: Rect;
  windowHandle?: string;
  state: "recording" | "paused";
  startedAtMs: number;
  mediaStartedAtMs?: number;
  cursorClockBaseMs?: number;
};

type RecordingInterval = {
  startedAtMs: number;
  endedAtMs?: number;
  segmentPath?: string;
};

type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ActiveFfmpegCapture = {
  process: ChildProcess;
  exit: Promise<ProcessExit>;
  stderr: string[];
  startedAtMs: number;
  segmentPath: string;
};

type ActiveExportJob = {
  job: ExportJob;
  projectDir: string;
  renderPath: string;
  tempOutputPath: string;
  renderStream: ReturnType<typeof createWriteStream>;
  durationMs: number;
  renderStreamClosed: boolean;
  ffmpegProcess?: ChildProcess;
  cancelledAt?: string;
};

type ActiveCapturePicker = {
  requestId: string;
  targetKind: CaptureTargetKind;
  sources: CaptureSource[];
  virtualBounds: Rect;
  restoreMainWindow: boolean;
  resolve: (selection: CaptureSelection | null) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

function writeToStream(
  stream: ReturnType<typeof createWriteStream>,
  buffer: Buffer
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function endStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
    stream.end();
  });
}

function bufferFromChunk(chunk: ArrayBuffer): Buffer {
  return Buffer.from(new Uint8Array(chunk));
}

function getProjectRoot(): string {
  return join(process.cwd(), "..", "..");
}

function getRecorderCoreManifestPath(): string {
  return join(getProjectRoot(), "crates", "recorder-core", "Cargo.toml");
}

function createSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function getProjectsRoot(): string {
  try {
    return join(app.getPath("videos"), "Recorder Video");
  } catch {
    return join(homedir(), "Videos", "Recorder Video");
  }
}

function getSettingsPath(): string {
  return join(getProjectsRoot(), "settings.json");
}

function getDefaultExportDirectory(): string {
  return join(getProjectsRoot(), "Exports");
}

function getDefaultAppSettings(): AppSettings {
  return {
    playbackRate: 1,
    loopPreview: false,
    showCursor: true,
    fps: 60,
    quality: 82,
    zoomPercent: 165,
    smoothness: 68,
    defaultExportDirectory: getDefaultExportDirectory()
  };
}

function toRelativeFile(projectDir: string, filePath: string): string {
  return relative(projectDir, filePath).replace(/\\/g, "/");
}

function resolveProjectFilePath(projectDir: string, filePath: string): string {
  return isAbsolute(filePath) ? resolve(filePath) : resolve(projectDir, filePath);
}

function toMediaUrl(filePath: string): string {
  return `${MEDIA_PROTOCOL}://local/${encodeURIComponent(resolve(filePath))}`;
}

function fromMediaUrl(urlString: string): string {
  const url = new URL(urlString);

  if (url.protocol !== `${MEDIA_PROTOCOL}:` || url.hostname !== "local") {
    throw new Error("Invalid media URL.");
  }

  return decodeURIComponent(url.pathname.slice(1));
}

function isAllowedMediaPath(filePath: string): boolean {
  const projectsRoot = resolve(getProjectsRoot()).toLowerCase();
  const resolvedPath = resolve(filePath).toLowerCase();

  return resolvedPath === projectsRoot || resolvedPath.startsWith(`${projectsRoot}\\`);
}

function getMediaContentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

function ensureAllowedProjectPath(filePath: string): void {
  if (!isAllowedMediaPath(filePath)) {
    throw new Error("Path is outside the Recorder Video project directory.");
  }
}

function isExportPreset(value: unknown): value is ExportPreset {
  return value === "high-quality" || value === "balanced" || value === "small-file";
}

function isProjectExportId(value: unknown): value is ProjectExportId {
  return value === "legacy" || isExportPreset(value);
}

function normalizeProjectExportRecord(projectDir: string, record: ProjectExportRecord): ProjectExportRecord {
  const id = isProjectExportId(record.id) ? record.id : isProjectExportId(record.preset) ? record.preset : "legacy";
  const preset = isProjectExportId(record.preset) ? record.preset : id;

  return {
    id,
    preset,
    outputPath: resolveProjectFilePath(projectDir, record.outputPath),
    lastExportedAt: typeof record.lastExportedAt === "string" ? record.lastExportedAt : undefined
  };
}

function getLegacyExportRecord(projectDir: string, manifest: ProjectManifest): ProjectExportRecord | null {
  const legacyOutputPath = resolveProjectFilePath(projectDir, manifest.files.export);

  if (!existsSync(legacyOutputPath)) {
    return null;
  }

  return {
    id: "legacy",
    preset: "legacy",
    outputPath: legacyOutputPath,
    lastExportedAt: manifest.createdAt
  };
}

function normalizeProjectExportRecords(projectDir: string, manifest: ProjectManifest): ProjectExportRecord[] {
  const records = Array.isArray(manifest.exports)
    ? manifest.exports.map((record) => normalizeProjectExportRecord(projectDir, record))
    : [];
  const deduped = new Map<ProjectExportId, ProjectExportRecord>();

  for (const record of records) {
    deduped.set(record.id, record);
  }

  const legacyRecord = getLegacyExportRecord(projectDir, manifest);

  if (legacyRecord && !deduped.has("legacy")) {
    deduped.set("legacy", legacyRecord);
  }

  return [...deduped.values()].sort((left, right) => {
    const leftTime = left.lastExportedAt ?? "";
    const rightTime = right.lastExportedAt ?? "";

    return rightTime.localeCompare(leftTime);
  });
}

function toProjectExportEntry(record: ProjectExportRecord): ProjectExportEntry {
  const exists = existsSync(record.outputPath);

  return {
    ...record,
    directory: dirname(record.outputPath),
    exists,
    fileName: basename(record.outputPath),
    isLegacy: record.id === "legacy",
    outputUrl: exists && isAllowedMediaPath(record.outputPath) ? toMediaUrl(record.outputPath) : undefined
  };
}

function getProjectExportEntries(projectDir: string, manifest: ProjectManifest): ProjectExportEntry[] {
  return normalizeProjectExportRecords(projectDir, manifest).map((record) => toProjectExportEntry(record));
}

function getLatestExistingExport(exports: ProjectExportEntry[]): ProjectExportEntry | undefined {
  return exports
    .filter((entry) => entry.exists)
    .sort((left, right) => (right.lastExportedAt ?? "").localeCompare(left.lastExportedAt ?? ""))[0];
}

function sanitizeFileSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return safe || "recording";
}

function getDefaultExportFileName(project: OpenedProject, preset: ExportPreset): string {
  return `${sanitizeFileSegment(project.manifest.source.name)}-${project.manifest.id}-${preset}.mp4`;
}

function getExportRecordForPreset(project: OpenedProject, preset: ExportPreset): ProjectExportEntry | undefined {
  return project.exports.find((record) => record.id === preset);
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitExportProgress(job: ExportJob): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.exportProgress, job);
  }
}

async function loadRendererWindow(window: BrowserWindow, searchParams?: URLSearchParams): Promise<void> {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    const url = new URL(rendererUrl);

    if (searchParams) {
      for (const [key, value] of searchParams.entries()) {
        url.searchParams.set(key, value);
      }
    }

    await window.loadURL(url.toString());
    return;
  }

  const indexPath = join(currentDir, "../renderer/index.html");

  if (searchParams) {
    const fileUrl = pathToFileURL(indexPath);

    fileUrl.search = searchParams.toString();
    await window.loadURL(fileUrl.toString());
    return;
  }

  await window.loadFile(indexPath);
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: "Recorder Video",
    autoHideMenuBar: true,
    backgroundColor: "#101316",
    webPreferences: {
      preload: join(currentDir, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow = window;
  window.once("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  void loadRendererWindow(window);
}

function getVirtualDesktopBoundsFromDisplays(): Rect {
  const displays = screen.getAllDisplays();

  if (!displays.length) {
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }

  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

async function getVirtualDesktopBounds(): Promise<Rect> {
  if (process.platform !== "win32") {
    return getVirtualDesktopBoundsFromDisplays();
  }

  try {
    const result = await runRecorderCoreCommand("virtual-screen-bounds", []);

    return {
      x: Number(result.x),
      y: Number(result.y),
      width: Number(result.width),
      height: Number(result.height)
    };
  } catch (error) {
    console.warn(`[capture] Could not resolve virtual desktop bounds natively: ${toErrorText(error)}`);
    return getVirtualDesktopBoundsFromDisplays();
  }
}

function createCapturePickerWindow(bounds: Rect): BrowserWindow {
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(currentDir, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.setAlwaysOnTop(true, "screen-saver");
  window.setContentProtection(true);
  window.setMenuBarVisibility(false);
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  window.on("closed", () => {
    if (!activeCapturePicker?.settled) {
      settleCapturePicker(null);
    }
  });

  capturePickerWindow = window;

  return window;
}

function restoreMainWindowAfterCapturePicker(shouldRestore: boolean): void {
  if (!shouldRestore || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function settleCapturePicker(selection: CaptureSelection | null, error?: Error): void {
  const activePicker = activeCapturePicker;

  if (!activePicker || activePicker.settled) {
    return;
  }

  activePicker.settled = true;
  activeCapturePicker = null;

  const pickerWindow = capturePickerWindow;

  capturePickerWindow = null;
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.close();
  }

  restoreMainWindowAfterCapturePicker(activePicker.restoreMainWindow);

  if (error) {
    activePicker.reject(error);
    return;
  }

  activePicker.resolve(selection);
}

async function pickCaptureTarget(request: PickCaptureTargetRequest): Promise<CaptureSelection | null> {
  if (activeCapturePicker) {
    throw new Error("A capture picker is already open.");
  }

  const sources = await listCaptureSourcesForPicker(request.targetKind);

  if (!sources.length) {
    throw new Error(`No ${request.targetKind} capture source is currently available.`);
  }

  const virtualBounds = await getVirtualDesktopBounds();
  const restoreMainWindow = Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized());
  const requestId = randomUUID();
  const pickerWindow = createCapturePickerWindow(virtualBounds);

  if (restoreMainWindow) {
    mainWindow?.minimize();
  }

  const result = new Promise<CaptureSelection | null>((resolve, reject) => {
    activeCapturePicker = {
      requestId,
      targetKind: request.targetKind,
      sources,
      virtualBounds,
      restoreMainWindow,
      resolve,
      reject,
      settled: false
    };
  });

  void loadRendererWindow(pickerWindow, new URLSearchParams([["overlay", "capture-picker"]]));

  return result;
}

function getActiveCapturePickerState(): CapturePickerState {
  if (!activeCapturePicker) {
    throw new Error("Capture picker is not active.");
  }

  return {
    requestId: activeCapturePicker.requestId,
    targetKind: activeCapturePicker.targetKind,
    sources: activeCapturePicker.sources,
    virtualBounds: activeCapturePicker.virtualBounds
  };
}

async function completeCapturePicker(request: CompleteCapturePickerRequest): Promise<void> {
  if (!activeCapturePicker || activeCapturePicker.requestId !== request.requestId) {
    throw new Error("Capture picker request is no longer active.");
  }

  if (request.selection.targetKind !== activeCapturePicker.targetKind) {
    throw new Error("Capture picker target type no longer matches the active request.");
  }

  const selection = await resolveCaptureSelection(request.selection);

  settleCapturePicker(selection);
}

function cancelCapturePicker(request: CancelCapturePickerRequest): void {
  if (!activeCapturePicker || activeCapturePicker.requestId !== request.requestId) {
    return;
  }

  settleCapturePicker(null);
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getAppVersion, () => app.getVersion());

  ipcMain.handle(IPC_CHANNELS.getEnvironment, (): RecorderEnvironment => {
    const nativeEngineAvailable = existsSync(getRecorderCoreManifestPath());

    return {
      platform: process.platform,
      arch: process.arch,
      ffmpeg: {
        strategy: "system",
        expectedBinary: "ffmpeg"
      },
      nativeEngine: {
        status: nativeEngineAvailable ? "available" : "planned",
        crate: "recorder-core"
      }
    };
  });

  ipcMain.handle(IPC_CHANNELS.recorderListSources, listCaptureSources);

  ipcMain.handle(IPC_CHANNELS.recorderPickTarget, async (_event, request: PickCaptureTargetRequest) => {
    return pickCaptureTarget(request);
  });

  ipcMain.handle(IPC_CHANNELS.recorderStart, async (_event, request: StartRecordingRequest) => {
    return startRecordingSession(request);
  });

  ipcMain.handle(IPC_CHANNELS.recorderMarkMediaStarted, async (_event, request) => {
    markRecordingMediaStarted(request.sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.recorderPause, async (_event, request: PauseRecordingRequest) => {
    await pauseRecordingSession(request.sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.recorderResume, async (_event, request: ResumeRecordingRequest) => {
    await resumeRecordingSession(request.sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.recorderAppendChunk, async (_event, request) => {
    const recording = activeRecordings.get(request.sessionId);

    if (!recording) {
      throw new Error(`Recording session not found: ${request.sessionId}`);
    }

    if (!recording.captureStream) {
      throw new Error(`Recording session does not accept renderer chunks: ${request.sessionId}`);
    }

    await writeToStream(recording.captureStream, bufferFromChunk(request.chunk));
  });

  ipcMain.handle(IPC_CHANNELS.recorderStop, async (_event, request): Promise<OpenedProject> => {
    return stopRecordingSession(request.sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.capturePickerGetState, async (): Promise<CapturePickerState> => {
    return getActiveCapturePickerState();
  });

  ipcMain.handle(IPC_CHANNELS.capturePickerComplete, async (_event, request: CompleteCapturePickerRequest) => {
    await completeCapturePicker(request);
  });

  ipcMain.handle(IPC_CHANNELS.capturePickerCancel, async (_event, request: CancelCapturePickerRequest) => {
    cancelCapturePicker(request);
  });

  ipcMain.handle(IPC_CHANNELS.projectList, async (): Promise<ProjectSummary[]> => {
    return listProjects();
  });

  ipcMain.handle(IPC_CHANNELS.projectOpen, async (_event, request): Promise<OpenedProject> => {
    return openProject(request.projectDir);
  });

  ipcMain.handle(IPC_CHANNELS.projectOpenFolder, async (_event, request): Promise<void> => {
    await openProjectFolder(request.projectDir);
  });

  ipcMain.handle(IPC_CHANNELS.projectUpdateEdit, async (_event, request): Promise<OpenedProject> => {
    return updateProjectEdit(request.projectDir, request.edit);
  });

  ipcMain.handle(IPC_CHANNELS.exportStart, async (_event, request: StartExportRequest): Promise<ExportJob> => {
    return startExportJob(request.projectDir, request.preset, request.outputPath);
  });

  ipcMain.handle(IPC_CHANNELS.exportCancel, async (_event, request: CancelExportRequest): Promise<ExportJob> => {
    return cancelExportJob(request.jobId);
  });

  ipcMain.handle(IPC_CHANNELS.exportAppendChunk, async (_event, request) => {
    const activeJob = activeExportJobs.get(request.jobId);

    if (!activeJob) {
      return;
    }

    if (activeJob.job.status === "cancelled" || activeJob.renderStreamClosed) {
      return;
    }

    await writeToStream(activeJob.renderStream, bufferFromChunk(request.chunk));
  });

  ipcMain.handle(IPC_CHANNELS.exportFinish, async (_event, request): Promise<ExportJob> => {
    return finishExportJob(request.jobId);
  });

  ipcMain.handle(IPC_CHANNELS.exportOpenFile, async (_event, request: OpenExportFileRequest): Promise<void> => {
    await openExportFile(request.projectDir, request.exportId);
  });

  ipcMain.handle(IPC_CHANNELS.exportOpenFolder, async (_event, request: OpenExportFolderRequest): Promise<void> => {
    await openExportFolder(request.projectDir, request.exportId);
  });

  ipcMain.handle(
    IPC_CHANNELS.exportPickOutputPath,
    async (_event, request: PickExportOutputPathRequest): Promise<PickExportOutputPathResult | null> => {
      return pickExportOutputPath(request.projectDir, request.preset);
    }
  );

  ipcMain.handle(IPC_CHANNELS.settingsPickDefaultExportDirectory, async (): Promise<AppSettings | null> => {
    return pickDefaultExportDirectory();
  });

  ipcMain.handle(IPC_CHANNELS.settingsGet, async (): Promise<AppSettings> => {
    return readAppSettings();
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, async (_event, request): Promise<AppSettings> => {
    return updateAppSettings(request.settings);
  });
}

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_PROTOCOL, async (request) => {
    try {
      const filePath = fromMediaUrl(request.url);

      if (!isAllowedMediaPath(filePath)) {
        return new Response("Forbidden", { status: 403 });
      }

      const data = await readFile(filePath);
      const range = request.headers.get("range");
      const contentType = getMediaContentType(filePath);
      const baseHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Type": contentType
      };

      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);

        if (match) {
          const size = data.byteLength;
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Number(match[2]) : size - 1;
          const safeStart = Math.min(Math.max(start, 0), size - 1);
          const safeEnd = Math.min(Math.max(end, safeStart), size - 1);
          const chunk = data.subarray(safeStart, safeEnd + 1);

          return new Response(chunk, {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Length": String(chunk.byteLength),
              "Content-Range": `bytes ${safeStart}-${safeEnd}/${size}`
            }
          });
        }
      }

      return new Response(data, {
        headers: {
          ...baseHeaders,
          "Content-Length": String(data.byteLength)
        }
      });
    } catch (error) {
      console.warn(`[media-protocol] ${error instanceof Error ? error.message : String(error)}`);
      return new Response("Not found", { status: 404 });
    }
  });
}

function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const activeRecording = [...activeRecordings.values()].at(-1);

    if (!activeRecording) {
      callback({});
      return;
    }

    const sources = await desktopCapturer.getSources({
      types: activeRecording.targetKind === "window" ? ["window"] : ["screen"],
      thumbnailSize: { width: 0, height: 0 }
    });
    const selectedSource = sources.find((source) => source.id === activeRecording.session.sourceId) ?? sources[0];

    callback({
      video: selectedSource,
      audio:
        request.audioRequested &&
        activeRecording.audio.systemAudioEnabled &&
        process.platform === "win32"
          ? "loopback"
          : undefined
    });
  });
}

type CaptureSourceLoadOptions = {
  includeScreens: boolean;
  includeWindows: boolean;
  screenThumbnailSize?: { width: number; height: number };
  windowThumbnailSize?: { width: number; height: number };
  fetchWindowIcons?: boolean;
};

async function listCaptureSources(): Promise<CaptureSource[]> {
  return loadCaptureSources({
    includeScreens: true,
    includeWindows: true,
    screenThumbnailSize: { width: 0, height: 0 },
    windowThumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
}

async function listCaptureSourcesForPicker(targetKind: CaptureTargetKind): Promise<CaptureSource[]> {
  if (targetKind === "window") {
    return loadCaptureSources({
      includeScreens: false,
      includeWindows: true,
      windowThumbnailSize: { width: 1280, height: 720 },
      fetchWindowIcons: true
    });
  }

  return loadCaptureSources({
    includeScreens: true,
    includeWindows: false,
    screenThumbnailSize: { width: 0, height: 0 }
  });
}

async function loadCaptureSources(options: CaptureSourceLoadOptions): Promise<CaptureSource[]> {
  const displays = screen.getAllDisplays();
  const [screenSources, windowSources] = await Promise.all([
    options.includeScreens
      ? desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: options.screenThumbnailSize ?? { width: 0, height: 0 }
        })
      : Promise.resolve([]),
    options.includeWindows
      ? desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: options.windowThumbnailSize ?? { width: 0, height: 0 },
          fetchWindowIcons: options.fetchWindowIcons ?? false
        })
      : Promise.resolve([])
  ]);

  return [
    ...screenSources.map((source, index) => {
      const display = displays.find((item) => String(item.id) === source.display_id) ?? displays[index];

      return {
        id: source.id,
        name: source.name,
        displayId: source.display_id,
        type: "screen" as const,
        bounds: display?.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 },
        thumbnailDataUrl: toNativeImageDataUrl(source.thumbnail)
      };
    }),
    ...windowSources.map((source) => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id,
      type: "window" as const,
      bounds: getApproximateWindowBounds(source.thumbnail),
      thumbnailDataUrl: toNativeImageDataUrl(source.thumbnail),
      appIconDataUrl: toNativeImageDataUrl(source.appIcon ?? null)
    }))
  ];
}

function getApproximateWindowBounds(thumbnail: Electron.NativeImage): Rect {
  const size = thumbnail.getSize();

  return {
    x: 0,
    y: 0,
    width: Math.max(640, size.width || 1280),
    height: Math.max(360, size.height || 720)
  };
}

function toNativeImageDataUrl(image: Electron.NativeImage | null): string | undefined {
  if (!image || image.isEmpty()) {
    return undefined;
  }

  return image.toDataURL();
}

async function startRecordingSession(request: StartRecordingRequest): Promise<RecordingSession> {
  if (request.audio.micEnabled || request.audio.systemAudioEnabled) {
    throw new Error("Audio capture is temporarily disabled while reliable cursor-free capture is being stabilized.");
  }

  const selection = await resolveCaptureSelection(request.selection);
  const source = await getResolvedCaptureSource(selection);
  const captureEngine: CaptureEngine = "ffmpeg-gdigrab";
  const id = createSessionId();
  const projectDir = join(getProjectsRoot(), id);
  const timelineRawPath = join(projectDir, "timeline.ndjson");
  const timelinePath = join(projectDir, "timeline.json");
  const manifestPath = join(projectDir, "manifest.json");
  const startedAt = new Date().toISOString();

  await mkdir(projectDir, { recursive: true });

  const sidecar = spawn(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      getRecorderCoreManifestPath(),
      "--",
      "capture-mouse",
      "--session",
      id
    ],
    {
      cwd: getProjectRoot(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  if (!sidecar.stdout || !sidecar.stderr) {
    throw new Error("Could not open recorder-core sidecar streams.");
  }

  const recording: ActiveRecording = {
    session: {
      id,
      projectDir,
      sourceId: selection.sourceId,
      startedAt,
      source,
      targetKind: selection.targetKind,
      selection,
      audio: request.audio,
      canPauseResume: true,
      captureEngine
    },
    selection,
    source,
    targetKind: selection.targetKind,
    captureEngine,
    cursorSuppression: "guaranteed",
    selectionUi: "external-overlay",
    projectDir,
    capturePath: join(projectDir, "capture.mp4"),
    timelinePath,
    timelineRawPath,
    manifestPath,
    timelineStream: createWriteStream(timelineRawPath, { flags: "a" }),
    cursorEvents: [],
    sidecar,
    intervals: [],
    audio: request.audio,
    fps: request.fps,
    quality: request.quality,
    captureBounds: selection.bounds,
    region: selection.region,
    windowHandle: selection.windowHandle,
    state: "recording",
    startedAtMs: Date.now()
  };

  const lines = createInterface({ input: sidecar.stdout });

  lines.on("line", (line) => {
    recording.timelineStream.write(`${line}\n`);

    try {
      const event = JSON.parse(line) as CursorEvent & { session?: string };

      recording.cursorClockBaseMs ??= Date.now() - event.t;
      recording.cursorEvents.push({
        t: event.t,
        x: event.x,
        y: event.y,
        type: event.type,
        button: event.button
      });
    } catch {
      console.warn(`Ignoring cursor event line: ${line}`);
    }
  });

  sidecar.stderr.on("data", (data) => {
    console.warn(`[recorder-core] ${data.toString()}`);
  });

  const ffmpegCapture = await startFfmpegCaptureSegment(recording);

  recording.ffmpegCapture = ffmpegCapture;
  recording.mediaStartedAtMs = ffmpegCapture.startedAtMs;
  startRecordingInterval(recording, ffmpegCapture.startedAtMs, ffmpegCapture.segmentPath);

  activeRecordings.set(id, recording);

  return recording.session;
}

type WindowCaptureInfo = {
  bounds: Rect;
  windowHandle: string;
  isVisible: boolean;
  isMinimized: boolean;
};

async function resolveCaptureSelection(selection: CaptureSelection): Promise<CaptureSelection> {
  const sources = await loadCaptureSources({
    includeScreens: selection.targetKind !== "window",
    includeWindows: selection.targetKind === "window",
    screenThumbnailSize: { width: 0, height: 0 },
    windowThumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  const source = sources.find((item) => item.id === selection.sourceId);

  if (!source) {
    throw new Error("The selected capture source is no longer available.");
  }

  if (selection.targetKind === "region") {
    if (source.type !== "screen") {
      throw new Error("Region capture requires a screen source.");
    }

    const region = normalizeSelectedRegion(selection.region, source.bounds);

    return {
      ...selection,
      sourceName: source.name,
      sourceType: source.type,
      bounds: region,
      region
    };
  }

  if (selection.targetKind === "window") {
    if (source.type !== "window") {
      throw new Error("Window capture requires a window source.");
    }

    const windowInfo = await getWindowCaptureInfo(selection.sourceId);

    if (windowInfo.isMinimized || !windowInfo.isVisible) {
      throw new Error("The selected window is minimized or not visible. Restore it and try again.");
    }

    return {
      ...selection,
      sourceName: source.name,
      sourceType: source.type,
      bounds: windowInfo.bounds,
      windowHandle: windowInfo.windowHandle
    };
  }

  if (source.type !== "screen") {
    throw new Error("Screen capture requires a screen source.");
  }

  return {
    ...selection,
    sourceName: source.name,
    sourceType: source.type,
    bounds: source.bounds
  };
}

async function getResolvedCaptureSource(selection: CaptureSelection): Promise<CaptureSource> {
  const sources = await loadCaptureSources({
    includeScreens: selection.targetKind !== "window",
    includeWindows: selection.targetKind === "window",
    screenThumbnailSize: { width: 0, height: 0 },
    windowThumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  const source = sources.find((item) => item.id === selection.sourceId);

  if (!source) {
    throw new Error("The selected capture source is no longer available.");
  }

  return {
    ...source,
    name: selection.sourceName,
    bounds: selection.bounds
  };
}

function normalizeSelectedRegion(region: Rect | undefined, sourceBounds: Rect): Rect {
  if (!region) {
    return normalizeCaptureBounds(sourceBounds);
  }

  const left = clampNumber(region.x, sourceBounds.x, sourceBounds.x + sourceBounds.width - 2);
  const top = clampNumber(region.y, sourceBounds.y, sourceBounds.y + sourceBounds.height - 2);
  const right = clampNumber(
    region.x + region.width,
    left + 2,
    sourceBounds.x + sourceBounds.width
  );
  const bottom = clampNumber(
    region.y + region.height,
    top + 2,
    sourceBounds.y + sourceBounds.height
  );

  return normalizeCaptureBounds({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  });
}

async function getWindowCaptureInfo(sourceId: string): Promise<WindowCaptureInfo> {
  const result = await runRecorderCoreCommand("window-info", ["--source-id", sourceId]);

  return {
    bounds: {
      x: Number(result.x),
      y: Number(result.y),
      width: Number(result.width),
      height: Number(result.height)
    },
    windowHandle: String(result.windowHandle),
    isVisible: Boolean(result.isVisible),
    isMinimized: Boolean(result.isMinimized)
  };
}

async function runRecorderCoreCommand(command: string, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "cargo",
      [
        "run",
        "--quiet",
        "--manifest-path",
        getRecorderCoreManifestPath(),
        "--",
        command,
        ...args
      ],
      {
        cwd: getProjectRoot(),
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `recorder-core ${command} exited with code ${code ?? "unknown"}.`));
        return;
      }

      try {
        resolvePromise(JSON.parse(stdout.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startFfmpegCaptureSegment(recording: ActiveRecording): Promise<ActiveFfmpegCapture> {
  const segmentPath = join(
    recording.projectDir,
    `.capture-segment-${String(recording.intervals.length + 1).padStart(3, "0")}.mp4`
  );

  await rm(segmentPath, { force: true }).catch(() => undefined);

  return startFfmpegGdigrabCapture(recording, segmentPath);
}

async function startFfmpegGdigrabCapture(
  recording: ActiveRecording,
  capturePath: string
): Promise<ActiveFfmpegCapture> {
  const bounds = normalizeCaptureBounds(recording.captureBounds);
  const startedAtMs = Date.now();
  const stderr: string[] = [];
  const inputTarget =
    recording.targetKind === "window" && recording.windowHandle
      ? `hwnd=${recording.windowHandle}`
      : "desktop";
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-f",
      "gdigrab",
      "-draw_mouse",
      "0",
      "-framerate",
      String(clampNumber(Math.round(recording.fps), 1, 120)),
      ...(inputTarget === "desktop"
        ? [
            "-offset_x",
            String(bounds.x),
            "-offset_y",
            String(bounds.y),
            "-video_size",
            `${bounds.width}x${bounds.height}`
          ]
        : []),
      "-rtbufsize",
      "256M",
      "-i",
      inputTarget,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      String(getCaptureCrf(recording.quality)),
      "-pix_fmt",
      "yuv420p",
      capturePath
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"]
    }
  );

  ffmpeg.stderr?.on("data", (data) => {
    const text = data.toString();
    stderr.push(text);
    console.warn(`[ffmpeg-capture] ${text}`);
  });

  const exit = new Promise<ProcessExit>((resolve) => {
    ffmpeg.once("close", (code, signal) => resolve({ code, signal }));
  });

  await waitForFfmpegStartup(ffmpeg, exit, stderr);

  return {
    process: ffmpeg,
    exit,
    stderr,
    startedAtMs,
    segmentPath: capturePath
  };
}

function waitForFfmpegStartup(
  ffmpeg: ChildProcess,
  exit: Promise<ProcessExit>,
  stderr: string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      ffmpeg.removeListener("error", onError);
      if (error) {
        reject(error);
        return;
      }

      resolve();
    };
    const onError = (error: Error): void => finish(error);
    const timeout = setTimeout(() => finish(), 450);

    ffmpeg.once("error", onError);
    void exit.then(({ code, signal }) => {
      if (!settled) {
        finish(new Error(`FFmpeg capture exited during startup with code ${code ?? "unknown"} and signal ${signal ?? "none"}. ${stderr.join("").trim()}`));
      }
    });
  });
}

async function stopFfmpegCapture(capture: ActiveFfmpegCapture): Promise<void> {
  const process = capture.process;
  const closeTimeoutMs = 5_000;

  if (process.exitCode === null && !process.killed) {
    if (process.stdin?.writable) {
      process.stdin.write("q");
      process.stdin.end();
    } else {
      process.kill();
    }
  }

  const exit = await Promise.race([
    capture.exit,
    new Promise<ProcessExit>((_resolve, reject) => {
      setTimeout(() => {
        process.kill();
        reject(new Error("Timed out while stopping FFmpeg capture."));
      }, closeTimeoutMs);
    })
  ]);

  if (exit.code !== 0) {
    throw new Error(`FFmpeg capture exited with code ${exit.code ?? "unknown"}. ${capture.stderr.join("").trim()}`);
  }
}

function normalizeCaptureBounds(boundsOrSource: Rect | CaptureSource): Rect {
  const bounds = "bounds" in boundsOrSource ? boundsOrSource.bounds : boundsOrSource;
  const width = Math.max(2, Math.round(bounds.width));
  const height = Math.max(2, Math.round(bounds.height));

  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1
  };
}

function getCaptureCrf(quality: number): number {
  return Math.round(clampNumber(30 - quality * 0.12, 16, 30));
}

function markRecordingMediaStarted(sessionId: string): void {
  const recording = activeRecordings.get(sessionId);

  if (!recording) {
    throw new Error(`Recording session not found: ${sessionId}`);
  }

  const startedAtMs = Date.now();

  recording.mediaStartedAtMs ??= startedAtMs;
  if (!recording.intervals.some((interval) => interval.endedAtMs === undefined)) {
    startRecordingInterval(recording, startedAtMs);
  }
  recording.state = "recording";
}

function startRecordingInterval(recording: ActiveRecording, startedAtMs: number, segmentPath?: string): void {
  recording.intervals.push({
    startedAtMs,
    segmentPath
  });
}

function closeOpenRecordingInterval(recording: ActiveRecording, endedAtMs: number): void {
  const interval = [...recording.intervals].reverse().find((item) => item.endedAtMs === undefined);

  if (interval) {
    interval.endedAtMs = endedAtMs;
  }
}

async function pauseRecordingSession(sessionId: string): Promise<void> {
  const recording = activeRecordings.get(sessionId);

  if (!recording || recording.state !== "recording") {
    return;
  }

  closeOpenRecordingInterval(recording, Date.now());
  recording.state = "paused";

  if (recording.captureEngine === "ffmpeg-gdigrab" && recording.ffmpegCapture) {
    const capture = recording.ffmpegCapture;

    recording.ffmpegCapture = undefined;
    await stopFfmpegCapture(capture);
  }
}

async function resumeRecordingSession(sessionId: string): Promise<void> {
  const recording = activeRecordings.get(sessionId);

  if (!recording || recording.state !== "paused") {
    return;
  }

  if (recording.captureEngine === "ffmpeg-gdigrab") {
    const capture = await startFfmpegCaptureSegment(recording);

    recording.ffmpegCapture = capture;
    recording.mediaStartedAtMs ??= capture.startedAtMs;
    startRecordingInterval(recording, capture.startedAtMs, capture.segmentPath);
  } else {
    startRecordingInterval(recording, Date.now());
  }

  recording.state = "recording";
}

async function stopRecordingSession(sessionId: string): Promise<OpenedProject> {
  const recording = activeRecordings.get(sessionId);

  if (!recording) {
    throw new Error(`Recording session not found: ${sessionId}`);
  }

  activeRecordings.delete(sessionId);
  closeOpenRecordingInterval(recording, Date.now());
  recording.sidecar.kill();

  const stopCapture =
    recording.captureEngine === "ffmpeg-gdigrab" && recording.ffmpegCapture
      ? stopFfmpegCapture(recording.ffmpegCapture)
      : recording.captureStream
        ? endStream(recording.captureStream)
        : Promise.resolve();

  recording.ffmpegCapture = undefined;
  recording.captureStream = undefined;

  await Promise.all([stopCapture, endStream(recording.timelineStream)]);
  await finalizeRecordingCapture(recording);

  const source = getFinalManifestSource(recording);
  const durationMs = getRecordedDurationMs(recording);
  const timeline: Timeline = {
    sessionId,
    source,
    durationMs,
    events: buildTimelineEvents(recording, source, durationMs)
  };
  const manifest: ProjectManifest = {
    id: sessionId,
    createdAt: recording.session.startedAt,
    durationMs,
    source,
    captureEngine: recording.captureEngine,
    recording: {
      targetKind: recording.targetKind,
      region: recording.region,
      audio: recording.audio,
      cursorSuppression: recording.cursorSuppression,
      selectionUi: recording.selectionUi,
      windowHandle: recording.windowHandle,
      segmentCount: recording.intervals.length,
      segments: buildRecordingSegmentSummaries(recording)
    },
    files: {
      capture: toRelativeFile(recording.projectDir, recording.capturePath),
      timeline: toRelativeFile(recording.projectDir, recording.timelinePath),
      timelineRaw: toRelativeFile(recording.projectDir, recording.timelineRawPath),
      export: "export.mp4"
    }
  };

  await Promise.all([
    writeFile(recording.timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8"),
    writeFile(recording.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  ]);

  return openProject(recording.projectDir);
}

function getFinalManifestSource(recording: ActiveRecording): CaptureSource {
  if (recording.targetKind !== "region" || !recording.region) {
    return recording.source;
  }

  return {
    ...recording.source,
    bounds: recording.region
  };
}

function buildRecordingSegmentSummaries(recording: ActiveRecording): RecordingSegmentSummary[] {
  return recording.intervals
    .filter((interval): interval is RecordingInterval & { endedAtMs: number } => typeof interval.endedAtMs === "number")
    .map((interval) => ({
      startedAt: new Date(interval.startedAtMs).toISOString(),
      endedAt: new Date(interval.endedAtMs).toISOString(),
      durationMs: Math.max(0, interval.endedAtMs - interval.startedAtMs)
    }));
}

function getRecordedDurationMs(recording: ActiveRecording): number {
  return recording.intervals.reduce((total, interval) => {
    if (typeof interval.endedAtMs !== "number") {
      return total;
    }

    return total + Math.max(0, interval.endedAtMs - interval.startedAtMs);
  }, 0);
}

function buildTimelineEvents(recording: ActiveRecording, source: CaptureSource, durationMs: number): CursorEvent[] {
  const cursorClockBaseMs = recording.cursorClockBaseMs ?? recording.startedAtMs;

  return recording.cursorEvents
    .map((event) => {
      const absoluteTimeMs = cursorClockBaseMs + event.t;
      const mappedTimeMs = mapAbsoluteTimeToRecordedTime(recording.intervals, absoluteTimeMs);

      if (mappedTimeMs === null) {
        return null;
      }

      return {
        ...event,
        t: Math.round(mappedTimeMs),
        x: clampNumber(event.x, source.bounds.x, source.bounds.x + source.bounds.width),
        y: clampNumber(event.y, source.bounds.y, source.bounds.y + source.bounds.height)
      };
    })
    .filter((event): event is CursorEvent => Boolean(event))
    .filter((event) => event.t >= 0 && event.t <= durationMs);
}

function mapAbsoluteTimeToRecordedTime(intervals: RecordingInterval[], absoluteTimeMs: number): number | null {
  let accumulatedDurationMs = 0;

  for (const interval of intervals) {
    if (typeof interval.endedAtMs !== "number") {
      continue;
    }

    if (absoluteTimeMs < interval.startedAtMs) {
      return null;
    }

    if (absoluteTimeMs <= interval.endedAtMs) {
      return accumulatedDurationMs + (absoluteTimeMs - interval.startedAtMs);
    }

    accumulatedDurationMs += Math.max(0, interval.endedAtMs - interval.startedAtMs);
  }

  return null;
}

async function finalizeRecordingCapture(recording: ActiveRecording): Promise<void> {
  await rm(recording.capturePath, { force: true }).catch(() => undefined);

  if (recording.captureEngine === "ffmpeg-gdigrab") {
    await finalizeFfmpegRecording(recording);
    return;
  }

  await finalizeElectronRecording(recording);
}

async function finalizeFfmpegRecording(recording: ActiveRecording): Promise<void> {
  const segmentPaths = recording.intervals
    .map((interval) => interval.segmentPath)
    .filter((segmentPath): segmentPath is string => Boolean(segmentPath));

  if (!segmentPaths.length) {
    throw new Error("No FFmpeg capture segment was produced.");
  }

  if (segmentPaths.length === 1) {
    await copyFile(segmentPaths[0], recording.capturePath);
  } else {
    const concatListPath = join(recording.projectDir, ".capture-concat.txt");
    const concatListContent = segmentPaths
      .map((segmentPath) => `file '${segmentPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n");

    await writeFile(concatListPath, `${concatListContent}\n`, "utf8");

    try {
      await runFfmpegProcess(
        ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", recording.capturePath],
        "Could not concatenate FFmpeg capture segments."
      );
    } finally {
      await rm(concatListPath, { force: true }).catch(() => undefined);
    }
  }

  await Promise.all(segmentPaths.map((segmentPath) => rm(segmentPath, { force: true }).catch(() => undefined)));
}

async function finalizeElectronRecording(recording: ActiveRecording): Promise<void> {
  if (!recording.rawCapturePath) {
    throw new Error("Electron capture did not produce a raw capture file.");
  }

  const cropArgs =
    recording.targetKind === "region" && recording.region
      ? [
          "-vf",
          `crop=${Math.round(recording.region.width)}:${Math.round(recording.region.height)}:${Math.round(recording.region.x - recording.source.bounds.x)}:${Math.round(recording.region.y - recording.source.bounds.y)}`
        ]
      : [];
  const audioArgs =
    recording.audio.micEnabled || recording.audio.systemAudioEnabled
      ? ["-c:a", "aac", "-b:a", "160k"]
      : ["-an"];

  await runFfmpegProcess(
    [
      "-y",
      "-i",
      recording.rawCapturePath,
      ...cropArgs,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(getCaptureCrf(recording.quality)),
      "-pix_fmt",
      "yuv420p",
      ...audioArgs,
      recording.capturePath
    ],
    "Could not finalize Electron capture."
  );

  await rm(recording.rawCapturePath, { force: true }).catch(() => undefined);
}

function runFfmpegProcess(args: string[], failureMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";

    ffmpeg.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    ffmpeg.once("error", reject);
    ffmpeg.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${failureMessage} ${stderr.trim()}`.trim()));
    });
  });
}

async function openProject(projectDir: string): Promise<OpenedProject> {
  ensureAllowedProjectPath(projectDir);
  const manifestPath = join(projectDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectManifest;
  const timeline = JSON.parse(
    await readFile(join(projectDir, manifest.files.timeline), "utf8")
  ) as Timeline;
  const capturePath = join(projectDir, manifest.files.capture);
  const exports = getProjectExportEntries(projectDir, manifest);
  const latestExport = getLatestExistingExport(exports);

  return {
    projectDir,
    manifest,
    timeline,
    captureUrl: toMediaUrl(capturePath),
    exports,
    exportCount: exports.filter((entry) => entry.exists).length,
    latestExport,
    exportUrl: latestExport?.outputUrl
  };
}

async function listProjects(): Promise<ProjectSummary[]> {
  const projectsRoot = getProjectsRoot();

  await mkdir(projectsRoot, { recursive: true });

  const entries = await readdir(projectsRoot, { withFileTypes: true });
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<ProjectSummary | null> => {
        const projectDir = join(projectsRoot, entry.name);

        try {
          const project = await openProject(projectDir);
          const latestExport = project.latestExport;

          return {
            id: project.manifest.id,
            projectDir,
            createdAt: project.manifest.createdAt,
            durationMs: project.manifest.durationMs,
            editedDurationMs: getEditedProjectDurationMs(project.manifest),
            sourceName: project.manifest.source.name,
            exports: project.exports,
            exportCount: project.exportCount,
            hasExport: project.exportCount > 0,
            latestExport,
            exportPath: latestExport?.outputPath,
            exportUrl: latestExport?.outputUrl
          };
        } catch {
          return null;
        }
      })
  );

  return summaries
    .filter((summary): summary is ProjectSummary => Boolean(summary))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function openProjectFolder(projectDir: string): Promise<void> {
  ensureAllowedProjectPath(projectDir);

  const error = await shell.openPath(projectDir);

  if (error) {
    throw new Error(error);
  }
}

async function updateProjectEdit(projectDir: string, edit: ProjectEdit): Promise<OpenedProject> {
  ensureAllowedProjectPath(projectDir);
  const manifestPath = join(projectDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectManifest;
  const safeEdit = sanitizeProjectEdit(manifest, edit);
  const updatedManifest: ProjectManifest = {
    ...manifest,
    edit: safeEdit
  };

  await writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, "utf8");

  return openProject(projectDir);
}

async function updateProjectExportTarget(
  projectDir: string,
  preset: ExportPreset,
  outputPath: string,
  lastExportedAt?: string
): Promise<OpenedProject> {
  ensureAllowedProjectPath(projectDir);
  const manifestPath = join(projectDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectManifest;
  const records = normalizeProjectExportRecords(projectDir, manifest).filter((record) => record.id !== "legacy");
  const recordIndex = records.findIndex((record) => record.id === preset);
  const nextRecord: ProjectExportRecord = {
    id: preset,
    preset,
    outputPath: resolve(outputPath),
    lastExportedAt: lastExportedAt ?? records[recordIndex]?.lastExportedAt
  };

  if (recordIndex >= 0) {
    records[recordIndex] = nextRecord;
  } else {
    records.push(nextRecord);
  }

  const updatedManifest: ProjectManifest = {
    ...manifest,
    exports: records.map((record) => ({
      id: record.id,
      preset: record.preset,
      outputPath: record.outputPath,
      lastExportedAt: record.lastExportedAt
    }))
  };

  await writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, "utf8");

  return openProject(projectDir);
}

function sanitizeProjectEdit(manifest: ProjectManifest, edit: ProjectEdit): ProjectEdit {
  const currentEdit = manifest.edit;
  const startMs = Math.round(clampStartMs(edit.startMs ?? currentEdit?.startMs ?? 0, manifest.durationMs));
  const safeEdit: ProjectEdit = {
    ...currentEdit,
    startMs,
    durationMs: Math.round(
      clampDurationMs(edit.durationMs ?? currentEdit?.durationMs ?? manifest.durationMs - startMs, manifest.durationMs - startMs)
    )
  };
  const motion = edit.motion ?? currentEdit?.motion;
  const appearance = edit.appearance ?? currentEdit?.appearance;

  if (motion) {
    safeEdit.motion = sanitizeProjectMotionEdit(motion, manifest.durationMs);
  }

  if (appearance) {
    safeEdit.appearance = sanitizeProjectAppearanceEdit(appearance);
  }

  return safeEdit;
}

function clampStartMs(value: number, maxDurationMs: number): number {
  const safeMaxDurationMs = Math.max(1, maxDurationMs);
  const minDurationMs = Math.min(1_000, safeMaxDurationMs);

  return clampNumber(value, 0, safeMaxDurationMs - minDurationMs);
}

function sanitizeProjectAppearanceEdit(appearance: ProjectAppearanceEdit): ProjectAppearanceEdit {
  const backgroundPreset = ["dark-soft", "light-soft", "blue-windows", "warm-gradient"].includes(appearance.backgroundPreset)
    ? appearance.backgroundPreset
    : "dark-soft";
  const cursorStyle = ["white-arrow", "dark-arrow", "soft-dot"].includes(appearance.cursorStyle)
    ? appearance.cursorStyle
    : "white-arrow";

  return {
    backgroundPreset,
    frameScale: Math.round(clampNumber(appearance.frameScale ?? 90, 70, 94)),
    frameRadius: Math.round(clampNumber(appearance.frameRadius ?? 28, 0, 48)),
    frameShadow: Math.round(clampNumber(appearance.frameShadow ?? 72, 0, 100)),
    cursorStyle
  };
}

function sanitizeProjectMotionEdit(motion: ProjectMotionEdit, maxDurationMs: number): ProjectMotionEdit {
  return {
    mode: motion.mode === "manual" ? "manual" : "auto",
    autoZooms: Array.isArray(motion.autoZooms)
      ? motion.autoZooms.map((segment) => sanitizeManualZoomSegment(segment, maxDurationMs))
      : undefined,
    manualZooms: Array.isArray(motion.manualZooms)
      ? motion.manualZooms.map((segment) => sanitizeManualZoomSegment(segment, maxDurationMs))
      : [],
    showCursorInExport:
      typeof motion.showCursorInExport === "boolean" ? motion.showCursorInExport : undefined
  };
}

function sanitizeManualZoomSegment(segment: ManualZoomSegment, maxDurationMs: number): ManualZoomSegment {
  const safeMaxDurationMs = Math.max(1, maxDurationMs);

  return {
    id: typeof segment.id === "string" && segment.id ? segment.id : randomUUID(),
    anchorMs: Math.round(clampNumber(segment.anchorMs, 0, safeMaxDurationMs)),
    durationMs: Math.round(clampNumber(segment.durationMs, 1_000, Math.max(1_000, safeMaxDurationMs))),
    zoom: Number(clampNumber(segment.zoom, 1, 2.4).toFixed(2)),
    smoothness: Math.round(clampNumber(segment.smoothness ?? 68, 0, 100))
  };
}

async function resolveProjectExportEntry(projectDir: string, exportId: ProjectExportId): Promise<ProjectExportEntry> {
  const project = await openProject(projectDir);
  const entry = project.exports.find((item) => item.id === exportId);

  if (!entry) {
    throw new Error(`Export not found: ${exportId}`);
  }

  return entry;
}

async function openExportFile(projectDir: string, exportId: ProjectExportId): Promise<void> {
  const entry = await resolveProjectExportEntry(projectDir, exportId);

  if (!entry.exists) {
    throw new Error(`Export file not found: ${entry.outputPath}`);
  }

  const error = await shell.openPath(entry.outputPath);

  if (error) {
    throw new Error(error);
  }
}

async function openExportFolder(projectDir: string, exportId: ProjectExportId): Promise<void> {
  const entry = await resolveProjectExportEntry(projectDir, exportId);

  if (entry.exists) {
    shell.showItemInFolder(entry.outputPath);
    return;
  }

  const error = await shell.openPath(entry.directory);

  if (error) {
    throw new Error(error);
  }
}

async function pickExportOutputPath(
  projectDir: string,
  preset: ExportPreset
): Promise<PickExportOutputPathResult | null> {
  const [project, settings] = await Promise.all([openProject(projectDir), readAppSettings()]);
  const currentTarget = getExportRecordForPreset(project, preset)?.outputPath;
  const defaultPath = currentTarget || join(settings.defaultExportDirectory, getDefaultExportFileName(project, preset));
  const result = await dialog.showSaveDialog({
    title: `Choose output for ${preset}`,
    defaultPath,
    filters: [{ name: "MP4 video", extensions: ["mp4"] }]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  const selectedPath = extname(result.filePath).toLowerCase() === ".mp4" ? result.filePath : `${result.filePath}.mp4`;
  const updatedProject = await updateProjectExportTarget(projectDir, preset, selectedPath);

  return {
    outputPath: selectedPath,
    project: updatedProject
  };
}

async function readAppSettings(): Promise<AppSettings> {
  const settingsPath = getSettingsPath();
  const defaultSettings = getDefaultAppSettings();

  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Partial<AppSettings>;

    return sanitizeSettings(settings);
  } catch {
    await writeAppSettings(defaultSettings);
    return defaultSettings;
  }
}

async function pickDefaultExportDirectory(): Promise<AppSettings | null> {
  const settings = await readAppSettings();
  const result = await dialog.showOpenDialog({
    title: "Choose default export folder",
    defaultPath: settings.defaultExportDirectory,
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return updateAppSettings({ defaultExportDirectory: result.filePaths[0] });
}

async function updateAppSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const currentSettings = await readAppSettings();
  const nextSettings = sanitizeSettings({ ...currentSettings, ...settings });

  await writeAppSettings(nextSettings);

  return nextSettings;
}

async function writeAppSettings(settings: AppSettings): Promise<void> {
  const settingsPath = getSettingsPath();

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function sanitizeDirectoryPath(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return resolve(value.trim());
}

function sanitizeSettings(settings: Partial<AppSettings>): AppSettings {
  const defaultSettings = getDefaultAppSettings();

  return {
    playbackRate: sanitizePlaybackRate(settings.playbackRate),
    loopPreview: settings.loopPreview ?? defaultSettings.loopPreview,
    showCursor: settings.showCursor ?? defaultSettings.showCursor,
    fps: Math.round(clampNumber(settings.fps ?? defaultSettings.fps, 24, 120)),
    quality: Math.round(clampNumber(settings.quality ?? defaultSettings.quality, 1, 100)),
    zoomPercent: Math.round(clampNumber(settings.zoomPercent ?? defaultSettings.zoomPercent, 100, 240)),
    smoothness: Math.round(clampNumber(settings.smoothness ?? defaultSettings.smoothness, 0, 100)),
    defaultExportDirectory: sanitizeDirectoryPath(
      settings.defaultExportDirectory,
      defaultSettings.defaultExportDirectory
    )
  };
}

function sanitizePlaybackRate(value: unknown): AppSettings["playbackRate"] {
  return value === 0.5 || value === 1 || value === 1.5 || value === 2
    ? value
    : getDefaultAppSettings().playbackRate;
}

async function startExportJob(projectDir: string, preset: ExportPreset, outputPath: string): Promise<ExportJob> {
  const project = await openProject(projectDir);
  const id = createSessionId();
  const renderPath = join(projectDir, `.render-${id}.webm`);
  const tempOutputPath = join(projectDir, `.export-${id}.mp4`);

  await rm(renderPath, { force: true });
  await rm(tempOutputPath, { force: true });

  const job: ExportJob = {
    id,
    projectId: project.manifest.id,
    preset,
    startedAt: new Date().toISOString(),
    status: "rendering",
    progress: 0,
    outputPath: resolve(outputPath)
  };
  const activeJob: ActiveExportJob = {
    job,
    projectDir,
    renderPath,
    tempOutputPath,
    renderStream: createWriteStream(renderPath, { flags: "a" }),
    durationMs: Math.max(1, getEditedProjectDurationMs(project.manifest)),
    renderStreamClosed: false
  };

  activeExportJobs.set(id, activeJob);
  emitExportProgress(job);

  return job;
}

function getEditedProjectDurationMs(manifest: ProjectManifest): number {
  const startMs = clampStartMs(manifest.edit?.startMs ?? 0, manifest.durationMs);

  return Math.round(clampDurationMs(manifest.edit?.durationMs ?? manifest.durationMs - startMs, manifest.durationMs - startMs));
}

function clampDurationMs(value: number, maxDurationMs: number): number {
  const safeMaxDurationMs = Math.max(1, maxDurationMs);
  const safeMinDurationMs = Math.min(1_000, safeMaxDurationMs);

  return clampNumber(value, safeMinDurationMs, safeMaxDurationMs);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function finishExportJob(jobId: string): Promise<ExportJob> {
  const activeJob = activeExportJobs.get(jobId);

  if (!activeJob) {
    throw new Error(`Export job not found: ${jobId}`);
  }

  await closeActiveExportRenderStream(activeJob);

  if (activeJob.job.status === "cancelled") {
    await cleanupActiveExportJob(activeJob);
    activeExportJobs.delete(jobId);
    return activeJob.job;
  }

  activeJob.job.status = "encoding";
  activeJob.job.progress = 0.85;
  emitExportProgress(activeJob.job);

  try {
    const result = await runFfmpeg(activeJob);

    if (result === "cancelled") {
      await cleanupActiveExportJob(activeJob);
      activeExportJobs.delete(jobId);
      return activeJob.job;
    }

    await mkdir(dirname(activeJob.job.outputPath), { recursive: true });
    await copyFile(activeJob.tempOutputPath, activeJob.job.outputPath);
    const updatedProject = await updateProjectExportTarget(
      activeJob.projectDir,
      activeJob.job.preset,
      activeJob.job.outputPath,
      new Date().toISOString()
    );
    const updatedEntry = updatedProject.exports.find((entry) => entry.id === activeJob.job.preset);

    activeJob.job.status = "done";
    activeJob.job.progress = 1;
    activeJob.job.outputUrl = updatedEntry?.outputUrl;
    emitExportProgress(activeJob.job);

    return activeJob.job;
  } catch (error) {
    activeJob.job.status = "error";
    activeJob.job.error = toErrorText(error);
    emitExportProgress(activeJob.job);

    throw error;
  } finally {
    await cleanupActiveExportJob(activeJob);
    activeExportJobs.delete(jobId);
  }
}

async function cancelExportJob(jobId: string): Promise<ExportJob> {
  const activeJob = activeExportJobs.get(jobId);

  if (!activeJob) {
    throw new Error(`Export job not found: ${jobId}`);
  }

  if (activeJob.job.status === "done" || activeJob.job.status === "error" || activeJob.job.status === "cancelled") {
    return activeJob.job;
  }

  activeJob.job.status = "cancelled";
  activeJob.cancelledAt = new Date().toISOString();
  emitExportProgress(activeJob.job);

  if (activeJob.ffmpegProcess?.exitCode === null && !activeJob.ffmpegProcess.killed) {
    if (activeJob.ffmpegProcess.stdin?.writable) {
      activeJob.ffmpegProcess.stdin.write("q");
      activeJob.ffmpegProcess.stdin.end();
    } else {
      activeJob.ffmpegProcess.kill();
    }

    return activeJob.job;
  }

  await closeActiveExportRenderStream(activeJob);
  await cleanupActiveExportJob(activeJob);
  activeExportJobs.delete(jobId);

  return activeJob.job;
}

async function closeActiveExportRenderStream(activeJob: ActiveExportJob): Promise<void> {
  if (activeJob.renderStreamClosed) {
    return;
  }

  activeJob.renderStreamClosed = true;
  await endStream(activeJob.renderStream);
}

async function cleanupActiveExportJob(activeJob: ActiveExportJob): Promise<void> {
  if (!activeJob.renderStreamClosed) {
    await closeActiveExportRenderStream(activeJob).catch(() => undefined);
  }

  await Promise.all([
    rm(activeJob.renderPath, { force: true }).catch(() => undefined),
    rm(activeJob.tempOutputPath, { force: true }).catch(() => undefined)
  ]);
}

function runFfmpeg(activeJob: ActiveExportJob): Promise<"done" | "cancelled"> {
  const config = getExportPresetConfig(activeJob.job.preset);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        activeJob.renderPath,
        "-c:v",
        "libx264",
        "-preset",
        config.preset,
        "-crf",
        String(config.crf),
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-movflags",
        "+faststart",
        activeJob.tempOutputPath
      ],
      { windowsHide: true }
    );

    activeJob.ffmpegProcess = ffmpeg;
    ffmpeg.stderr.on("data", (data) => {
      const text = data.toString();
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);

      if (!timeMatch || activeJob.job.status === "cancelled") {
        return;
      }

      const hours = Number(timeMatch[1]);
      const minutes = Number(timeMatch[2]);
      const seconds = Number(timeMatch[3]);
      const elapsedSeconds = hours * 3600 + minutes * 60 + seconds;
      const encodedRatio = (elapsedSeconds * 1000) / activeJob.durationMs;
      const estimatedProgress = Math.min(0.99, 0.85 + encodedRatio * 0.15);

      activeJob.job.progress = estimatedProgress;
      emitExportProgress(activeJob.job);
    });

    ffmpeg.on("error", (error) => {
      activeJob.ffmpegProcess = undefined;

      if (activeJob.job.status === "cancelled") {
        resolve("cancelled");
        return;
      }

      reject(error);
    });
    ffmpeg.on("exit", (code) => {
      activeJob.ffmpegProcess = undefined;

      if (activeJob.job.status === "cancelled") {
        resolve("cancelled");
        return;
      }

      if (code === 0) {
        resolve("done");
        return;
      }

      activeJob.job.status = "error";
      activeJob.job.error = `FFmpeg exited with code ${code ?? "unknown"}`;
      emitExportProgress(activeJob.job);
      reject(new Error(activeJob.job.error));
    });
  });
}

function getExportPresetConfig(preset: ExportPreset): { preset: "slow" | "medium" | "faster"; crf: number } {
  switch (preset) {
    case "high-quality":
      return { preset: "slow", crf: 16 };
    case "small-file":
      return { preset: "faster", crf: 28 };
    case "balanced":
    default:
      return { preset: "medium", crf: 22 };
  }
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.recorder.video");
  }

  registerDisplayMediaHandler();
  registerMediaProtocol();
  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
