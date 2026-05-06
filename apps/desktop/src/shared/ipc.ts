export const IPC_CHANNELS = {
  getAppVersion: "app:get-version",
  getEnvironment: "recorder:get-environment",
  recorderListSources: "recorder:list-sources",
  recorderPickTarget: "recorder:pick-target",
  recorderStart: "recorder:start",
  recorderMarkMediaStarted: "recorder:mark-media-started",
  recorderPause: "recorder:pause",
  recorderResume: "recorder:resume",
  recorderAppendChunk: "recorder:append-chunk",
  recorderStop: "recorder:stop",
  capturePickerGetState: "capture-picker:get-state",
  capturePickerComplete: "capture-picker:complete",
  capturePickerCancel: "capture-picker:cancel",
  projectList: "project:list",
  projectOpen: "project:open",
  projectOpenFolder: "project:open-folder",
  projectUpdateEdit: "project:update-edit",
  exportStart: "export:start",
  exportCancel: "export:cancel",
  exportAppendChunk: "export:append-chunk",
  exportFinish: "export:finish",
  exportOpenFile: "export:open-file",
  exportOpenFolder: "export:open-folder",
  exportPickOutputPath: "export:pick-output-path",
  settingsGet: "settings:get",
  settingsPickDefaultExportDirectory: "settings:pick-default-export-directory",
  settingsUpdate: "settings:update",
  exportProgress: "export:progress"
} as const;

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CaptureSource = {
  id: string;
  name: string;
  displayId: string;
  type: "screen" | "window";
  bounds: Rect;
  thumbnailDataUrl?: string;
  appIconDataUrl?: string;
};

export type CaptureTargetKind = "screen" | "window" | "region";
export type CaptureEngine = "ffmpeg-gdigrab" | "electron-mediarecorder";
export type CursorSuppression = "guaranteed" | "best-effort";
export type CaptureSelectionUi = "external-overlay" | "inline-picker";

export type RecordingAudioOptions = {
  micEnabled: boolean;
  micDeviceId?: string;
  systemAudioEnabled: boolean;
};

export type AudioInputDevice = {
  deviceId: string;
  groupId: string;
  label: string;
};

export type RecordingSegmentSummary = {
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

export type CaptureSelection = {
  targetKind: CaptureTargetKind;
  sourceId: string;
  sourceName: string;
  sourceType: CaptureSource["type"];
  bounds: Rect;
  region?: Rect;
  windowHandle?: string;
};

export type CapturePickerState = {
  requestId: string;
  targetKind: CaptureTargetKind;
  sources: CaptureSource[];
  virtualBounds: Rect;
};

export type ProjectRecordingMetadata = {
  targetKind: CaptureTargetKind;
  region?: Rect;
  audio: RecordingAudioOptions;
  cursorSuppression: CursorSuppression;
  selectionUi: CaptureSelectionUi;
  windowHandle?: string;
  segmentCount: number;
  segments: RecordingSegmentSummary[];
};

export type RecordingSession = {
  id: string;
  projectDir: string;
  sourceId: string;
  startedAt: string;
  source: CaptureSource;
  targetKind: CaptureTargetKind;
  selection: CaptureSelection;
  audio: RecordingAudioOptions;
  canPauseResume: boolean;
  captureEngine: CaptureEngine;
};

export type RecorderStatus =
  | "idle"
  | "countdown"
  | "recording"
  | "paused"
  | "processing"
  | "preview"
  | "exporting"
  | "error";

export type CursorEvent = {
  t: number;
  x: number;
  y: number;
  type: "move" | "down" | "up";
  button?: "left" | "right";
};

export type Timeline = {
  sessionId: string;
  source: CaptureSource;
  durationMs: number;
  events: CursorEvent[];
};

export type ProjectManifest = {
  id: string;
  createdAt: string;
  durationMs: number;
  source: CaptureSource;
  captureEngine?: CaptureEngine;
  recording?: ProjectRecordingMetadata;
  edit?: ProjectEdit;
  exports?: ProjectExportRecord[];
  files: {
    capture: string;
    timeline: string;
    timelineRaw: string;
    export: string;
  };
};

export type ProjectEdit = {
  startMs: number;
  durationMs: number;
  motion?: ProjectMotionEdit;
  appearance?: ProjectAppearanceEdit;
};

export type BackgroundPreset = "dark-soft" | "light-soft" | "blue-windows" | "warm-gradient";

export type CursorStyle = "white-arrow" | "dark-arrow" | "soft-dot";

export type ProjectAppearanceEdit = {
  backgroundPreset: BackgroundPreset;
  frameScale: number;
  frameRadius: number;
  frameShadow: number;
  cursorStyle: CursorStyle;
};

export type ProjectMotionEdit = {
  mode: "auto" | "manual";
  autoZooms?: ManualZoomSegment[];
  manualZooms: ManualZoomSegment[];
  showCursorInExport?: boolean;
};

export type ManualZoomSegment = {
  id: string;
  anchorMs: number;
  durationMs: number;
  zoom: number;
  smoothness?: number;
};

export type ExportPreset = "high-quality" | "balanced" | "small-file";

export type ProjectExportId = ExportPreset | "legacy";

export type ProjectExportRecord = {
  id: ProjectExportId;
  preset: ProjectExportId;
  outputPath: string;
  lastExportedAt?: string;
};

export type ProjectExportEntry = ProjectExportRecord & {
  directory: string;
  exists: boolean;
  fileName: string;
  isLegacy: boolean;
  outputUrl?: string;
};

export type OpenedProject = {
  projectDir: string;
  manifest: ProjectManifest;
  timeline: Timeline;
  captureUrl: string;
  exports: ProjectExportEntry[];
  exportCount: number;
  latestExport?: ProjectExportEntry;
  exportUrl?: string;
};

export type ProjectSummary = {
  id: string;
  projectDir: string;
  createdAt: string;
  durationMs: number;
  editedDurationMs: number;
  sourceName: string;
  exports: ProjectExportEntry[];
  exportCount: number;
  hasExport: boolean;
  latestExport?: ProjectExportEntry;
  exportPath?: string;
  exportUrl?: string;
};

export type ExportJob = {
  id: string;
  projectId: string;
  preset: ExportPreset;
  startedAt: string;
  status: "rendering" | "encoding" | "done" | "cancelled" | "error";
  progress: number;
  outputPath: string;
  outputUrl?: string;
  error?: string;
};

export type StartRecordingRequest = {
  selection: CaptureSelection;
  countdownSeconds: 3;
  audio: RecordingAudioOptions;
  fps: number;
  quality: number;
};

export type PickCaptureTargetRequest = {
  targetKind: CaptureTargetKind;
};

export type CompleteCapturePickerRequest = {
  requestId: string;
  selection: CaptureSelection;
};

export type CancelCapturePickerRequest = {
  requestId: string;
};

export type AppendRecordingChunkRequest = {
  sessionId: string;
  chunk: ArrayBuffer;
};

export type MarkMediaStartedRequest = {
  sessionId: string;
};

export type PauseRecordingRequest = {
  sessionId: string;
};

export type ResumeRecordingRequest = {
  sessionId: string;
};

export type StopRecordingRequest = {
  sessionId: string;
};

export type OpenProjectRequest = {
  projectDir: string;
};

export type OpenProjectFolderRequest = {
  projectDir: string;
};

export type UpdateProjectEditRequest = {
  projectDir: string;
  edit: ProjectEdit;
};

export type OpenExportFileRequest = {
  projectDir: string;
  exportId: ProjectExportId;
};

export type OpenExportFolderRequest = {
  projectDir: string;
  exportId: ProjectExportId;
};

export type PlaybackRate = 0.5 | 1 | 1.5 | 2;

export type AppSettings = {
  playbackRate: PlaybackRate;
  loopPreview: boolean;
  showCursor: boolean;
  fps: number;
  quality: number;
  zoomPercent: number;
  smoothness: number;
  defaultExportDirectory: string;
  lastMicDeviceId?: string;
};

export type UpdateSettingsRequest = {
  settings: Partial<AppSettings>;
};

export type StartExportRequest = {
  projectDir: string;
  format: "mp4";
  preset: ExportPreset;
  outputPath: string;
};

export type CancelExportRequest = {
  jobId: string;
};

export type AppendExportChunkRequest = {
  jobId: string;
  chunk: ArrayBuffer;
};

export type FinishExportRequest = {
  jobId: string;
};

export type PickExportOutputPathRequest = {
  projectDir: string;
  preset: ExportPreset;
};

export type PickExportOutputPathResult = {
  outputPath: string;
  project: OpenedProject;
};

export type RecorderEnvironment = {
  platform: string;
  arch: string;
  ffmpeg: {
    strategy: "system";
    expectedBinary: "ffmpeg";
  };
  nativeEngine: {
    status: "planned" | "available";
    crate: "recorder-core";
  };
};

export type RecorderApi = {
  getAppVersion: () => Promise<string>;
  getEnvironment: () => Promise<RecorderEnvironment>;
  recorder: {
    listSources: () => Promise<CaptureSource[]>;
    listAudioInputs: () => Promise<AudioInputDevice[]>;
    pickTarget: (request: PickCaptureTargetRequest) => Promise<CaptureSelection | null>;
    start: (request: StartRecordingRequest) => Promise<RecordingSession>;
    markMediaStarted: (request: MarkMediaStartedRequest) => Promise<void>;
    pause: (request: PauseRecordingRequest) => Promise<void>;
    resume: (request: ResumeRecordingRequest) => Promise<void>;
    appendChunk: (request: AppendRecordingChunkRequest) => Promise<void>;
    stop: (request: StopRecordingRequest) => Promise<OpenedProject>;
  };
  capturePicker: {
    getState: () => Promise<CapturePickerState>;
    complete: (request: CompleteCapturePickerRequest) => Promise<void>;
    cancel: (request: CancelCapturePickerRequest) => Promise<void>;
  };
  project: {
    list: () => Promise<ProjectSummary[]>;
    open: (request: OpenProjectRequest) => Promise<OpenedProject>;
    openFolder: (request: OpenProjectFolderRequest) => Promise<void>;
    updateEdit: (request: UpdateProjectEditRequest) => Promise<OpenedProject>;
  };
  export: {
    start: (request: StartExportRequest) => Promise<ExportJob>;
    cancel: (request: CancelExportRequest) => Promise<ExportJob>;
    appendChunk: (request: AppendExportChunkRequest) => Promise<void>;
    finish: (request: FinishExportRequest) => Promise<ExportJob>;
    pickOutputPath: (request: PickExportOutputPathRequest) => Promise<PickExportOutputPathResult | null>;
    openFile: (request: OpenExportFileRequest) => Promise<void>;
    openFolder: (request: OpenExportFolderRequest) => Promise<void>;
    onProgress: (callback: (job: ExportJob) => void) => () => void;
  };
  settings: {
    get: () => Promise<AppSettings>;
    pickDefaultExportDirectory: () => Promise<AppSettings | null>;
    update: (request: UpdateSettingsRequest) => Promise<AppSettings>;
  };
};
