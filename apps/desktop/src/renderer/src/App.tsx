import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import {
  Aperture,
  ChevronDown,
  CircleDot,
  Clapperboard,
  Download,
  Gauge,
  Monitor,
  MousePointer2,
  Palette,
  Pause,
  Play,
  Scissors,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  Video
} from "lucide-react";
import type {
  AppSettings,
  BackgroundPreset,
  CaptureSelection,
  CaptureTargetKind,
  CursorStyle,
  CursorEvent,
  ExportJob,
  ExportPreset,
  ManualZoomSegment,
  OpenedProject,
  PlaybackRate,
  ProjectExportEntry,
  ProjectExportId,
  ProjectAppearanceEdit,
  ProjectEdit,
  ProjectMotionEdit,
  ProjectSummary,
  Rect,
  RecorderEnvironment,
  RecorderStatus,
  RecordingSession,
  Timeline
} from "@shared/ipc";

type MotionState = {
  hasCursor: boolean;
  xPct: number;
  yPct: number;
  zoom: number;
};

type CursorPoint = {
  x: number;
  y: number;
};

type SmoothedCursorPoint = CursorPoint & {
  t: number;
};

type SmoothedCursorPath = {
  durationMs: number;
  points: SmoothedCursorPoint[];
};

type TimelineTrack = {
  label: string;
  blocks: TimelineBlock[];
};

type TimelineBlock = {
  id?: string;
  left: string;
  width: string;
  selected?: boolean;
};

type MotionSegmentUpdate = Partial<Pick<ManualZoomSegment, "anchorMs" | "durationMs" | "zoom" | "smoothness">>;

type FrameComposition = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
};

type WorkspaceView = "studio" | "projects" | "exports" | "settings";

type ExportListItem = {
  createdAt: string;
  editedDurationMs: number;
  entry: ProjectExportEntry;
  projectDir: string;
  projectId: string;
  sourceName: string;
};

const ZOOM_TOTAL_MS = 4000;
const ZOOM_IN_MS = 600;
const ZOOM_OUT_MS = 800;
const MANUAL_ZOOM_DEFAULT_DURATION_MS = ZOOM_TOTAL_MS;
const CURSOR_SAMPLE_FPS = 60;
const CURSOR_SAMPLE_MS = 1000 / CURSOR_SAMPLE_FPS;
const CURSOR_VISUAL_DELAY_MS = 120;
const CURSOR_SMOOTH_MIN_ALPHA = 0.1;
const CURSOR_SMOOTH_MAX_ALPHA = 0.32;
const CURSOR_SMOOTH_DISTANCE_REF = 900;
const EXPORT_RENDER_PROGRESS_MAX = 0.85;
const EXPORT_RENDER_FPS = 60;
const EXPORT_MIN_BITRATE = 18_000_000;
const EXPORT_MAX_BITRATE = 90_000_000;
const COMPOSED_FRAME_HEIGHT_RATIO = 0.92;
const CURSOR_INTERPOLATION_MAX_GAP_MS = 180;
const FIXED_RECORDING_COUNTDOWN_SECONDS = 3;
const DEFAULT_MOTION: MotionState = {
  hasCursor: false,
  xPct: 50,
  yPct: 50,
  zoom: 1
};
const DEFAULT_APP_SETTINGS: AppSettings = {
  playbackRate: 1,
  loopPreview: false,
  showCursor: true,
  fps: 60,
  quality: 82,
  zoomPercent: 165,
  smoothness: 68,
  defaultExportDirectory: ""
};
const PLAYBACK_RATES: PlaybackRate[] = [0.5, 1, 1.5, 2];
const EXPORT_PRESETS: Array<{ value: ExportPreset; label: string }> = [
  { value: "high-quality", label: "High Quality" },
  { value: "balanced", label: "Balanced" },
  { value: "small-file", label: "Small File" }
];
const BACKGROUND_PRESETS: Array<{ value: BackgroundPreset; label: string }> = [
  { value: "dark-soft", label: "Dark soft" },
  { value: "light-soft", label: "Light soft" },
  { value: "blue-windows", label: "Blue Windows-like" },
  { value: "warm-gradient", label: "Warm gradient" }
];
const CURSOR_STYLES: Array<{ value: CursorStyle; label: string }> = [
  { value: "white-arrow", label: "White arrow" },
  { value: "dark-arrow", label: "Dark arrow" },
  { value: "soft-dot", label: "Soft dot" }
];
const CAPTURE_TARGETS: Array<{ value: CaptureTargetKind; label: string; description: string }> = [
  { value: "screen", label: "Screen", description: "Fastest full-screen capture with native cursor suppression." },
  { value: "window", label: "Window", description: "Record a single app window." },
  { value: "region", label: "Region", description: "Crop a fixed area from one screen before recording." }
];
const DEFAULT_PROJECT_APPEARANCE: ProjectAppearanceEdit = {
  backgroundPreset: "dark-soft",
  frameScale: 90,
  frameRadius: 28,
  frameShadow: 72,
  cursorStyle: "white-arrow"
};

export function App(): ReactElement {
  const previewSlotRef = useRef<HTMLDivElement | null>(null);
  const previewStageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeSessionRef = useRef<RecordingSession | null>(null);
  const exportAbortControllerRef = useRef<AbortController | null>(null);
  const countdownSequenceRef = useRef(0);
  const stopInFlightRef = useRef<Promise<void> | null>(null);
  const statusRef = useRef<RecorderStatus>("idle");
  const [captureTargetKind, setCaptureTargetKind] = useState<CaptureTargetKind>("screen");
  const [captureSelection, setCaptureSelection] = useState<CaptureSelection | null>(null);
  const [isPickingCaptureTarget, setIsPickingCaptureTarget] = useState(false);
  const [countdownRemaining, setCountdownRemaining] = useState<number | null>(null);
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [environment, setEnvironment] = useState<RecorderEnvironment | null>(null);
  const [version, setVersion] = useState("0.1.0");
  const [project, setProject] = useState<OpenedProject | null>(null);
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([]);
  const [activeView, setActiveView] = useState<WorkspaceView>("studio");
  const [previewTime, setPreviewTime] = useState(0);
  const [recordingElapsedBaseMs, setRecordingElapsedBaseMs] = useState(0);
  const [recordingActiveSinceMs, setRecordingActiveSinceMs] = useState<number | null>(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [fps, setFps] = useState(DEFAULT_APP_SETTINGS.fps);
  const [quality, setQuality] = useState(DEFAULT_APP_SETTINGS.quality);
  const [zoomPercent, setZoomPercent] = useState(DEFAULT_APP_SETTINGS.zoomPercent);
  const [smoothness, setSmoothness] = useState(DEFAULT_APP_SETTINGS.smoothness);
  const [activeMode, setActiveMode] = useState<"auto" | "manual">("auto");
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [selectedExportPreset, setSelectedExportPreset] = useState<ExportPreset>("balanced");
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [isPlaybackPanelOpen, setIsPlaybackPanelOpen] = useState(false);
  const [isTimelineFocused, setIsTimelineFocused] = useState(false);
  const [selectedMotionSegmentId, setSelectedMotionSegmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewSlotSize, setPreviewSlotSize] = useState({ width: 0, height: 0 });
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 });
  const timelineRef = useRef<HTMLElement | null>(null);
  const rawDurationMs = project?.timeline.durationMs ?? 0;
  const trimStartMs = project ? getProjectTrimStartMs(project) : 0;
  const editedDurationMs = project ? getEditedProjectDurationMs(project) : 0;
  const trimEndMs = project ? Math.min(rawDurationMs, trimStartMs + editedDurationMs) : editedDurationMs;
  const effectivePreviewTime = project ? clamp(previewTime, trimStartMs, trimEndMs) : previewTime;
  const previewOffsetMs = project ? Math.max(0, effectivePreviewTime - trimStartMs) : previewTime;
  const hasProject = Boolean(project);
  const cursorPath = useMemo(() => {
    return project ? createSmoothedCursorPath(project.timeline) : null;
  }, [project]);
  const motionEdit = useMemo(() => {
    return project ? getProjectMotionEdit(project, activeMode) : createDefaultProjectMotionEdit(activeMode);
  }, [activeMode, project]);
  const motionSegments = useMemo(() => {
    return project
      ? getMotionSegmentsForMode(project.timeline, motionEdit, zoomPercent / 100, smoothness, rawDurationMs)
      : [];
  }, [motionEdit, project, rawDurationMs, smoothness, zoomPercent]);
  const selectedMotionSegment = useMemo(() => {
    return motionSegments.find((segment) => segment.id === selectedMotionSegmentId) ?? null;
  }, [motionSegments, selectedMotionSegmentId]);
  const motionSegmentAtPlayhead = useMemo(() => {
    return findMotionSegmentAtTime(motionSegments, effectivePreviewTime);
  }, [effectivePreviewTime, motionSegments]);
  const editableMotionSegment = selectedMotionSegment ?? motionSegmentAtPlayhead;
  const showCursorInExport = getMotionExportCursor(motionEdit, appSettings.showCursor);
  const appearance = useMemo(() => {
    return project ? getProjectAppearanceEdit(project) : DEFAULT_PROJECT_APPEARANCE;
  }, [project]);

  useEffect(() => {
    void Promise.all([
      window.recorderApi.getEnvironment(),
      window.recorderApi.getAppVersion(),
      window.recorderApi.project.list(),
      window.recorderApi.settings.get()
    ]).then(([nextEnvironment, nextVersion, nextProjects, nextSettings]) => {
      setEnvironment(nextEnvironment);
      setVersion(nextVersion);
      setProjectSummaries(nextProjects);
      applyAppSettings(nextSettings, {
        setAppSettings,
        setFps,
        setQuality,
        setSmoothness,
        setZoomPercent
      });
    });
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    return window.recorderApi.export.onProgress((job) => {
      setExportJob(job);

      if (job.status === "cancelled") {
        exportAbortControllerRef.current = null;
        setStatus("preview");
      }
    });
  }, []);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    video.playbackRate = appSettings.playbackRate;
  }, [appSettings.playbackRate, project?.captureUrl]);

  useEffect(() => {
    if (!selectedMotionSegmentId) {
      return;
    }

    if (!motionSegments.some((segment) => segment.id === selectedMotionSegmentId)) {
      setSelectedMotionSegmentId(null);
    }
  }, [motionSegments, selectedMotionSegmentId]);

  useEffect(() => {
    if (status !== "recording" || recordingActiveSinceMs === null) {
      setRecordingElapsed(recordingElapsedBaseMs);
      return;
    }

    const timer = window.setInterval(() => {
      setRecordingElapsed(recordingElapsedBaseMs + (Date.now() - recordingActiveSinceMs));
    }, 250);

    return () => window.clearInterval(timer);
  }, [recordingActiveSinceMs, recordingElapsedBaseMs, status]);

  useEffect(() => {
    if (!hasProject) {
      return;
    }

    videoRef.current?.load();
  }, [project?.captureUrl]);

  useEffect(() => {
    if (!project) {
      return;
    }

    let animationFrame = 0;
    const tick = (): void => {
      const video = videoRef.current;

      if (video) {
        const mediaTimeMs = video.currentTime * 1000;

        if (mediaTimeMs < trimStartMs) {
          video.currentTime = trimStartMs / 1000;
          setPreviewTime(trimStartMs);
        } else if (mediaTimeMs >= trimEndMs) {
          if (appSettings.loopPreview) {
            video.currentTime = trimStartMs / 1000;
            setPreviewTime(trimStartMs);
            void video.play();
          } else {
            video.pause();
            video.currentTime = trimEndMs / 1000;
            setPreviewTime(trimEndMs);
          }
        } else {
          setPreviewTime(mediaTimeMs);
        }
      }

      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);

    return () => window.cancelAnimationFrame(animationFrame);
  }, [appSettings.loopPreview, hasProject, trimEndMs, trimStartMs]);

  useEffect(() => {
    if (!hasProject || (previewTime >= trimStartMs && previewTime <= trimEndMs)) {
      return;
    }

    const video = videoRef.current;
    const safePreviewTime = clamp(previewTime, trimStartMs, trimEndMs);

    if (video) {
      video.pause();
      video.currentTime = safePreviewTime / 1000;
    }

    setPreviewTime(safePreviewTime);
  }, [hasProject, previewTime, trimEndMs, trimStartMs]);

  useEffect(() => {
    const element = previewStageRef.current;

    if (!element) {
      return;
    }

    const updateSize = (): void => {
      setPreviewStageSize({
        width: element.clientWidth,
        height: element.clientHeight
      });
    };
    const observer = new ResizeObserver(updateSize);

    updateSize();
    observer.observe(element);

    return () => observer.disconnect();
  }, [activeView]);

  useEffect(() => {
    const element = previewSlotRef.current;

    if (!element) {
      return;
    }

    const updateSize = (): void => {
      setPreviewSlotSize({
        width: element.clientWidth,
        height: element.clientHeight
      });
    };
    const observer = new ResizeObserver(updateSize);

    updateSize();
    observer.observe(element);

    return () => observer.disconnect();
  }, [activeView]);

  const previewAspectRatioValue = useMemo(() => {
    const bounds = project?.timeline.source.bounds ?? captureSelection?.bounds;

    if (!bounds?.width || !bounds.height) {
      return 16 / 9;
    }

    return bounds.width / bounds.height;
  }, [captureSelection?.bounds, project]);
  const previewAspectRatio = useMemo(() => `${previewAspectRatioValue} / 1`, [previewAspectRatioValue]);

  const previewSourceBounds = project?.timeline.source.bounds ?? captureSelection?.bounds ?? null;
  const previewFrame = useMemo(() => {
    if (!previewSourceBounds || !previewStageSize.width || !previewStageSize.height) {
      return null;
    }

    return getFrameComposition(
      previewStageSize.width,
      previewStageSize.height,
      previewSourceBounds.width,
      previewSourceBounds.height,
      appearance
    );
  }, [appearance, previewSourceBounds, previewStageSize.height, previewStageSize.width]);

  const environmentLabel = useMemo(() => {
    if (!environment) {
      return "Loading";
    }

    return `${environment.platform} / ${environment.arch}`;
  }, [environment]);

  const motion = useMemo(() => {
    if (!project || !cursorPath) {
      return DEFAULT_MOTION;
    }

    return computeMotionState(
      project.timeline,
      cursorPath,
      effectivePreviewTime,
      zoomPercent / 100,
      smoothness / 100,
      motionEdit
    );
  }, [cursorPath, effectivePreviewTime, motionEdit, project, smoothness, zoomPercent]);

  const previewCompositionFocus = useMemo(() => {
    if (!previewFrame || !previewStageSize.width || !previewStageSize.height) {
      return { xPct: motion.xPct, yPct: motion.yPct };
    }

    return {
      xPct: clamp(
        ((previewFrame.x + (motion.xPct / 100) * previewFrame.width) / previewStageSize.width) * 100,
        0,
        100
      ),
      yPct: clamp(
        ((previewFrame.y + (motion.yPct / 100) * previewFrame.height) / previewStageSize.height) * 100,
        0,
        100
      )
    };
  }, [motion.xPct, motion.yPct, previewFrame, previewStageSize.height, previewStageSize.width]);

  const timelineTracks = useMemo(() => {
    if (!project) {
      return createEmptyTimelineTracks();
    }

    return createTimelineTracks(project.timeline, trimStartMs, editedDurationMs, motionSegments, selectedMotionSegmentId);
  }, [editedDurationMs, motionSegments, project, selectedMotionSegmentId, trimStartMs]);

  const plannedCaptureEngineLabel = "FFmpeg gdigrab";
  const captureSetupSummary = useMemo(() => {
    if (!captureSelection) {
      return `Choose a ${getCaptureTargetLabel(captureTargetKind).toLowerCase()}`;
    }

    const sizeLabel = `${Math.round(captureSelection.bounds.width)} x ${Math.round(captureSelection.bounds.height)} px`;

    if (captureSelection.targetKind === "region") {
      return `Region - ${captureSelection.sourceName} - ${sizeLabel}`;
    }

    return `${getCaptureTargetLabel(captureSelection.targetKind)} - ${captureSelection.sourceName}`;
  }, [captureSelection, captureTargetKind]);
  const captureAudioSummary = "Video only";
  const canOpenCaptureSetup = status === "idle" || status === "preview" || status === "error";
  const canRecord = canOpenCaptureSetup && Boolean(captureSelection);
  const canPause = status === "recording" && Boolean(activeSessionRef.current?.canPauseResume);
  const canResume = status === "paused" && Boolean(activeSessionRef.current?.canPauseResume);
  const canStop = status === "countdown" || status === "recording" || status === "paused";
  const canPreview = Boolean(project);
  const canExport =
    Boolean(project) &&
    status !== "countdown" &&
    status !== "recording" &&
    status !== "paused" &&
    status !== "processing" &&
    status !== "exporting";
  const canCancelExport = exportJob?.status === "rendering" || exportJob?.status === "encoding";
  const exportArtifacts = useMemo(() => {
    return projectSummaries
      .flatMap((summary): ExportListItem[] =>
        summary.exports
          .filter((entry) => entry.exists)
          .map((entry) => ({
            createdAt: summary.createdAt,
            editedDurationMs: summary.editedDurationMs,
            entry,
            projectDir: summary.projectDir,
            projectId: summary.id,
            sourceName: summary.sourceName
          }))
      )
      .sort((left, right) => (right.entry.lastExportedAt ?? "").localeCompare(left.entry.lastExportedAt ?? ""));
  }, [projectSummaries]);
  const selectedExportEntry = useMemo(() => {
    return project?.exports.find((entry) => entry.id === selectedExportPreset);
  }, [project, selectedExportPreset]);
  const selectedExportTargetPath = useMemo(() => {
    if (!project) {
      return "";
    }

    return (
      selectedExportEntry?.outputPath ||
      buildDefaultExportTargetPath(project, selectedExportPreset, appSettings.defaultExportDirectory)
    );
  }, [appSettings.defaultExportDirectory, project, selectedExportEntry, selectedExportPreset]);
  const projectExportHistory = useMemo(() => {
    return (project?.exports ?? [])
      .filter((entry) => entry.exists)
      .sort((left, right) => (right.lastExportedAt ?? "").localeCompare(left.lastExportedAt ?? ""));
  }, [project]);

  const refreshProjectSummaries = useCallback(async () => {
    const nextProjects = await window.recorderApi.project.list();

    setProjectSummaries(nextProjects);
  }, []);

  const updateSettings = useCallback(async (settings: Partial<AppSettings>) => {
    const nextSettings = await window.recorderApi.settings.update({ settings });

    applyAppSettings(nextSettings, {
      setAppSettings,
      setFps,
      setQuality,
      setSmoothness,
      setZoomPercent
    });

    return nextSettings;
  }, []);

  const resetRecordingTransport = useCallback(() => {
    setRecordingElapsedBaseMs(0);
    setRecordingActiveSinceMs(null);
    setRecordingElapsed(0);
    setCountdownRemaining(null);
  }, []);

  const openCaptureSetup = useCallback(async () => {
    if (!canOpenCaptureSetup || isPickingCaptureTarget) {
      return;
    }

    try {
      setIsPickingCaptureTarget(true);
      setNotice(null);
      setError(null);

      const selection = await window.recorderApi.recorder.pickTarget({
        targetKind: captureTargetKind
      });

      if (!selection) {
        return;
      }

      setCaptureSelection(selection);
      setCaptureTargetKind(selection.targetKind);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setStatus("error");
    } finally {
      setIsPickingCaptureTarget(false);
    }
  }, [canOpenCaptureSetup, captureTargetKind, isPickingCaptureTarget]);

  const cancelRecordingCountdown = useCallback(() => {
    countdownSequenceRef.current += 1;
    setCountdownRemaining(null);
    setStatus(project ? "preview" : "idle");
  }, [project]);

  const openProjectSummary = useCallback(async (summary: ProjectSummary) => {
    try {
      const openedProject = await window.recorderApi.project.open({ projectDir: summary.projectDir });

      setProject(openedProject);
      setSelectedExportPreset("balanced");
      setPreviewTime(getProjectTrimStartMs(openedProject));
      setSelectedMotionSegmentId(null);
      setActiveMode(getProjectMotionEdit(openedProject, "auto").mode);
      setStatus("preview");
      setActiveView("studio");
      setError(null);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }, []);

  const openProjectFolder = useCallback(async (projectDir: string) => {
    try {
      await window.recorderApi.project.openFolder({ projectDir });
      setError(null);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }, []);

  const openExportFile = useCallback(async (projectDir: string, exportId: ProjectExportId) => {
    try {
      await window.recorderApi.export.openFile({ projectDir, exportId });
      setError(null);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }, []);

  const openExportFolder = useCallback(async (projectDir: string, exportId: ProjectExportId) => {
    try {
      await window.recorderApi.export.openFolder({ projectDir, exportId });
      setError(null);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }, []);

  const pickExportOutputPath = useCallback(async () => {
    if (!project) {
      return;
    }

    try {
      const result = await window.recorderApi.export.pickOutputPath({
        projectDir: project.projectDir,
        preset: selectedExportPreset
      });

      if (!result) {
        return;
      }

      setProject(result.project);
      setError(null);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }, [project, selectedExportPreset]);

  const pickDefaultExportDirectory = useCallback(async () => {
    try {
      const nextSettings = await window.recorderApi.settings.pickDefaultExportDirectory();

      if (!nextSettings) {
        return;
      }

      applyAppSettings(nextSettings, {
        setAppSettings,
        setFps,
        setQuality,
        setSmoothness,
        setZoomPercent
      });
      setError(null);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }, []);

  const focusTrimTimeline = useCallback(() => {
    setActiveView("studio");
    setIsTimelineFocused(true);
    window.setTimeout(() => {
      timelineRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 0);
    window.setTimeout(() => setIsTimelineFocused(false), 1400);
  }, []);

  const stopRecordingInternal = useCallback(
    async (reason?: string) => {
      if (stopInFlightRef.current) {
        return stopInFlightRef.current;
      }

      const task = (async () => {
        const session = activeSessionRef.current;

        if (!session) {
          if (statusRef.current === "countdown") {
            cancelRecordingCountdown();
          }
          return;
        }

        try {
          setStatus("processing");
          setError(null);

          const openedProject = await window.recorderApi.recorder.stop({ sessionId: session.id });

          activeSessionRef.current = null;
          setProject(openedProject);
          setSelectedExportPreset("balanced");
          setPreviewTime(getProjectTrimStartMs(openedProject));
          setSelectedMotionSegmentId(null);
          setActiveMode(getProjectMotionEdit(openedProject, "auto").mode);
          setStatus("preview");
          setNotice(reason ?? null);
          resetRecordingTransport();
          await refreshProjectSummaries();
        } catch (nextError) {
          setError(toErrorMessage(nextError));
          setNotice(null);
          setStatus("error");
        } finally {
          activeSessionRef.current = null;
          resetRecordingTransport();
        }
      })();

      stopInFlightRef.current = task.finally(() => {
        stopInFlightRef.current = null;
      });

      return stopInFlightRef.current;
    },
    [cancelRecordingCountdown, refreshProjectSummaries, resetRecordingTransport]
  );

  const beginRecordingSession = useCallback(
    async (selection: CaptureSelection) => {
      try {
        setError(null);
        setNotice(null);

        const session = await window.recorderApi.recorder.start({
          selection,
          countdownSeconds: FIXED_RECORDING_COUNTDOWN_SECONDS,
          audio: {
            micEnabled: false,
            systemAudioEnabled: false
          },
          fps,
          quality
        });

        activeSessionRef.current = session;

        setProject(null);
        setExportJob(null);
        setPreviewTime(0);
        setSelectedMotionSegmentId(null);
        setRecordingElapsedBaseMs(0);
        setRecordingElapsed(0);
        setRecordingActiveSinceMs(Date.now());
        setStatus("recording");
      } catch (nextError) {
        setError(toErrorMessage(nextError));
        setNotice(null);
        setStatus("error");
        resetRecordingTransport();

        const session = activeSessionRef.current;
        if (session) {
          await window.recorderApi.recorder.stop({ sessionId: session.id }).catch(() => undefined);
          activeSessionRef.current = null;
        }
      }
    },
    [fps, quality, resetRecordingTransport]
  );

  const startRecording = useCallback(async () => {
    if (!captureSelection) {
      setError("Choose a capture source before recording.");
      setStatus("error");
      void openCaptureSetup();
      return;
    }
    const sequence = countdownSequenceRef.current + 1;

    countdownSequenceRef.current = sequence;
    setActiveView("studio");
    setExportJob(null);
    setError(null);
    setNotice(null);
    setStatus("countdown");

    for (let remaining = FIXED_RECORDING_COUNTDOWN_SECONDS; remaining > 0; remaining -= 1) {
      setCountdownRemaining(remaining);
      await delay(1000);

      if (countdownSequenceRef.current !== sequence) {
        return;
      }
    }

    setCountdownRemaining(null);
    if (countdownSequenceRef.current !== sequence) {
      return;
    }

    await beginRecordingSession(captureSelection);
  }, [beginRecordingSession, captureSelection, openCaptureSetup]);

  const pauseRecording = useCallback(async () => {
    const session = activeSessionRef.current;

    if (!session || status !== "recording") {
      return;
    }

    try {
      setError(null);

      await window.recorderApi.recorder.pause({ sessionId: session.id });

      const nextElapsed =
        recordingActiveSinceMs === null
          ? recordingElapsedBaseMs
          : recordingElapsedBaseMs + (Date.now() - recordingActiveSinceMs);

      setRecordingElapsedBaseMs(nextElapsed);
      setRecordingActiveSinceMs(null);
      setRecordingElapsed(nextElapsed);
      setStatus("paused");
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }, [recordingActiveSinceMs, recordingElapsedBaseMs, status]);

  const resumeRecording = useCallback(async () => {
    const session = activeSessionRef.current;

    if (!session || status !== "paused") {
      return;
    }

    try {
      setError(null);
      await window.recorderApi.recorder.resume({ sessionId: session.id });

      setRecordingActiveSinceMs(Date.now());
      setRecordingElapsed(recordingElapsedBaseMs);
      setStatus("recording");
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }, [recordingElapsedBaseMs, status]);

  const stopRecording = useCallback(async () => {
    if (status === "countdown") {
      cancelRecordingCountdown();
      return;
    }

    await stopRecordingInternal();
  }, [cancelRecordingCountdown, status, stopRecordingInternal]);

  const playPreview = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (project && (video.currentTime * 1000 < trimStartMs || video.currentTime * 1000 >= trimEndMs)) {
      video.currentTime = trimStartMs / 1000;
      setPreviewTime(trimStartMs);
    }

    video.playbackRate = appSettings.playbackRate;
    void video.play();
  }, [appSettings.playbackRate, project, trimEndMs, trimStartMs]);

  const pausePreview = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  const setLocalProjectTrim = useCallback((startMs: number, durationMs: number) => {
    setProject((currentProject) => {
      if (!currentProject) {
        return currentProject;
      }

      const safeStartMs = getSafeProjectTrimStartMs(currentProject, startMs);
      const safeDurationMs = getSafeEditedDurationMs(currentProject, durationMs, safeStartMs);

      return {
        ...currentProject,
        manifest: {
          ...currentProject.manifest,
          edit: {
            ...currentProject.manifest.edit,
            startMs: safeStartMs,
            durationMs: safeDurationMs
          }
        }
      };
    });
  }, []);

  const commitProjectTrim = useCallback(
    async (startMs: number, durationMs: number) => {
      if (!project) {
        return;
      }

      const safeStartMs = getSafeProjectTrimStartMs(project, startMs);
      const safeDurationMs = getSafeEditedDurationMs(project, durationMs, safeStartMs);

      try {
        const updatedProject = await persistProjectEdit(
          project,
          createProjectEdit(project, {
            startMs: safeStartMs,
            durationMs: safeDurationMs
          })
        );

        setProject(updatedProject);
      } catch (nextError) {
        setError(toErrorMessage(nextError));
        setStatus("error");
      }
    },
    [project]
  );

  const persistMotionEdit = useCallback(
    async (nextMotion: ProjectMotionEdit) => {
      if (!project) {
        setActiveMode(nextMotion.mode);
        return;
      }

      const nextEdit = createProjectEdit(project, {
        startMs: trimStartMs,
        durationMs: editedDurationMs,
        motion: nextMotion
      });

      setActiveMode(nextMotion.mode);
      setProject(applyProjectEditLocally(project, nextEdit));

      try {
        const updatedProject = await persistProjectEdit(project, nextEdit);

        setProject(updatedProject);
        setActiveMode(getProjectMotionEdit(updatedProject, nextMotion.mode).mode);
      } catch (nextError) {
        setError(toErrorMessage(nextError));
        setStatus("error");
      }
    },
    [editedDurationMs, project, trimStartMs]
  );

  const updateMotionMode = useCallback(
    (mode: "auto" | "manual") => {
      void persistMotionEdit({
        ...motionEdit,
        mode
      });
    },
    [motionEdit, persistMotionEdit]
  );

  const persistMotionSegment = useCallback(
    (segment: ManualZoomSegment, mode: "auto" | "manual") => {
      const normalizedSegment = normalizeMotionSegment(segment, rawDurationMs);
      const segmentKey = mode === "manual" ? "manualZooms" : "autoZooms";
      const currentSegments = mode === "manual" ? motionEdit.manualZooms : motionEdit.autoZooms ?? [];
      const nextSegments = currentSegments.some((item) => item.id === normalizedSegment.id)
        ? currentSegments.map((item) => (item.id === normalizedSegment.id ? normalizedSegment : item))
        : [...currentSegments, normalizedSegment];

      setSelectedMotionSegmentId(normalizedSegment.id);
      void persistMotionEdit({
        ...motionEdit,
        mode,
        [segmentKey]: sortManualZooms(nextSegments)
      });
    },
    [motionEdit, persistMotionEdit, rawDurationMs]
  );

  const updateEditableMotionSegment = useCallback(
    (updates: MotionSegmentUpdate) => {
      if (!editableMotionSegment || !project) {
        return;
      }

      persistMotionSegment(
        {
          ...editableMotionSegment,
          ...updates
        },
        motionEdit.mode
      );
    },
    [editableMotionSegment, motionEdit.mode, persistMotionSegment, project]
  );

  const upsertManualZoomAtPlayhead = useCallback(() => {
    if (!project) {
      return;
    }

    const anchorMs = Math.round(clamp(effectivePreviewTime, trimStartMs, trimEndMs));
    const segment: ManualZoomSegment = {
      id: editableMotionSegment?.id ?? createManualZoomSegmentId(),
      anchorMs,
      durationMs: editableMotionSegment?.durationMs ?? MANUAL_ZOOM_DEFAULT_DURATION_MS,
      zoom: Number((zoomPercent / 100).toFixed(2)),
      smoothness: editableMotionSegment?.smoothness ?? smoothness
    };

    persistMotionSegment(segment, "manual");
  }, [
    editableMotionSegment,
    effectivePreviewTime,
    persistMotionSegment,
    project,
    smoothness,
    trimEndMs,
    trimStartMs,
    zoomPercent
  ]);

  const removeManualZoomAtPlayhead = useCallback(() => {
    if (!editableMotionSegment || motionEdit.mode !== "manual") {
      return;
    }

    setSelectedMotionSegmentId(null);
    void persistMotionEdit({
      ...motionEdit,
      mode: "manual",
      manualZooms: motionEdit.manualZooms.filter((segment) => segment.id !== editableMotionSegment.id)
    });
  }, [editableMotionSegment, motionEdit, persistMotionEdit]);

  const updateExportCursorForProject = useCallback(
    (showCursorInExport: boolean) => {
      void persistMotionEdit({
        ...motionEdit,
        showCursorInExport
      });
    },
    [motionEdit, persistMotionEdit]
  );

  const persistAppearanceEdit = useCallback(
    async (nextAppearance: ProjectAppearanceEdit) => {
      if (!project) {
        return;
      }

      const nextEdit = createProjectEdit(project, {
        startMs: trimStartMs,
        durationMs: editedDurationMs,
        appearance: normalizeProjectAppearanceEdit(nextAppearance)
      });

      setProject(applyProjectEditLocally(project, nextEdit));

      try {
        const updatedProject = await persistProjectEdit(project, nextEdit);

        setProject(updatedProject);
      } catch (nextError) {
        setError(toErrorMessage(nextError));
        setStatus("error");
      }
    },
    [editedDurationMs, project, trimStartMs]
  );

  const updateAppearance = useCallback(
    (updates: Partial<ProjectAppearanceEdit>) => {
      void persistAppearanceEdit({
        ...appearance,
        ...updates
      });
    },
    [appearance, persistAppearanceEdit]
  );

  const seekPreviewToRawTime = useCallback(
    (rawTimeMs: number) => {
      if (!project) {
        return;
      }

      const safeTimeMs = clamp(rawTimeMs, trimStartMs, trimEndMs);
      const video = videoRef.current;

      if (video) {
        video.currentTime = safeTimeMs / 1000;
      }

      setPreviewTime(safeTimeMs);
    },
    [project, trimEndMs, trimStartMs]
  );

  const updateProjectTrimFromClientX = useCallback(
    (clientX: number, lane: HTMLElement, edge: "start" | "end", shouldCommit: boolean) => {
      if (!project) {
        return;
      }

      const rawTimeMs = getTimelineTimeFromClientX(clientX, lane, rawDurationMs);
      const minDurationMs = getMinimumProjectDurationMs(project);
      const currentStartMs = trimStartMs;
      const currentEndMs = trimEndMs;
      const nextStartMs =
        edge === "start" ? Math.round(clamp(rawTimeMs, 0, currentEndMs - minDurationMs)) : currentStartMs;
      const nextEndMs =
        edge === "end" ? Math.round(clamp(rawTimeMs, currentStartMs + minDurationMs, rawDurationMs)) : currentEndMs;
      const nextDurationMs = nextEndMs - nextStartMs;

      setLocalProjectTrim(nextStartMs, nextDurationMs);

      const nextPreviewTime = clamp(effectivePreviewTime, nextStartMs, nextEndMs);
      const video = videoRef.current;

      if (nextPreviewTime !== effectivePreviewTime) {
        if (video) {
          video.currentTime = nextPreviewTime / 1000;
        }

        setPreviewTime(nextPreviewTime);
      }

      if (shouldCommit) {
        void commitProjectTrim(nextStartMs, nextDurationMs);
      }
    },
    [
      commitProjectTrim,
      effectivePreviewTime,
      project,
      rawDurationMs,
      setLocalProjectTrim,
      trimEndMs,
      trimStartMs
    ]
  );

  const startTrimResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, edge: "start" | "end") => {
      const lane = event.currentTarget.closest(".editor-timeline-lane");

      if (!(lane instanceof HTMLElement)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      updateProjectTrimFromClientX(event.clientX, lane, edge, false);

      const handlePointerMove = (nextEvent: PointerEvent): void => {
        updateProjectTrimFromClientX(nextEvent.clientX, lane, edge, false);
      };
      const handlePointerUp = (nextEvent: PointerEvent): void => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        updateProjectTrimFromClientX(nextEvent.clientX, lane, edge, true);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [updateProjectTrimFromClientX]
  );

  const seekTimelineFromClientX = useCallback(
    (clientX: number, lane: HTMLElement) => {
      if (!project) {
        return;
      }

      seekPreviewToRawTime(getTimelineTimeFromClientX(clientX, lane, rawDurationMs));
    },
    [project, rawDurationMs, seekPreviewToRawTime]
  );

  const startExport = useCallback(async () => {
    if (!project) {
      return;
    }

    try {
      setError(null);
      setStatus("exporting");
      exportAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      exportAbortControllerRef.current = abortController;
      const projectForExport = await persistProjectEdit(
        project,
        createProjectEdit(project, {
          startMs: trimStartMs,
          durationMs: editedDurationMs,
          motion: motionEdit
        })
      );

      setProject(projectForExport);
      const job = await window.recorderApi.export.start({
        projectDir: projectForExport.projectDir,
        format: "mp4",
        preset: selectedExportPreset,
        outputPath: selectedExportTargetPath
      });

      setExportJob(job);
      await renderProjectToExport(
        job.id,
        projectForExport,
        trimStartMs,
        editedDurationMs,
        zoomPercent / 100,
        smoothness / 100,
        showCursorInExport,
        getProjectAppearanceEdit(projectForExport),
        abortController.signal,
        (progress) => {
          setExportJob((currentJob) => {
            if (!currentJob || currentJob.id !== job.id) {
              return currentJob;
            }

            return {
              ...currentJob,
              status: "rendering",
              progress: Math.max(currentJob.progress, progress)
            };
          });
        }
      );

      const finishedJob = await window.recorderApi.export.finish({ jobId: job.id });
      setExportJob(finishedJob);
      exportAbortControllerRef.current = null;
      const refreshedProject = await window.recorderApi.project.open({ projectDir: projectForExport.projectDir });

      setProject(refreshedProject);
      setStatus("preview");
      void refreshProjectSummaries();
    } catch (nextError) {
      exportAbortControllerRef.current = null;

      if (isExportCancelledError(nextError)) {
        setStatus("preview");
        return;
      }

      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }, [
    editedDurationMs,
    motionEdit,
    project,
    refreshProjectSummaries,
    selectedExportPreset,
    selectedExportTargetPath,
    showCursorInExport,
    smoothness,
    trimStartMs,
    zoomPercent
  ]);

  const cancelExport = useCallback(async () => {
    if (!exportJob) {
      return;
    }

    exportAbortControllerRef.current?.abort();

    try {
      const cancelledJob = await window.recorderApi.export.cancel({ jobId: exportJob.id });

      setExportJob(cancelledJob);
      setStatus("preview");
      setError(null);
      void refreshProjectSummaries();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }, [exportJob, refreshProjectSummaries]);

  const previewFrameStyle = previewFrame
    ? {
        aspectRatio: previewAspectRatio,
        borderRadius: `${previewFrame.radius}px`,
        boxShadow: getPreviewFrameShadow(appearance.frameShadow),
        height: `${previewFrame.height}px`,
        left: `${previewFrame.x}px`,
        top: `${previewFrame.y}px`,
        transform: "none",
        width: `${previewFrame.width}px`
      }
    : {
        aspectRatio: previewAspectRatio,
        boxShadow: getPreviewFrameShadow(appearance.frameShadow)
      };
  const previewStageWidth =
    previewSlotSize.width && previewSlotSize.height
      ? Math.min(previewSlotSize.width, previewSlotSize.height * previewAspectRatioValue, 1040)
      : 0;
  const previewStageStyle = previewStageWidth
    ? {
        aspectRatio: previewAspectRatio,
        height: `${previewStageWidth / previewAspectRatioValue}px`,
        width: `${previewStageWidth}px`
      }
    : {
        aspectRatio: previewAspectRatio
      };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Aperture size={18} />
          </div>
          <div>
            <strong>Recorder</strong>
            <span>v{version}</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          <button
            className={`nav-item ${activeView === "studio" ? "active" : ""}`}
            type="button"
            onClick={() => setActiveView("studio")}
          >
            <Video size={18} />
            Studio
          </button>
          <button
            className={`nav-item ${activeView === "projects" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("projects");
              void refreshProjectSummaries();
            }}
          >
            <Clapperboard size={18} />
            Projects
          </button>
          <button
            className={`nav-item ${activeView === "exports" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("exports");
              void refreshProjectSummaries();
            }}
          >
            <Download size={18} />
            Exports
          </button>
          <button
            className={`nav-item ${activeView === "settings" ? "active" : ""}`}
            type="button"
            onClick={() => setActiveView("settings")}
          >
            <Settings size={18} />
            Settings
          </button>
        </nav>

        <div className="system-panel">
          <span>Engine</span>
          <strong>{environment?.nativeEngine.status ?? "planned"}</strong>
          <small>{environmentLabel}</small>
        </div>
      </aside>

      <section className={`workspace ${activeView === "studio" ? "" : "product-view-workspace"}`}>
        <header className="topbar">
          <button
            className="source-select capture-setup-button"
            type="button"
            onClick={() => void openCaptureSetup()}
            disabled={!canOpenCaptureSetup || isPickingCaptureTarget}
          >
            <Monitor size={17} />
            <div className="capture-setup-summary">
              <strong>{captureSetupSummary}</strong>
              <span>{plannedCaptureEngineLabel} - {isPickingCaptureTarget ? "Opening external picker..." : captureAudioSummary}</span>
            </div>
            <ChevronDown size={16} aria-hidden />
          </button>

          <div className="toolbar-actions">
            <span className={`status-pill ${status}`}>{getRecorderStatusLabel(status, countdownRemaining)}</span>
            <button className="icon-button" type="button" aria-label="Trim" onClick={focusTrimTimeline}>
              <Scissors size={17} />
            </button>
            <button
              className={`icon-button ${isPlaybackPanelOpen ? "active" : ""}`}
              type="button"
              aria-label="Playback settings"
              onClick={() => setIsPlaybackPanelOpen((current) => !current)}
            >
              <SlidersHorizontal size={17} />
            </button>
            {isPlaybackPanelOpen ? (
              <div className="playback-popover">
                <strong>Playback</strong>
                <div className="rate-grid">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      className={appSettings.playbackRate === rate ? "selected" : ""}
                      key={rate}
                      type="button"
                      onClick={() => void updateSettings({ playbackRate: rate })}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
                <label>
                  <input
                    checked={appSettings.loopPreview}
                    type="checkbox"
                    onChange={(event) => void updateSettings({ loopPreview: event.target.checked })}
                  />
                  Loop preview
                </label>
                <label>
                  <input
                    checked={appSettings.showCursor}
                    type="checkbox"
                    onChange={(event) => void updateSettings({ showCursor: event.target.checked })}
                  />
                  Custom cursor
                </label>
              </div>
            ) : null}
            {canPause ? (
              <button className="secondary-button toolbar-action-button" type="button" onClick={() => void pauseRecording()}>
                <Pause size={16} />
                Pause
              </button>
            ) : null}
            {canResume ? (
              <button className="secondary-button toolbar-action-button" type="button" onClick={() => void resumeRecording()}>
                <Play size={16} />
                Resume
              </button>
            ) : null}
            {canStop ? (
              <button className="stop-button" type="button" onClick={stopRecording}>
                <Square size={18} />
                {status === "countdown" ? "Cancel" : "Stop"}
              </button>
            ) : (
              <button
                className="record-button"
                type="button"
                onClick={startRecording}
                disabled={!canRecord}
              >
                <CircleDot size={18} />
                Record
              </button>
            )}
          </div>
        </header>

        {activeView === "studio" ? (
          <>
        <section className="content-grid">
          <section className="preview-area" aria-label="Video preview">
            <div className="preview-stage-slot" ref={previewSlotRef}>
              <div className="preview-stage" ref={previewStageRef} style={previewStageStyle}>
                <div
                  className={`motion-frame background-${appearance.backgroundPreset}`}
                  style={{
                    background: getPreviewBackground(appearance.backgroundPreset),
                    transform: `scale(${motion.zoom})`,
                    transformOrigin: `${previewCompositionFocus.xPct}% ${previewCompositionFocus.yPct}%`
                  }}
                >
                  <div className="screen-frame real-preview" style={previewFrameStyle}>
                    <div className="video-motion-layer">
                      {canPreview ? (
                        <video
                          key={project?.captureUrl ?? "preview"}
                          ref={videoRef}
                          className="preview-video"
                          src={project?.captureUrl}
                          crossOrigin="anonymous"
                          preload="metadata"
                          muted
                          playsInline
                          controls={false}
                          onLoadedMetadata={() => {
                            if (videoRef.current && project) {
                              videoRef.current.currentTime = trimStartMs / 1000;
                              setPreviewTime(trimStartMs);
                              return;
                            }

                            setPreviewTime(0);
                          }}
                          onError={() => {
                            const message = videoRef.current
                              ? getVideoErrorMessage(videoRef.current)
                              : "Could not load preview video.";
                            setError(message);
                          }}
                        />
                      ) : (
                        <div className="capture-grid" />
                      )}
                    </div>
                    {appSettings.showCursor && motion.hasCursor ? (
                      <div
                        className={`cursor-orbit ${appearance.cursorStyle}`}
                        style={{ left: `${motion.xPct}%`, top: `${motion.yPct}%` }}
                      >
                        {appearance.cursorStyle === "soft-dot" ? (
                          <span className="cursor-dot" />
                        ) : (
                          <MousePointer2 size={26} />
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
                {countdownRemaining !== null ? (
                  <div className="recording-overlay countdown-overlay">
                    <strong>{countdownRemaining}</strong>
                    <span>Recording starts in...</span>
                  </div>
                ) : null}
                {status === "paused" ? (
                  <div className="recording-overlay paused-overlay">
                    <strong>Paused</strong>
                    <span>Resume when you are ready to keep recording.</span>
                  </div>
                ) : null}
                {(status === "recording" || status === "processing") && !project ? (
                  <div className="recording-overlay paused-overlay">
                    <strong>{status === "processing" ? "Finishing capture" : "Recording in progress"}</strong>
                    <span>Live preview is disabled while cursor-free native capture is active.</span>
                  </div>
                ) : null}
                <div className="zoom-frame">
                  <Sparkles size={16} />
                  {activeMode === "auto" ? "Auto zoom" : "Manual motion"}
                </div>
                {!project && status === "idle" ? (
                  <div className="empty-state">
                    <Video size={34} />
                    <strong>Ready to record</strong>
                    <span>Choose your source, confirm the external overlay, then press Record.</span>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="transport">
              <button
                className="icon-button"
                type="button"
                aria-label="Play preview"
                onClick={playPreview}
                disabled={!canPreview}
              >
                <Play size={18} />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Pause preview"
                onClick={pausePreview}
                disabled={!canPreview}
              >
                <Pause size={18} />
              </button>
              <div className="timecode">
                {status === "recording" || status === "paused"
                  ? formatTime(recordingElapsed)
                  : formatTime(previewOffsetMs)}
              </div>
              <div className="scrub-track">
                <span
                  style={{
                    width: `${project ? getDurationPercent(previewOffsetMs, editedDurationMs) : 0}%`
                  }}
                />
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Stop preview"
                onClick={pausePreview}
                disabled={!canPreview}
              >
                <Square size={17} />
              </button>
            </div>
          </section>

          <aside className="inspector" aria-label="Recording settings">
            <section className="panel">
              <div className="panel-title">
                <Gauge size={17} />
                Capture
              </div>
              <div className="capture-mode-grid">
                {CAPTURE_TARGETS.map((target) => (
                  <button
                    className={`capture-mode-button ${captureTargetKind === target.value ? "selected" : ""}`}
                    key={target.value}
                    type="button"
                    disabled={status === "recording" || status === "paused" || status === "countdown" || isPickingCaptureTarget}
                    onClick={() => {
                      setCaptureTargetKind(target.value);
                      setCaptureSelection((current) => (current?.targetKind === target.value ? current : null));
                    }}
                  >
                    <strong>{target.label}</strong>
                    <span>{target.description}</span>
                  </button>
                ))}
              </div>
              <label>
                FPS
                <input
                  type="number"
                  min="24"
                  max="120"
                  value={fps}
                  disabled={status === "recording" || status === "paused" || status === "countdown"}
                  onChange={(event) => {
                    const nextFps = Number(event.target.value);
                    setFps(nextFps);
                    void updateSettings({ fps: nextFps });
                  }}
                />
              </label>
              <label>
                Quality
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={quality}
                  disabled={status === "recording" || status === "paused" || status === "countdown"}
                  onChange={(event) => {
                    const nextQuality = Number(event.target.value);
                    setQuality(nextQuality);
                    void updateSettings({ quality: nextQuality });
                  }}
                />
              </label>
              <div className="path-preview">
                <strong>Capture setup</strong>
                <span>{captureSetupSummary}</span>
                <span>{plannedCaptureEngineLabel} - {captureAudioSummary}</span>
                <span>Selection UI: external overlay</span>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void openCaptureSetup()}
                disabled={!canOpenCaptureSetup || isPickingCaptureTarget}
              >
                {captureSelection ? "Change setup..." : "Choose source..."}
              </button>
              <div className="notice-box capture-audio-frozen">
                Audio capture is temporarily disabled in this stabilization phase so screen, region and window capture stay cursor-free.
              </div>
              <label>
                Export preset
                <select
                  value={selectedExportPreset}
                  disabled={!project || status === "exporting"}
                  onChange={(event) => setSelectedExportPreset(event.target.value as ExportPreset)}
                >
                  {EXPORT_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="path-preview">
                <strong>Destination</strong>
                <span>{selectedExportTargetPath || "Choose a project to enable export."}</span>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void pickExportOutputPath()}
                disabled={!project || status === "exporting"}
              >
                Change...
              </button>
              <button
                className="export-button"
                type="button"
                onClick={startExport}
                disabled={!canExport}
              >
                <Download size={17} />
                Export MP4
              </button>
              {canCancelExport ? (
                <button className="motion-action-button subtle-danger" type="button" onClick={() => void cancelExport()}>
                  Cancel export
                </button>
              ) : null}
              {exportJob ? (
                <div className="export-progress">
                  <span>{getExportStatusLabel(exportJob)}</span>
                  <strong>{Math.round(exportJob.progress * 100)}%</strong>
                  <i>
                    <span style={{ width: `${exportJob.progress * 100}%` }} />
                  </i>
                </div>
              ) : null}
            </section>

            <section className="panel">
              <div className="panel-title">
                <MousePointer2 size={17} />
                Motion
              </div>
              <div className="segmented-control" aria-label="Zoom mode">
                <button
                  className={activeMode === "auto" ? "selected" : ""}
                  type="button"
                  onClick={() => updateMotionMode("auto")}
                >
                  Auto
                </button>
                <button
                  className={activeMode === "manual" ? "selected" : ""}
                  type="button"
                  onClick={() => updateMotionMode("manual")}
                >
                  Manual
                </button>
              </div>
              <label>
                Zoom
                <input
                  type="range"
                  min="100"
                  max="240"
                  value={zoomPercent}
                  onChange={(event) => {
                    const nextZoomPercent = Number(event.target.value);
                    setZoomPercent(nextZoomPercent);
                    void updateSettings({ zoomPercent: nextZoomPercent });
                  }}
                />
              </label>
              <label>
                Smooth
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={smoothness}
                  onChange={(event) => {
                    const nextSmoothness = Number(event.target.value);
                    setSmoothness(nextSmoothness);
                    void updateSettings({ smoothness: nextSmoothness });
                  }}
                />
              </label>
              {activeMode === "manual" ? (
                <div className="manual-motion-actions">
                  <button
                    className="motion-action-button"
                    type="button"
                    onClick={upsertManualZoomAtPlayhead}
                    disabled={!project}
                  >
                    {editableMotionSegment ? "Update zoom here" : "Add zoom here"}
                  </button>
                  {editableMotionSegment ? (
                    <button className="motion-action-button subtle-danger" type="button" onClick={removeManualZoomAtPlayhead}>
                      Remove zoom
                    </button>
                  ) : null}
                  <small>
                    {motionEdit.manualZooms.length} manual zoom{motionEdit.manualZooms.length === 1 ? "" : "s"}
                  </small>
                </div>
              ) : null}
              <label className="motion-check-row">
                <input
                  checked={showCursorInExport}
                  type="checkbox"
                  onChange={(event) => updateExportCursorForProject(event.target.checked)}
                  disabled={!project}
                />
                Cursor in export
              </label>
              {editableMotionSegment ? (
                <div className="motion-segment-editor">
                  <strong>{activeMode === "auto" ? "Click zoom" : "Manual zoom"}</strong>
                  <label>
                    Start
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={formatSecondsInput(getMotionSegmentStartMs(editableMotionSegment))}
                      onChange={(event) => {
                        const startMs = Number(event.target.value) * 1000;
                        updateEditableMotionSegment({
                          anchorMs: getAnchorFromStartMs(editableMotionSegment, startMs)
                        });
                      }}
                    />
                  </label>
                  <label>
                    Duration
                    <input
                      type="number"
                      min="1"
                      step="0.1"
                      value={formatSecondsInput(editableMotionSegment.durationMs)}
                      onChange={(event) => updateEditableMotionSegment({ durationMs: Number(event.target.value) * 1000 })}
                    />
                  </label>
                  <label>
                    Segment zoom
                    <input
                      type="range"
                      min="100"
                      max="240"
                      value={Math.round(editableMotionSegment.zoom * 100)}
                      onChange={(event) => updateEditableMotionSegment({ zoom: Number(event.target.value) / 100 })}
                    />
                  </label>
                  <label>
                    Segment smooth
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={editableMotionSegment.smoothness ?? smoothness}
                      onChange={(event) => updateEditableMotionSegment({ smoothness: Number(event.target.value) })}
                    />
                  </label>
                </div>
              ) : (
                <div className="motion-segment-empty">No zoom selected</div>
              )}
            </section>

            <section className="panel">
              <div className="panel-title">
                <Palette size={17} />
                Appearance
              </div>
              <label>
                Background
                <select
                  value={appearance.backgroundPreset}
                  disabled={!project}
                  onChange={(event) => updateAppearance({ backgroundPreset: event.target.value as BackgroundPreset })}
                >
                  {BACKGROUND_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Screen size
                <input
                  type="range"
                  min="70"
                  max="94"
                  value={appearance.frameScale}
                  disabled={!project}
                  onChange={(event) => updateAppearance({ frameScale: Number(event.target.value) })}
                />
              </label>
              <label>
                Corners
                <input
                  type="range"
                  min="0"
                  max="48"
                  value={appearance.frameRadius}
                  disabled={!project}
                  onChange={(event) => updateAppearance({ frameRadius: Number(event.target.value) })}
                />
              </label>
              <label>
                Shadow
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={appearance.frameShadow}
                  disabled={!project}
                  onChange={(event) => updateAppearance({ frameShadow: Number(event.target.value) })}
                />
              </label>
              <label>
                Cursor style
                <select
                  value={appearance.cursorStyle}
                  disabled={!project}
                  onChange={(event) => updateAppearance({ cursorStyle: event.target.value as CursorStyle })}
                >
                  {CURSOR_STYLES.map((cursorStyle) => (
                    <option key={cursorStyle.value} value={cursorStyle.value}>
                      {cursorStyle.label}
                    </option>
                  ))}
                </select>
              </label>
            </section>

            {project ? (
              <section className="panel project-panel">
                <div className="panel-title">
                  <Clapperboard size={17} />
                  Project
                </div>
                <span>{project.manifest.id}</span>
                <small>{project.projectDir}</small>
                <strong>
                  {selectedExportEntry?.exists ? `${getExportPresetLabel(selectedExportPreset)} ready` : "No export for preset yet"}
                </strong>
                <div className="export-history">
                  <div className="export-history-header">
                    <span>Export history</span>
                    <small>{projectExportHistory.length} file{projectExportHistory.length === 1 ? "" : "s"}</small>
                  </div>
                  {projectExportHistory.length ? (
                    projectExportHistory.map((entry) => (
                      <div className="export-history-item" key={entry.id}>
                        <div>
                          <strong>{getProjectExportLabel(entry)}</strong>
                          <small>{entry.outputPath}</small>
                        </div>
                        <div className="project-actions">
                          <button
                            type="button"
                            onClick={() => void openExportFile(project.projectDir, entry.id)}
                          >
                            Open MP4
                          </button>
                          <button
                            type="button"
                            onClick={() => void openExportFolder(project.projectDir, entry.id)}
                          >
                            Open folder
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="motion-segment-empty">No exports yet</div>
                  )}
                </div>
              </section>
            ) : null}

            {notice ? <div className="notice-box">{notice}</div> : null}
            {error ? <div className="error-box">{error}</div> : null}
          </aside>
        </section>

        <section
          className={`timeline ${isTimelineFocused ? "focused" : ""}`}
          aria-label="Timeline"
          ref={timelineRef}
        >
          <div className="timeline-header">
            <div>
              <strong>Timeline</strong>
              <span>{project ? "Click to seek. Drag clip edges to trim." : "No project"}</span>
            </div>
            <span>
              {project
                ? `${formatTime(effectivePreviewTime)} / ${formatTime(rawDurationMs)} - clip ${formatTime(editedDurationMs)}`
                : "No project"}
            </span>
          </div>
          <div className="editor-timeline">
            <div className="time-ruler" aria-hidden="true">
              <span>00:00</span>
              <span>{project ? formatTime(rawDurationMs / 2) : "--:--"}</span>
              <span>{project ? formatTime(rawDurationMs) : "--:--"}</span>
            </div>
            <div
              className="editor-timeline-lane"
              role="slider"
              tabIndex={project ? 0 : -1}
              aria-label="Timeline playhead"
              aria-valuemin={0}
              aria-valuemax={Math.round(rawDurationMs)}
              aria-valuenow={Math.round(effectivePreviewTime)}
              onPointerDown={(event) => {
                if (!project || event.button !== 0) {
                  return;
                }

                seekTimelineFromClientX(event.clientX, event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (!project) {
                  return;
                }

                if (event.key === "Home") {
                  event.preventDefault();
                  seekPreviewToRawTime(trimStartMs);
                  return;
                }

                if (event.key === "End") {
                  event.preventDefault();
                  seekPreviewToRawTime(trimEndMs);
                  return;
                }

                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  seekPreviewToRawTime(effectivePreviewTime + (event.key === "ArrowRight" ? 100 : -100));
                }
              }}
            >
              {project ? (
                <>
                  <div
                    className="editor-clip"
                    style={{
                      left: `${getDurationPercent(trimStartMs, rawDurationMs)}%`,
                      width: `${getDurationPercent(editedDurationMs, rawDurationMs)}%`
                    }}
                  >
                    <span>Video</span>
                    <small>{formatTime(editedDurationMs)}</small>
                    <button
                      className="clip-resize-handle start"
                      type="button"
                      aria-label="Trim clip start"
                      onPointerDown={(event) => startTrimResize(event, "start")}
                    />
                    <button
                      className="clip-resize-handle end"
                      type="button"
                      aria-label="Trim clip end"
                      onPointerDown={(event) => startTrimResize(event, "end")}
                    />
                  </div>
                  <i
                    className="editor-playhead"
                    style={{ left: `${getDurationPercent(effectivePreviewTime, rawDurationMs)}%` }}
                  />
                </>
              ) : null}
            </div>
          </div>
          <div className="tracks">
            {timelineTracks.map((track) => (
              <div className="track" key={track.label}>
                <span>{track.label}</span>
                <div className="track-lane">
                  {track.blocks.map((block, index) => (
                    block.id ? (
                      <button
                        aria-label={`${track.label} segment`}
                        className={`track-block ${block.selected ? "selected" : ""}`}
                        key={`${track.label}-${block.id}`}
                        style={{ left: block.left, width: block.width }}
                        type="button"
                        onClick={() => setSelectedMotionSegmentId(block.id ?? null)}
                      />
                    ) : (
                      <i key={`${track.label}-${index}`} style={block} />
                    )
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
          </>
        ) : (
          <ProductView
            activeView={activeView}
            appSettings={appSettings}
            error={error}
            exportArtifacts={exportArtifacts}
            onOpenExportFile={openExportFile}
            onOpenExportFolder={openExportFolder}
            onOpenProject={openProjectSummary}
            onOpenProjectFolder={openProjectFolder}
            onPickDefaultExportDirectory={pickDefaultExportDirectory}
            onRefreshProjects={refreshProjectSummaries}
            onUpdateSettings={updateSettings}
            projectSummaries={projectSummaries}
          />
        )}
      </section>
    </main>
  );
}

type ProductViewProps = {
  activeView: WorkspaceView;
  appSettings: AppSettings;
  error: string | null;
  exportArtifacts: ExportListItem[];
  projectSummaries: ProjectSummary[];
  onOpenExportFile: (projectDir: string, exportId: ProjectExportId) => Promise<void>;
  onOpenExportFolder: (projectDir: string, exportId: ProjectExportId) => Promise<void>;
  onOpenProject: (project: ProjectSummary) => Promise<void>;
  onOpenProjectFolder: (projectDir: string) => Promise<void>;
  onPickDefaultExportDirectory: () => Promise<void>;
  onRefreshProjects: () => Promise<void>;
  onUpdateSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
};

function ProductView({
  activeView,
  appSettings,
  error,
  exportArtifacts,
  onOpenExportFile,
  onOpenExportFolder,
  onOpenProject,
  onOpenProjectFolder,
  onPickDefaultExportDirectory,
  onRefreshProjects,
  onUpdateSettings,
  projectSummaries
}: ProductViewProps): ReactElement {
  const errorNotice = error ? <div className="error-box product-error">{error}</div> : null;

  if (activeView === "projects") {
    return (
      <section className="product-page">
        <div className="product-page-header">
          <div>
            <strong>Projects</strong>
            <span>{projectSummaries.length} local recording{projectSummaries.length === 1 ? "" : "s"}</span>
          </div>
          <button className="secondary-button" type="button" onClick={() => void onRefreshProjects()}>
            Refresh
          </button>
        </div>
        {errorNotice}
        <div className="project-list">
          {projectSummaries.length ? (
            projectSummaries.map((summary) => (
              <article className="project-card" key={summary.id}>
                <div>
                  <strong>{summary.sourceName}</strong>
                  <span>{formatDateTime(summary.createdAt)}</span>
                  <small>{summary.projectDir}</small>
                </div>
                <div className="project-meta">
                  <span>{formatTime(summary.editedDurationMs)}</span>
                  <span>{summary.hasExport ? "MP4 ready" : "No export"}</span>
                </div>
                <div className="project-actions">
                  <button type="button" onClick={() => void onOpenProject(summary)}>
                    Open
                  </button>
                  <button type="button" onClick={() => void onOpenProjectFolder(summary.projectDir)}>
                    Folder
                  </button>
                </div>
              </article>
            ))
          ) : (
            <EmptyProductState title="No projects yet" text="Record your first clip in Studio." />
          )}
        </div>
      </section>
    );
  }

  if (activeView === "exports") {
    return (
      <section className="product-page">
        <div className="product-page-header">
          <div>
            <strong>Exports</strong>
            <span>{exportArtifacts.length} export file{exportArtifacts.length === 1 ? "" : "s"}</span>
          </div>
          <button className="secondary-button" type="button" onClick={() => void onRefreshProjects()}>
            Refresh
          </button>
        </div>
        {errorNotice}
        <div className="project-list">
          {exportArtifacts.length ? (
            exportArtifacts.map((artifact) => (
              <article className="project-card" key={`${artifact.projectId}-${artifact.entry.id}`}>
                <div>
                  <strong>{artifact.sourceName}</strong>
                  <span>{getProjectExportLabel(artifact.entry)}</span>
                  <small>{artifact.entry.outputPath}</small>
                </div>
                <div className="project-meta">
                  <span>{formatTime(artifact.editedDurationMs)}</span>
                  <span>{formatDateTime(artifact.entry.lastExportedAt ?? artifact.createdAt)}</span>
                </div>
                <div className="project-actions">
                  <button type="button" onClick={() => void onOpenExportFile(artifact.projectDir, artifact.entry.id)}>
                    Open MP4
                  </button>
                  <button type="button" onClick={() => void onOpenExportFolder(artifact.projectDir, artifact.entry.id)}>
                    Open folder
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const summary = projectSummaries.find((item) => item.projectDir === artifact.projectDir);

                      if (summary) {
                        void onOpenProject(summary);
                      }
                    }}
                  >
                    Project
                  </button>
                </div>
              </article>
            ))
          ) : (
            <EmptyProductState title="No exports yet" text="Export a project from Studio to see it here." />
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="product-page settings-page">
      <div className="product-page-header">
        <div>
          <strong>Settings</strong>
          <span>Global defaults for recording, preview, motion, and export.</span>
        </div>
      </div>
      {errorNotice}
      <div className="settings-grid">
        <section className="settings-panel">
          <div className="panel-title">
            <Play size={17} />
            Playback
          </div>
          <label>
            Speed
            <select
              value={appSettings.playbackRate}
              onChange={(event) => void onUpdateSettings({ playbackRate: Number(event.target.value) as PlaybackRate })}
            >
              {PLAYBACK_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}x
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input
              checked={appSettings.loopPreview}
              type="checkbox"
              onChange={(event) => void onUpdateSettings({ loopPreview: event.target.checked })}
            />
            Loop preview
          </label>
          <label className="check-row">
            <input
              checked={appSettings.showCursor}
              type="checkbox"
              onChange={(event) => void onUpdateSettings({ showCursor: event.target.checked })}
            />
            Show custom cursor
          </label>
        </section>
        <section className="settings-panel">
          <div className="panel-title">
            <Gauge size={17} />
            Capture defaults
          </div>
          <label>
            FPS
            <input
              max="120"
              min="24"
              type="number"
              value={appSettings.fps}
              onChange={(event) => void onUpdateSettings({ fps: Number(event.target.value) })}
            />
          </label>
          <label>
            Quality
            <input
              max="100"
              min="1"
              type="range"
              value={appSettings.quality}
              onChange={(event) => void onUpdateSettings({ quality: Number(event.target.value) })}
            />
          </label>
        </section>
        <section className="settings-panel">
          <div className="panel-title">
            <MousePointer2 size={17} />
            Motion defaults
          </div>
          <label>
            Zoom
            <input
              max="240"
              min="100"
              type="range"
              value={appSettings.zoomPercent}
              onChange={(event) => void onUpdateSettings({ zoomPercent: Number(event.target.value) })}
            />
          </label>
          <label>
            Smooth
            <input
              max="100"
              min="0"
              type="range"
              value={appSettings.smoothness}
              onChange={(event) => void onUpdateSettings({ smoothness: Number(event.target.value) })}
            />
          </label>
        </section>
        <section className="settings-panel">
          <div className="panel-title">
            <Download size={17} />
            Export defaults
          </div>
          <div className="path-preview settings-path-preview">
            <strong>Default folder</strong>
            <span>{appSettings.defaultExportDirectory}</span>
          </div>
          <button className="secondary-button" type="button" onClick={() => void onPickDefaultExportDirectory()}>
            Choose folder...
          </button>
        </section>
      </div>
    </section>
  );
}

function EmptyProductState({ title, text }: { title: string; text: string }): ReactElement {
  return (
    <div className="empty-product-state">
      <Clapperboard size={28} />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function buildDefaultExportTargetPath(
  project: OpenedProject,
  preset: ExportPreset,
  defaultExportDirectory: string
): string {
  const safeSourceName = project.manifest.source.name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const baseName = safeSourceName || "recording";

  return [defaultExportDirectory, `${baseName}-${project.manifest.id}-${preset}.mp4`].filter(Boolean).join("\\");
}

function isExportCancelledError(error: unknown): boolean {
  return toErrorMessage(error).toLowerCase().includes("export cancelled");
}

function getBestWebmMimeType(): string {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "video/webm";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getRecorderStatusLabel(status: RecorderStatus, countdownRemaining: number | null): string {
  if (status === "countdown") {
    return countdownRemaining ? `countdown ${countdownRemaining}s` : "countdown";
  }

  return status;
}

function getCaptureTargetLabel(targetKind: CaptureTargetKind): string {
  switch (targetKind) {
    case "window":
      return "Window";
    case "region":
      return "Region";
    default:
      return "Screen";
  }
}

function getExportRenderBitrate(width: number, height: number): number {
  const targetBitrate = width * height * EXPORT_RENDER_FPS * 0.32;

  return Math.round(clamp(targetBitrate, EXPORT_MIN_BITRATE, EXPORT_MAX_BITRATE));
}

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((ms % 1000) / 10);

  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${centiseconds.toString().padStart(2, "0")}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function applyAppSettings(
  settings: AppSettings,
  setters: {
    setAppSettings: (settings: AppSettings) => void;
    setFps: (value: number) => void;
    setQuality: (value: number) => void;
    setSmoothness: (value: number) => void;
    setZoomPercent: (value: number) => void;
  }
): void {
  setters.setAppSettings(settings);
  setters.setFps(settings.fps);
  setters.setQuality(settings.quality);
  setters.setSmoothness(settings.smoothness);
  setters.setZoomPercent(settings.zoomPercent);
}

function getEditedProjectDurationMs(project: OpenedProject): number {
  const startMs = getProjectTrimStartMs(project);

  return getSafeEditedDurationMs(project, project.manifest.edit?.durationMs ?? project.timeline.durationMs - startMs, startMs);
}

function getProjectTrimStartMs(project: OpenedProject): number {
  return getSafeProjectTrimStartMs(project, project.manifest.edit?.startMs ?? 0);
}

function getMinimumProjectDurationMs(project: OpenedProject): number {
  return Math.min(1_000, Math.max(1, project.timeline.durationMs));
}

function getSafeProjectTrimStartMs(project: OpenedProject, startMs: number): number {
  const maxStartMs = Math.max(0, project.timeline.durationMs - getMinimumProjectDurationMs(project));

  return Math.round(clamp(startMs, 0, maxStartMs));
}

function getSafeEditedDurationMs(project: OpenedProject, durationMs: number, startMs = getProjectTrimStartMs(project)): number {
  const maxDurationMs = Math.max(1, project.timeline.durationMs - startMs);
  const minDurationMs = Math.min(1_000, maxDurationMs);

  return Math.round(clamp(durationMs, minDurationMs, maxDurationMs));
}

function getDurationPercent(valueMs: number, durationMs: number): number {
  return clamp((valueMs / Math.max(1, durationMs)) * 100, 0, 100);
}

function getTimelineTimeFromClientX(clientX: number, lane: HTMLElement, durationMs: number): number {
  const rect = lane.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);

  return ratio * durationMs;
}

function createProjectEdit(project: OpenedProject, edit: Partial<ProjectEdit>): ProjectEdit {
  const startMs = getSafeProjectTrimStartMs(project, edit.startMs ?? project.manifest.edit?.startMs ?? 0);

  return {
    ...project.manifest.edit,
    ...edit,
    startMs,
    durationMs: getSafeEditedDurationMs(project, edit.durationMs ?? project.manifest.edit?.durationMs ?? project.timeline.durationMs - startMs, startMs),
    motion: edit.motion ?? project.manifest.edit?.motion,
    appearance: edit.appearance ?? project.manifest.edit?.appearance
  };
}

async function persistProjectEdit(project: OpenedProject, edit: ProjectEdit): Promise<OpenedProject> {
  const updateEdit = window.recorderApi.project.updateEdit;
  const localProject = applyProjectEditLocally(project, edit);

  if (typeof updateEdit !== "function") {
    console.warn("project.updateEdit is not available in this Electron preload. Restart the app to persist edits.");
    return localProject;
  }

  try {
    return await updateEdit({
      projectDir: project.projectDir,
      edit
    });
  } catch (error) {
    if (toErrorMessage(error).includes("project:update-edit")) {
      console.warn("project.updateEdit IPC is not available in this Electron main process. Restart the app to persist edits.");
      return localProject;
    }

    throw error;
  }
}

function applyProjectEditLocally(project: OpenedProject, edit: ProjectEdit): OpenedProject {
  return {
    ...project,
    manifest: {
      ...project.manifest,
      edit
    }
  };
}

function createDefaultProjectMotionEdit(mode: "auto" | "manual" = "auto"): ProjectMotionEdit {
  return {
    mode,
    autoZooms: [],
    manualZooms: []
  };
}

function getProjectMotionEdit(project: OpenedProject, fallbackMode: "auto" | "manual"): ProjectMotionEdit {
  const motion = project.manifest.edit?.motion;

  if (!motion) {
    return createDefaultProjectMotionEdit(fallbackMode);
  }

  return {
    mode: motion.mode === "manual" ? "manual" : "auto",
    autoZooms: sortManualZooms(motion.autoZooms ?? []),
    manualZooms: sortManualZooms(motion.manualZooms ?? []),
    showCursorInExport: motion.showCursorInExport
  };
}

function getProjectAppearanceEdit(project: OpenedProject): ProjectAppearanceEdit {
  return normalizeProjectAppearanceEdit(project.manifest.edit?.appearance ?? DEFAULT_PROJECT_APPEARANCE);
}

function normalizeProjectAppearanceEdit(appearance: Partial<ProjectAppearanceEdit>): ProjectAppearanceEdit {
  const backgroundPreset =
    appearance.backgroundPreset && BACKGROUND_PRESETS.some((preset) => preset.value === appearance.backgroundPreset)
      ? appearance.backgroundPreset
      : DEFAULT_PROJECT_APPEARANCE.backgroundPreset;
  const cursorStyle =
    appearance.cursorStyle && CURSOR_STYLES.some((style) => style.value === appearance.cursorStyle)
      ? appearance.cursorStyle
      : DEFAULT_PROJECT_APPEARANCE.cursorStyle;

  return {
    backgroundPreset,
    frameScale: Math.round(clamp(appearance.frameScale ?? DEFAULT_PROJECT_APPEARANCE.frameScale, 70, 94)),
    frameRadius: Math.round(clamp(appearance.frameRadius ?? DEFAULT_PROJECT_APPEARANCE.frameRadius, 0, 48)),
    frameShadow: Math.round(clamp(appearance.frameShadow ?? DEFAULT_PROJECT_APPEARANCE.frameShadow, 0, 100)),
    cursorStyle
  };
}

function createManualZoomSegmentId(): string {
  return `zoom-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function sortManualZooms(segments: ManualZoomSegment[]): ManualZoomSegment[] {
  return [...segments].sort((left, right) => left.anchorMs - right.anchorMs);
}

function getMotionExportCursor(motion: ProjectMotionEdit, fallback: boolean): boolean {
  return motion.showCursorInExport ?? fallback;
}

function formatSecondsInput(ms: number): string {
  return (Math.round(ms / 100) / 10).toString();
}

function getExportPresetLabel(preset: ExportPreset): string {
  return EXPORT_PRESETS.find((item) => item.value === preset)?.label ?? preset;
}

function getProjectExportLabel(entry: ProjectExportEntry): string {
  return entry.isLegacy ? "Legacy export" : getExportPresetLabel(entry.preset as ExportPreset);
}

function getExportStatusLabel(job: ExportJob): string {
  if (job.status === "rendering") {
    return "Rendering preview";
  }

  if (job.status === "encoding") {
    return "Encoding MP4";
  }

  if (job.status === "done") {
    return "MP4 ready";
  }

  if (job.status === "cancelled") {
    return "Export cancelled";
  }

  return "Export failed";
}

function createEmptyTimelineTracks(): TimelineTrack[] {
  return [
    { label: "Video", blocks: [] },
    { label: "Cursor", blocks: [] },
    { label: "Zoom", blocks: [] }
  ];
}

function createTimelineTracks(
  timeline: Timeline,
  trimStartMs: number,
  editedDurationMs: number,
  motionSegments: ManualZoomSegment[],
  selectedSegmentId: string | null
): TimelineTrack[] {
  const duration = Math.max(1, timeline.durationMs);
  const cursorBlocks = timeline.events
    .filter((event, index) => event.type === "move" && event.t <= duration && index % 30 === 0)
    .slice(0, 40)
    .map((event) => ({
      left: `${Math.min(99, (event.t / duration) * 100)}%`,
      width: "1.4%"
    }));

  return [
    {
      label: "Video",
      blocks: [
        {
          left: `${getDurationPercent(trimStartMs, duration)}%`,
          width: `${getDurationPercent(editedDurationMs, duration)}%`
        }
      ]
    },
    { label: "Cursor", blocks: cursorBlocks },
    {
      label: "Zoom",
      blocks: createMotionZoomTrackBlocks(motionSegments, duration, selectedSegmentId)
    }
  ];
}

function computeMotionState(
  timeline: Timeline,
  cursorPath: SmoothedCursorPath,
  timeMs: number,
  zoomTarget: number,
  smoothness: number,
  motionEdit: ProjectMotionEdit
): MotionState {
  const cursor = findCursorPointAtTime(cursorPath, timeMs);

  if (!cursor) {
    return DEFAULT_MOTION;
  }

  const bounds = timeline.source.bounds;
  const xPct = clamp(((cursor.x - bounds.x) / bounds.width) * 100, 0, 100);
  const yPct = clamp(((cursor.y - bounds.y) / bounds.height) * 100, 0, 100);
  const segments = getMotionSegmentsForMode(timeline, motionEdit, zoomTarget, smoothness * 100, timeline.durationMs);
  const zoom = computeMotionZoom(segments, timeMs, smoothness * 100);

  return {
    hasCursor: true,
    xPct,
    yPct,
    zoom
  };
}

function createMotionZoomTrackBlocks(
  segments: ManualZoomSegment[],
  durationMs: number,
  selectedSegmentId: string | null
): TimelineBlock[] {
  return segments.flatMap((segment) => {
    const startMs = clamp(getMotionSegmentStartMs(segment), 0, durationMs);
    const endMs = clamp(startMs + segment.durationMs, 0, durationMs);

    if (endMs <= startMs) {
      return [];
    }

    return [
      {
        id: segment.id,
        left: `${(startMs / durationMs) * 100}%`,
        width: `${Math.max(1.6, ((endMs - startMs) / durationMs) * 100)}%`,
        selected: segment.id === selectedSegmentId
      }
    ];
  });
}

function createSmoothedCursorPath(timeline: Timeline): SmoothedCursorPath {
  const firstEvent = timeline.events[0];

  if (!firstEvent) {
    return {
      durationMs: timeline.durationMs,
      points: []
    };
  }

  const points: SmoothedCursorPoint[] = [];
  let smoothX = firstEvent.x;
  let smoothY = firstEvent.y;

  for (let timeMs = 0; timeMs <= timeline.durationMs; timeMs += CURSOR_SAMPLE_MS) {
    const rawCursor = findRawCursorPointAtTime(timeline.events, Math.max(0, timeMs - CURSOR_VISUAL_DELAY_MS));
    const targetX = rawCursor?.x ?? smoothX;
    const targetY = rawCursor?.y ?? smoothY;
    const distance = Math.hypot(targetX - smoothX, targetY - smoothY);
    const alpha = clamp(
      CURSOR_SMOOTH_MIN_ALPHA + (distance / CURSOR_SMOOTH_DISTANCE_REF) * (CURSOR_SMOOTH_MAX_ALPHA - CURSOR_SMOOTH_MIN_ALPHA),
      CURSOR_SMOOTH_MIN_ALPHA,
      CURSOR_SMOOTH_MAX_ALPHA
    );

    smoothX += (targetX - smoothX) * alpha;
    smoothY += (targetY - smoothY) * alpha;
    points.push({
      t: Math.round(timeMs),
      x: smoothX,
      y: smoothY
    });
  }

  if (points.at(-1)?.t !== timeline.durationMs) {
    points.push({
      t: timeline.durationMs,
      x: smoothX,
      y: smoothY
    });
  }

  return {
    durationMs: timeline.durationMs,
    points
  };
}

function findCursorPointAtTime(path: SmoothedCursorPath, timeMs: number): CursorPoint | null {
  const points = path.points;

  if (!points.length) {
    return null;
  }

  let previous = points[0];
  let next: SmoothedCursorPoint | null = null;

  for (const point of points) {
    if (point.t <= timeMs) {
      previous = point;
      continue;
    }

    next = point;
    break;
  }

  if (!next || next.t === previous.t) {
    return {
      x: previous.x,
      y: previous.y
    };
  }

  const progress = clamp((timeMs - previous.t) / (next.t - previous.t), 0, 1);

  return {
    x: previous.x + (next.x - previous.x) * progress,
    y: previous.y + (next.y - previous.y) * progress
  };
}

function findRawCursorPointAtTime(events: CursorEvent[], timeMs: number): CursorPoint | null {
  let previous: CursorEvent | null = null;
  let next: CursorEvent | null = null;

  for (const event of events) {
    if (event.t <= timeMs) {
      previous = event;
      continue;
    }

    next = event;
    break;
  }

  if (!previous) {
    return null;
  }

  if (!next || next.t === previous.t || next.t - previous.t > CURSOR_INTERPOLATION_MAX_GAP_MS) {
    return {
      x: previous.x,
      y: previous.y
    };
  }

  const progress = easeInOutCubic(clamp((timeMs - previous.t) / (next.t - previous.t), 0, 1));

  return {
    x: previous.x + (next.x - previous.x) * progress,
    y: previous.y + (next.y - previous.y) * progress
  };
}

function getMotionSegmentsForMode(
  timeline: Timeline,
  motionEdit: ProjectMotionEdit,
  zoomTarget: number,
  smoothness: number,
  durationMs: number
): ManualZoomSegment[] {
  if (motionEdit.mode === "manual") {
    return sortManualZooms(motionEdit.manualZooms.map((segment) => normalizeMotionSegment(segment, durationMs)));
  }

  const generatedSegments = createAutoZoomSegments(timeline, zoomTarget, smoothness, durationMs);
  const editedById = new Map((motionEdit.autoZooms ?? []).map((segment) => [segment.id, normalizeMotionSegment(segment, durationMs)]));
  const mergedSegments = generatedSegments.map((segment) => editedById.get(segment.id) ?? segment);
  const extraSegments = [...editedById.values()].filter((segment) => !generatedSegments.some((item) => item.id === segment.id));

  return sortManualZooms([...mergedSegments, ...extraSegments]);
}

function createAutoZoomSegments(
  timeline: Timeline,
  zoomTarget: number,
  smoothness: number,
  durationMs: number
): ManualZoomSegment[] {
  return timeline.events
    .filter((event) => event.type === "down" && event.t <= durationMs)
    .map((event, index) =>
      normalizeMotionSegment(
        {
          id: `click-${index}-${event.t}`,
          anchorMs: event.t,
          durationMs: ZOOM_TOTAL_MS,
          zoom: zoomTarget,
          smoothness
        },
        durationMs
      )
    );
}

function normalizeMotionSegment(segment: ManualZoomSegment, durationMs: number): ManualZoomSegment {
  const maxDurationMs = Math.max(1_000, durationMs);

  return {
    id: segment.id || createManualZoomSegmentId(),
    anchorMs: Math.round(clamp(segment.anchorMs, 0, Math.max(1, durationMs))),
    durationMs: Math.round(clamp(segment.durationMs, 1_000, maxDurationMs)),
    zoom: Number(clamp(segment.zoom, 1, 2.4).toFixed(2)),
    smoothness: Math.round(clamp(segment.smoothness ?? 68, 0, 100))
  };
}

function findMotionSegmentAtTime(
  segments: ManualZoomSegment[],
  timeMs: number
): ManualZoomSegment | null {
  let activeSegment: ManualZoomSegment | null = null;

  for (const segment of sortManualZooms(segments)) {
    const startMs = getMotionSegmentStartMs(segment);
    const endMs = startMs + segment.durationMs;

    if (timeMs >= startMs && timeMs <= endMs) {
      activeSegment = segment;
    }
  }

  return activeSegment;
}

function computeMotionZoom(segments: ManualZoomSegment[], timeMs: number, fallbackSmoothness: number): number {
  return segments.reduce((maxZoom, segment) => {
    const startMs = getMotionSegmentStartMs(segment);
    const endMs = startMs + segment.durationMs;

    if (timeMs < startMs || timeMs > endMs) {
      return maxZoom;
    }

    return Math.max(maxZoom, computeSegmentZoom(segment, timeMs, fallbackSmoothness));
  }, 1);
}

function computeSegmentZoom(segment: ManualZoomSegment, timeMs: number, fallbackSmoothness: number): number {
  const startMs = getMotionSegmentStartMs(segment);
  const endMs = startMs + segment.durationMs;
  const smoothness = clamp((segment.smoothness ?? fallbackSmoothness) / 100, 0, 1);
  const zoomInMs = getSegmentZoomInMs(segment);
  const zoomOutMs = getSegmentZoomOutMs(segment);
  const zoomInProgress = easeOutCubic(clamp((timeMs - startMs) / zoomInMs, 0, 1));
  const zoomOutStartsAt = endMs - zoomOutMs;
  const zoomOutProgress = easeInOutCubic(clamp((timeMs - zoomOutStartsAt) / zoomOutMs, 0, 1));
  const activeLevel = zoomInProgress * (1 - zoomOutProgress);
  const targetInfluence = 0.78 + smoothness * 0.22;

  return 1 + (segment.zoom - 1) * activeLevel * targetInfluence;
}

function getSegmentZoomInMs(segment: ManualZoomSegment): number {
  const smoothness = clamp((segment.smoothness ?? 68) / 100, 0, 1);

  return Math.round(ZOOM_IN_MS + smoothness * 320);
}

function getSegmentZoomOutMs(segment: ManualZoomSegment): number {
  const smoothness = clamp((segment.smoothness ?? 68) / 100, 0, 1);

  return Math.round(ZOOM_OUT_MS + smoothness * 420);
}

function getMotionSegmentStartMs(segment: ManualZoomSegment): number {
  return Math.max(0, segment.anchorMs - getSegmentZoomInMs(segment));
}

function getAnchorFromStartMs(segment: ManualZoomSegment, startMs: number): number {
  return Math.max(0, Math.round(startMs + getSegmentZoomInMs(segment)));
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function renderProjectToExport(
  jobId: string,
  project: OpenedProject,
  trimStartMs: number,
  editedDurationMs: number,
  zoomTarget: number,
  smoothness: number,
  showCursor: boolean,
  appearance: ProjectAppearanceEdit,
  signal: AbortSignal,
  onProgress: (progress: number) => void
): Promise<void> {
  if (signal.aborted) {
    throw new Error("Export cancelled");
  }

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.src = project.captureUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  await waitForVideoMetadata(video);

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || project.timeline.source.bounds.width;
  canvas.height = video.videoHeight || project.timeline.source.bounds.height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas rendering is unavailable.");
  }

  const stream = canvas.captureStream(EXPORT_RENDER_FPS);
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType: getBestWebmMimeType(),
    videoBitsPerSecond: getExportRenderBitrate(canvas.width, canvas.height)
  });
  let appendChain = Promise.resolve();
  let lastReportedProgress = -1;
  const reportProgress = (progress: number): void => {
    const safeProgress = clamp(progress, 0, EXPORT_RENDER_PROGRESS_MAX);

    if (safeProgress - lastReportedProgress < 0.005 && safeProgress !== EXPORT_RENDER_PROGRESS_MAX) {
      return;
    }

    lastReportedProgress = safeProgress;
    onProgress(safeProgress);
  };

  mediaRecorder.ondataavailable = (event) => {
    if (!event.data.size || signal.aborted) {
      return;
    }

    appendChain = appendChain.then(async () => {
      const chunk = await event.data.arrayBuffer();
      await window.recorderApi.export.appendChunk({ jobId, chunk }).catch((error) => {
        if (signal.aborted) {
          return;
        }

        throw error;
      });
    });
  };

  const trimStartSeconds = Math.min(video.duration, trimStartMs / 1000);
  const trimEndSeconds = Math.min(video.duration, (trimStartMs + editedDurationMs) / 1000);
  const renderDurationSeconds = Math.max(0.001, trimEndSeconds - trimStartSeconds);
  const cursorPath = createSmoothedCursorPath(project.timeline);
  const motionEdit = getProjectMotionEdit(project, "auto");
  let didStop = false;
  let animationFrameId = 0;
  const stopRender = (): void => {
    if (didStop) {
      return;
    }

    didStop = true;
    if (animationFrameId) {
      window.cancelAnimationFrame(animationFrameId);
    }

    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    stream.getTracks().forEach((track) => track.stop());
  };
  const stopped = new Promise<void>((resolve) => {
    mediaRecorder.addEventListener("stop", () => resolve(), { once: true });
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const handleAbort = (): void => {
      video.pause();
      stopRender();
      reject(new Error("Export cancelled"));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
  });

  await seekVideoTo(video, trimStartSeconds);

  mediaRecorder.start(1000);
  reportProgress(0);

  const renderFrame = (): void => {
    const currentTime = Math.min(video.currentTime, trimEndSeconds);
    const elapsedSeconds = Math.max(0, currentTime - trimStartSeconds);
    const timeMs = currentTime * 1000;
    const motion = computeMotionState(project.timeline, cursorPath, timeMs, zoomTarget, smoothness, motionEdit);

    drawFrame(context, canvas, video, motion, showCursor, appearance);
    reportProgress((elapsedSeconds / renderDurationSeconds) * EXPORT_RENDER_PROGRESS_MAX);

    if (currentTime >= trimEndSeconds) {
      video.pause();
      reportProgress(EXPORT_RENDER_PROGRESS_MAX);
      stopRender();
      return;
    }

    if (!video.ended) {
      animationFrameId = window.requestAnimationFrame(renderFrame);
    }
  };

  video.addEventListener(
    "ended",
    () => {
      const timeMs = trimEndSeconds * 1000;
      drawFrame(
        context,
        canvas,
        video,
        computeMotionState(project.timeline, cursorPath, timeMs, zoomTarget, smoothness, motionEdit),
        showCursor,
        appearance
      );
      reportProgress(EXPORT_RENDER_PROGRESS_MAX);
      stopRender();
    },
    { once: true }
  );

  await video.play();
  renderFrame();
  await Promise.race([stopped, abortPromise]);
  await appendChain;

  if (signal.aborted) {
    throw new Error("Export cancelled");
  }
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error(getVideoErrorMessage(video))), {
      once: true
    });
  });
}

function seekVideoTo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  if (Math.abs(video.currentTime - timeSeconds) < 0.02) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error(getVideoErrorMessage(video))), { once: true });
    video.currentTime = timeSeconds;
  });
}

function getVideoErrorMessage(video: HTMLVideoElement): string {
  const code = video.error?.code ?? "unknown";
  const src = video.currentSrc || video.src || "unknown source";

  return `Could not load recorded video. mediaError=${code}; src=${src}`;
}

function drawFrame(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  motion: MotionState,
  showCursor: boolean,
  appearance: ProjectAppearanceEdit
): void {
  const width = canvas.width;
  const height = canvas.height;
  const frame = getFrameComposition(width, height, video.videoWidth || width, video.videoHeight || height, appearance);
  const cursorX = frame.x + (motion.xPct / 100) * frame.width;
  const cursorY = frame.y + (motion.yPct / 100) * frame.height;

  context.save();
  applyZoomTransform(context, motion.zoom, cursorX, cursorY);

  context.save();
  drawWallpaperBackground(context, width, height, appearance.backgroundPreset);
  context.restore();

  context.save();
  applyCanvasFrameShadow(context, width, height, appearance.frameShadow);
  roundedRect(context, frame.x, frame.y, frame.width, frame.height, frame.radius);
  context.fillStyle = "#050607";
  context.fill();
  context.restore();

  context.save();
  roundedRect(context, frame.x, frame.y, frame.width, frame.height, frame.radius);
  context.clip();
  context.drawImage(video, frame.x, frame.y, frame.width, frame.height);
  context.restore();

  if (showCursor && motion.hasCursor) {
    context.save();
    roundedRect(context, frame.x, frame.y, frame.width, frame.height, frame.radius);
    context.clip();
    drawCursor(context, cursorX, cursorY, appearance.cursorStyle);
    context.restore();
  }

  context.restore();
}

function getFrameComposition(
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number,
  appearance: ProjectAppearanceEdit = DEFAULT_PROJECT_APPEARANCE
): FrameComposition {
  const videoAspect = videoWidth / Math.max(1, videoHeight);
  const frameScale = clamp(appearance.frameScale / 100, 0.7, 0.94);
  let frameWidth = canvasWidth * frameScale;
  let frameHeight = frameWidth / videoAspect;
  const maxFrameHeight = canvasHeight * Math.min(frameScale, COMPOSED_FRAME_HEIGHT_RATIO);

  if (frameHeight > maxFrameHeight) {
    frameHeight = maxFrameHeight;
    frameWidth = frameHeight * videoAspect;
  }

  return {
    x: (canvasWidth - frameWidth) / 2,
    y: (canvasHeight - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
    radius: Math.min(appearance.frameRadius, Math.min(frameWidth, frameHeight) / 2)
  };
}

function drawWallpaperBackground(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  preset: BackgroundPreset
): void {
  const theme = getCanvasBackgroundTheme(preset);
  const baseGradient = context.createLinearGradient(0, 0, width, height);
  baseGradient.addColorStop(0, theme.base[0]);
  baseGradient.addColorStop(0.5, theme.base[1]);
  baseGradient.addColorStop(1, theme.base[2]);
  context.fillStyle = baseGradient;
  context.fillRect(0, 0, width, height);

  drawRadialGlow(context, width * 0.18, height * 0.2, width * 0.35, theme.glows[0]);
  drawRadialGlow(context, width * 0.82, height * 0.26, width * 0.38, theme.glows[1]);
  drawRadialGlow(context, width * 0.62, height * 0.82, width * 0.42, theme.glows[2]);

  context.save();
  context.globalAlpha = theme.bandAlpha;
  context.fillStyle = theme.band;
  context.beginPath();
  context.moveTo(width * -0.1, height * 0.72);
  context.lineTo(width * 0.42, height * 0.2);
  context.lineTo(width * 0.92, height * 0.28);
  context.lineTo(width * 0.28, height * 1.08);
  context.closePath();
  context.fill();

  context.globalAlpha = theme.streakAlpha;
  context.fillStyle = theme.streak;
  context.beginPath();
  context.moveTo(width * 0.06, height * -0.08);
  context.lineTo(width * 0.16, height * -0.08);
  context.lineTo(width * 0.74, height * 1.08);
  context.lineTo(width * 0.62, height * 1.08);
  context.closePath();
  context.fill();
  context.restore();

  const vignette = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width * 0.72);
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, theme.vignette);
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
}

function getCanvasBackgroundTheme(preset: BackgroundPreset): {
  base: [string, string, string];
  glows: [string, string, string];
  band: string;
  bandAlpha: number;
  streak: string;
  streakAlpha: number;
  vignette: string;
} {
  switch (preset) {
    case "light-soft":
      return {
        base: ["#eef3f7", "#d9e2e9", "#b8c8d5"],
        glows: ["rgba(113, 170, 219, 0.26)", "rgba(255, 220, 153, 0.32)", "rgba(130, 208, 191, 0.22)"],
        band: "rgba(74, 126, 164, 0.16)",
        bandAlpha: 0.52,
        streak: "rgba(255, 255, 255, 0.48)",
        streakAlpha: 0.34,
        vignette: "rgba(43, 57, 67, 0.18)"
      };
    case "blue-windows":
      return {
        base: ["#0c2f63", "#136fb5", "#03192f"],
        glows: ["rgba(90, 190, 255, 0.45)", "rgba(28, 102, 210, 0.36)", "rgba(0, 230, 198, 0.20)"],
        band: "rgba(135, 218, 255, 0.20)",
        bandAlpha: 0.5,
        streak: "rgba(255, 255, 255, 0.18)",
        streakAlpha: 0.28,
        vignette: "rgba(0, 7, 18, 0.38)"
      };
    case "warm-gradient":
      return {
        base: ["#2c1624", "#713b43", "#150b12"],
        glows: ["rgba(255, 129, 102, 0.35)", "rgba(255, 213, 112, 0.28)", "rgba(177, 88, 190, 0.22)"],
        band: "rgba(255, 183, 112, 0.16)",
        bandAlpha: 0.5,
        streak: "rgba(255, 241, 211, 0.16)",
        streakAlpha: 0.24,
        vignette: "rgba(14, 5, 11, 0.42)"
      };
    case "dark-soft":
    default:
      return {
        base: ["#172028", "#101317", "#07090c"],
        glows: ["rgba(80, 151, 192, 0.28)", "rgba(208, 169, 74, 0.20)", "rgba(58, 187, 163, 0.18)"],
        band: "rgba(79, 195, 178, 0.16)",
        bandAlpha: 0.28,
        streak: "rgba(255, 255, 255, 0.16)",
        streakAlpha: 0.18,
        vignette: "rgba(0, 0, 0, 0.34)"
      };
  }
}

function getPreviewBackground(preset: BackgroundPreset): string {
  switch (preset) {
    case "light-soft":
      return [
        "radial-gradient(circle at 18% 20%, rgb(113 170 219 / 26%), transparent 32%)",
        "radial-gradient(circle at 82% 26%, rgb(255 220 153 / 32%), transparent 34%)",
        "radial-gradient(circle at 62% 82%, rgb(130 208 191 / 22%), transparent 38%)",
        "linear-gradient(135deg, #eef3f7 0%, #d9e2e9 48%, #b8c8d5 100%)"
      ].join(", ");
    case "blue-windows":
      return [
        "radial-gradient(circle at 18% 20%, rgb(90 190 255 / 45%), transparent 32%)",
        "radial-gradient(circle at 82% 26%, rgb(28 102 210 / 36%), transparent 34%)",
        "radial-gradient(circle at 62% 82%, rgb(0 230 198 / 20%), transparent 38%)",
        "linear-gradient(135deg, #0c2f63 0%, #136fb5 46%, #03192f 100%)"
      ].join(", ");
    case "warm-gradient":
      return [
        "radial-gradient(circle at 18% 20%, rgb(255 129 102 / 35%), transparent 32%)",
        "radial-gradient(circle at 82% 26%, rgb(255 213 112 / 28%), transparent 34%)",
        "radial-gradient(circle at 62% 82%, rgb(177 88 190 / 22%), transparent 38%)",
        "linear-gradient(135deg, #2c1624 0%, #713b43 48%, #150b12 100%)"
      ].join(", ");
    case "dark-soft":
    default:
      return [
        "radial-gradient(circle at 18% 20%, rgb(80 151 192 / 32%), transparent 32%)",
        "radial-gradient(circle at 82% 26%, rgb(208 169 74 / 24%), transparent 34%)",
        "radial-gradient(circle at 62% 82%, rgb(58 187 163 / 22%), transparent 38%)",
        "linear-gradient(135deg, #172028 0%, #101317 42%, #07090c 100%)"
      ].join(", ");
  }
}

function drawRadialGlow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string
): void {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
}

function getPreviewFrameShadow(value: number): string {
  const intensity = clamp(value / 100, 0, 1);

  if (intensity <= 0) {
    return "none";
  }

  return [
    `0 ${Math.round(14 + intensity * 22)}px ${Math.round(34 + intensity * 58)}px rgb(0 0 0 / ${0.22 + intensity * 0.34})`,
    `0 4px ${Math.round(10 + intensity * 14)}px rgb(0 0 0 / ${0.20 + intensity * 0.22})`
  ].join(", ");
}

function applyCanvasFrameShadow(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  value: number
): void {
  const intensity = clamp(value / 100, 0, 1);

  context.shadowColor = `rgba(0, 0, 0, ${0.18 + intensity * 0.44})`;
  context.shadowBlur = Math.round(width * (0.012 + intensity * 0.04));
  context.shadowOffsetY = Math.round(height * (0.008 + intensity * 0.035));
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function drawCursor(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  style: CursorStyle
): void {
  context.save();
  context.translate(x, y);

  if (style === "soft-dot") {
    context.shadowColor = "rgba(0, 0, 0, 0.34)";
    context.shadowBlur = 16;
    context.beginPath();
    context.arc(0, 0, 11, 0, Math.PI * 2);
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.fill();
    context.shadowBlur = 0;
    context.beginPath();
    context.arc(0, 0, 5, 0, Math.PI * 2);
    context.fillStyle = "rgba(13, 17, 20, 0.82)";
    context.fill();
    context.restore();
    return;
  }

  const isDark = style === "dark-arrow";

  context.fillStyle = isDark ? "rgba(13, 17, 20, 0.98)" : "rgba(255, 255, 255, 0.98)";
  context.strokeStyle = isDark ? "rgba(255, 255, 255, 0.92)" : "rgba(13, 17, 20, 0.92)";
  context.lineJoin = "round";
  context.lineCap = "round";
  context.lineWidth = 3.5;
  context.beginPath();
  context.moveTo(0, 0);
  context.quadraticCurveTo(2, 15, 5, 29);
  context.quadraticCurveTo(6, 32, 9, 29);
  context.lineTo(14, 24);
  context.lineTo(19, 37);
  context.quadraticCurveTo(20, 40, 23, 39);
  context.lineTo(27, 37);
  context.quadraticCurveTo(30, 36, 28, 33);
  context.lineTo(22, 21);
  context.lineTo(31, 21);
  context.quadraticCurveTo(35, 21, 32, 18);
  context.lineTo(5, 1);
  context.quadraticCurveTo(1, -1, 0, 0);
  context.closePath();
  context.stroke();
  context.fill();

  context.restore();
}

function applyZoomTransform(
  context: CanvasRenderingContext2D,
  zoom: number,
  focusX: number,
  focusY: number
): void {
  if (zoom === 1) {
    return;
  }

  context.translate(focusX, focusY);
  context.scale(zoom, zoom);
  context.translate(-focusX, -focusY);
}
