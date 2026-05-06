import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { AppWindow, Check, Monitor, Move, RectangleHorizontal, X } from "lucide-react";
import type { CapturePickerState, CaptureSelection, CaptureSource, CaptureTargetKind, Rect } from "@shared/ipc";

type Point = {
  x: number;
  y: number;
};

type RegionSelectionState = {
  sourceId: string;
  rect: Rect;
};

type RegionHandle =
  | "move"
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

type RegionInteraction = {
  handle: RegionHandle | "create";
  pointerId: number;
  source: CaptureSource;
  startPoint: Point;
  startRect: Rect;
};

const REGION_MIN_EDGE_PX = 96;

export function CapturePickerOverlayApp(): ReactElement {
  const [pickerState, setPickerState] = useState<CapturePickerState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null);
  const [regionSelection, setRegionSelection] = useState<RegionSelectionState | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<RegionInteraction | null>(null);

  useEffect(() => {
    document.body.classList.add("overlay-window");

    return () => {
      document.body.classList.remove("overlay-window");
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    void window.recorderApi.capturePicker
      .getState()
      .then((state) => {
        if (!isMounted) {
          return;
        }

        setPickerState(state);
        setHoveredSourceId(state.sources[0]?.id ?? null);
      })
      .catch((nextError) => {
        if (!isMounted) {
          return;
        }

        setError(toErrorMessage(nextError));
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const virtualBounds = pickerState?.virtualBounds ?? { x: 0, y: 0, width: 1, height: 1 };
  const screenSources = useMemo(() => {
    return (pickerState?.sources ?? []).filter((source) => source.type === "screen");
  }, [pickerState?.sources]);
  const windowSources = useMemo(() => {
    return (pickerState?.sources ?? []).filter((source) => source.type === "window");
  }, [pickerState?.sources]);
  const activeRegionSource = useMemo(() => {
    if (!regionSelection) {
      return null;
    }

    return screenSources.find((source) => source.id === regionSelection.sourceId) ?? null;
  }, [regionSelection, screenSources]);
  const highlightedSourceId = regionSelection?.sourceId ?? hoveredSourceId;

  const cancelPicker = useCallback(async () => {
    if (!pickerState) {
      window.close();
      return;
    }

    setIsSubmitting(true);
    try {
      await window.recorderApi.capturePicker.cancel({ requestId: pickerState.requestId });
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setIsSubmitting(false);
    }
  }, [pickerState]);

  const submitSelection = useCallback(
    async (selection: CaptureSelection) => {
      if (!pickerState) {
        return;
      }

      setIsSubmitting(true);
      setError(null);

      try {
        await window.recorderApi.capturePicker.complete({
          requestId: pickerState.requestId,
          selection
        });
      } catch (nextError) {
        setError(toErrorMessage(nextError));
        setIsSubmitting(false);
      }
    },
    [pickerState]
  );

  const confirmRegionSelection = useCallback(() => {
    if (!pickerState || !regionSelection) {
      return;
    }

    const source = screenSources.find((item) => item.id === regionSelection.sourceId);

    if (!source) {
      setError("The selected screen is no longer available.");
      return;
    }

    void submitSelection({
      targetKind: "region",
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      bounds: regionSelection.rect,
      region: regionSelection.rect
    });
  }, [pickerState, regionSelection, screenSources, submitSelection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancelPicker();
        return;
      }

      if (event.key === "Enter" && pickerState?.targetKind === "region" && regionSelection) {
        event.preventDefault();
        confirmRegionSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [cancelPicker, confirmRegionSelection, pickerState?.targetKind, regionSelection]);

  const beginRegionInteraction = useCallback(
    (event: ReactPointerEvent<HTMLElement>, handle: RegionHandle | "create", source: CaptureSource, startRect: Rect) => {
      if (event.button !== 0 || !stageRef.current) {
        return;
      }

      const stage = stageRef.current;

      event.preventDefault();
      event.stopPropagation();
      stage.setPointerCapture(event.pointerId);
      interactionRef.current = {
        handle,
        pointerId: event.pointerId,
        source,
        startPoint: getDesktopPointFromClientPosition(event.clientX, event.clientY, stage, virtualBounds),
        startRect
      };

      if (handle === "create") {
        setRegionSelection({
          sourceId: source.id,
          rect: startRect
        });
      } else {
        setRegionSelection({
          sourceId: source.id,
          rect: clampRectToBounds(startRect, source.bounds)
        });
      }
    },
    [virtualBounds]
  );

  const handleRegionPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const interaction = interactionRef.current;
      const stage = stageRef.current;

      if (!interaction || !stage || interaction.pointerId !== event.pointerId) {
        return;
      }

      const point = getDesktopPointFromClientPosition(event.clientX, event.clientY, stage, virtualBounds);
      const nextRect = getNextRegionRect(interaction, point, interaction.source.bounds);

      setRegionSelection({
        sourceId: interaction.source.id,
        rect: nextRect
      });
    },
    [virtualBounds]
  );

  const handleRegionPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    interactionRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const handleRegionBackgroundPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!pickerState || pickerState.targetKind !== "region" || !stageRef.current || event.button !== 0) {
        return;
      }

      const point = getDesktopPointFromClientPosition(event.clientX, event.clientY, stageRef.current, virtualBounds);
      const source = screenSources.find((item) => isPointInRect(point, item.bounds));

      if (!source) {
        return;
      }

      const startRect = {
        x: point.x,
        y: point.y,
        width: REGION_MIN_EDGE_PX,
        height: REGION_MIN_EDGE_PX
      };

      beginRegionInteraction(event, "create", source, startRect);
      setHoveredSourceId(source.id);
    },
    [beginRegionInteraction, pickerState, screenSources, virtualBounds]
  );

  if (isLoading) {
    return (
      <div className="capture-picker-root">
        <div className="capture-picker-loading">Preparing capture picker...</div>
      </div>
    );
  }

  if (!pickerState) {
    return (
      <div className="capture-picker-root">
        <div className="capture-picker-panel error">
          <strong>Could not open the capture picker.</strong>
          <span>{error ?? "The picker state is unavailable."}</span>
          <div className="capture-picker-actions">
            <button className="capture-picker-button secondary" type="button" onClick={() => void cancelPicker()}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`capture-picker-root mode-${pickerState.targetKind}`}
      onDoubleClick={() => {
        if (pickerState.targetKind === "region" && regionSelection) {
          confirmRegionSelection();
        }
      }}
    >
      {(pickerState.targetKind === "screen" || pickerState.targetKind === "region") && (
        <div
          className="capture-picker-stage"
          ref={stageRef}
          onPointerMove={pickerState.targetKind === "region" ? handleRegionPointerMove : undefined}
          onPointerUp={pickerState.targetKind === "region" ? handleRegionPointerUp : undefined}
          onPointerCancel={pickerState.targetKind === "region" ? handleRegionPointerUp : undefined}
          onPointerDown={pickerState.targetKind === "region" ? handleRegionBackgroundPointerDown : undefined}
        >
          <div className="capture-picker-dim" />
          {screenSources.map((source) => {
            const sourceStyle = getOverlayRectStyle(source.bounds, virtualBounds);
            const isHighlighted = highlightedSourceId === source.id;

            if (pickerState.targetKind === "screen") {
              return (
                <button
                  className={`capture-picker-screen ${isHighlighted ? "highlighted" : ""}`}
                  key={source.id}
                  style={sourceStyle}
                  type="button"
                  onMouseEnter={() => setHoveredSourceId(source.id)}
                  onClick={() =>
                    void submitSelection({
                      targetKind: "screen",
                      sourceId: source.id,
                      sourceName: source.name,
                      sourceType: source.type,
                      bounds: source.bounds
                    })
                  }
                >
                  <span className="capture-picker-screen-label">
                    <Monitor size={15} />
                    {source.name}
                  </span>
                </button>
              );
            }

            return (
              <div
                aria-hidden="true"
                className={`capture-picker-screen ${isHighlighted ? "highlighted" : ""}`}
                key={source.id}
                style={sourceStyle}
                onMouseEnter={() => setHoveredSourceId(source.id)}
              >
                <span className="capture-picker-screen-label">
                  <Monitor size={15} />
                  {source.name}
                </span>
              </div>
            );
          })}

          {pickerState.targetKind === "region" && regionSelection ? (
            <>
              <div className="capture-picker-mask top" style={getTopMaskStyle(regionSelection.rect, virtualBounds)} />
              <div className="capture-picker-mask right" style={getRightMaskStyle(regionSelection.rect, virtualBounds)} />
              <div className="capture-picker-mask bottom" style={getBottomMaskStyle(regionSelection.rect, virtualBounds)} />
              <div className="capture-picker-mask left" style={getLeftMaskStyle(regionSelection.rect, virtualBounds)} />
              <div
                className="capture-picker-selection"
                style={getOverlayRectStyle(regionSelection.rect, virtualBounds)}
                onPointerDown={(event) => {
                  const source = activeRegionSource;

                  if (!source) {
                    return;
                  }

                  beginRegionInteraction(event, "move", source, regionSelection.rect);
                }}
              >
                <div className="capture-picker-selection-chip">
                  <Move size={14} />
                  {Math.round(regionSelection.rect.width)} x {Math.round(regionSelection.rect.height)} px
                  {activeRegionSource ? ` - ${activeRegionSource.name}` : ""}
                </div>
                {REGION_HANDLES.map((handle) => (
                  <button
                    aria-label={`Resize selection ${handle}`}
                    className={`capture-picker-handle handle-${handle}`}
                    key={handle}
                    type="button"
                    onPointerDown={(event) => {
                      const source = activeRegionSource;

                      if (!source) {
                        return;
                      }

                      beginRegionInteraction(event, handle, source, regionSelection.rect);
                    }}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
      )}

      {pickerState.targetKind === "window" ? (
        <div className="capture-picker-window-panel">
          <div className="capture-picker-header-card">
            <div>
              <strong>Choose a window</strong>
              <span>Only windows that can stay cursor-free are eligible for recording.</span>
            </div>
            <button className="capture-picker-close" type="button" onClick={() => void cancelPicker()} disabled={isSubmitting}>
              <X size={16} />
            </button>
          </div>
          <div className="capture-window-grid">
            {windowSources.length ? (
              windowSources.map((source) => (
                <button
                  className="capture-window-card"
                  key={source.id}
                  type="button"
                  onClick={() =>
                    void submitSelection({
                      targetKind: "window",
                      sourceId: source.id,
                      sourceName: source.name,
                      sourceType: source.type,
                      bounds: source.bounds
                    })
                  }
                >
                  <div className="capture-window-thumb">
                    {source.thumbnailDataUrl ? <img src={source.thumbnailDataUrl} alt="" /> : <div className="capture-window-empty" />}
                  </div>
                  <div className="capture-window-meta">
                    <strong>{source.name}</strong>
                    <span>{formatBounds(source.bounds)}</span>
                  </div>
                  {source.appIconDataUrl ? <img className="capture-window-icon" src={source.appIconDataUrl} alt="" /> : <AppWindow size={16} />}
                </button>
              ))
            ) : (
              <div className="capture-picker-empty-card">
                <strong>No compatible windows found</strong>
                <span>Open or restore the window you want to capture, then try again.</span>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {pickerState.targetKind === "screen" ? (
        <div className="capture-picker-footer-card">
          <RectangleHorizontal size={15} />
          Click a monitor to start recording that full screen.
        </div>
      ) : null}

      {pickerState.targetKind === "region" ? (
        <div className="capture-picker-toolbar" onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => event.stopPropagation()}>
          <div className="capture-picker-toolbar-copy">
            <strong>Region capture</strong>
            <span>Drag to create the area, move inside it, resize by the edges, Enter to confirm, Esc to cancel.</span>
          </div>
          <div className="capture-picker-actions">
            <button className="capture-picker-button secondary" type="button" onClick={() => void cancelPicker()} disabled={isSubmitting}>
              <X size={15} />
              Cancel
            </button>
            <button
              className="capture-picker-button primary"
              type="button"
              onClick={confirmRegionSelection}
              disabled={!regionSelection || isSubmitting}
            >
              <Check size={15} />
              Confirm region
            </button>
          </div>
        </div>
      ) : null}

      {(pickerState.targetKind === "screen" || pickerState.targetKind === "window") && (
        <button className="capture-picker-floating-close" type="button" onClick={() => void cancelPicker()} disabled={isSubmitting}>
          <X size={16} />
          Cancel
        </button>
      )}

      {error ? <div className="capture-picker-error-banner">{error}</div> : null}
    </div>
  );
}

const REGION_HANDLES: RegionHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function getOverlayRectStyle(bounds: Rect, virtualBounds: Rect): Record<string, string> {
  return {
    left: `${((bounds.x - virtualBounds.x) / Math.max(1, virtualBounds.width)) * 100}%`,
    top: `${((bounds.y - virtualBounds.y) / Math.max(1, virtualBounds.height)) * 100}%`,
    width: `${(bounds.width / Math.max(1, virtualBounds.width)) * 100}%`,
    height: `${(bounds.height / Math.max(1, virtualBounds.height)) * 100}%`
  };
}

function getTopMaskStyle(selection: Rect, virtualBounds: Rect): Record<string, string> {
  return {
    left: "0%",
    top: "0%",
    width: "100%",
    height: `${((selection.y - virtualBounds.y) / Math.max(1, virtualBounds.height)) * 100}%`
  };
}

function getRightMaskStyle(selection: Rect, virtualBounds: Rect): Record<string, string> {
  const right = selection.x + selection.width;

  return {
    left: `${((right - virtualBounds.x) / Math.max(1, virtualBounds.width)) * 100}%`,
    top: `${((selection.y - virtualBounds.y) / Math.max(1, virtualBounds.height)) * 100}%`,
    width: `${((virtualBounds.x + virtualBounds.width - right) / Math.max(1, virtualBounds.width)) * 100}%`,
    height: `${(selection.height / Math.max(1, virtualBounds.height)) * 100}%`
  };
}

function getBottomMaskStyle(selection: Rect, virtualBounds: Rect): Record<string, string> {
  const bottom = selection.y + selection.height;

  return {
    left: "0%",
    top: `${((bottom - virtualBounds.y) / Math.max(1, virtualBounds.height)) * 100}%`,
    width: "100%",
    height: `${((virtualBounds.y + virtualBounds.height - bottom) / Math.max(1, virtualBounds.height)) * 100}%`
  };
}

function getLeftMaskStyle(selection: Rect, virtualBounds: Rect): Record<string, string> {
  return {
    left: "0%",
    top: `${((selection.y - virtualBounds.y) / Math.max(1, virtualBounds.height)) * 100}%`,
    width: `${((selection.x - virtualBounds.x) / Math.max(1, virtualBounds.width)) * 100}%`,
    height: `${(selection.height / Math.max(1, virtualBounds.height)) * 100}%`
  };
}

function getDesktopPointFromClientPosition(clientX: number, clientY: number, stage: HTMLDivElement, virtualBounds: Rect): Point {
  const rect = stage.getBoundingClientRect();
  const xPercent = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const yPercent = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);

  return {
    x: Math.round(virtualBounds.x + xPercent * virtualBounds.width),
    y: Math.round(virtualBounds.y + yPercent * virtualBounds.height)
  };
}

function getDefaultRegionForSource(bounds: Rect): Rect {
  const width = Math.round(bounds.width * 0.58);
  const height = Math.round(bounds.height * 0.58);

  return clampRectToBounds(
    {
      x: bounds.x + Math.round((bounds.width - width) / 2),
      y: bounds.y + Math.round((bounds.height - height) / 2),
      width,
      height
    },
    bounds
  );
}

function getNextRegionRect(interaction: RegionInteraction, point: Point, sourceBounds: Rect): Rect {
  if (interaction.handle === "create") {
    return createNormalizedRegionRect(interaction.startPoint, point, sourceBounds);
  }

  if (interaction.handle === "move") {
    const deltaX = point.x - interaction.startPoint.x;
    const deltaY = point.y - interaction.startPoint.y;

    return clampRectToBounds(
      {
        ...interaction.startRect,
        x: interaction.startRect.x + deltaX,
        y: interaction.startRect.y + deltaY
      },
      sourceBounds
    );
  }

  return resizeRegionRect(interaction.startRect, interaction.handle, point, interaction.startPoint, sourceBounds);
}

function resizeRegionRect(startRect: Rect, handle: Exclude<RegionHandle, "move">, point: Point, startPoint: Point, bounds: Rect): Rect {
  const deltaX = point.x - startPoint.x;
  const deltaY = point.y - startPoint.y;
  let left = startRect.x;
  let top = startRect.y;
  let right = startRect.x + startRect.width;
  let bottom = startRect.y + startRect.height;

  if (handle.includes("w")) {
    left += deltaX;
  }

  if (handle.includes("e")) {
    right += deltaX;
  }

  if (handle.includes("n")) {
    top += deltaY;
  }

  if (handle.includes("s")) {
    bottom += deltaY;
  }

  const minWidth = Math.min(REGION_MIN_EDGE_PX, bounds.width);
  const minHeight = Math.min(REGION_MIN_EDGE_PX, bounds.height);

  if (right - left < minWidth) {
    if (handle.includes("w")) {
      left = right - minWidth;
    } else {
      right = left + minWidth;
    }
  }

  if (bottom - top < minHeight) {
    if (handle.includes("n")) {
      top = bottom - minHeight;
    } else {
      bottom = top + minHeight;
    }
  }

  return clampRectToBounds(
    {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    },
    bounds
  );
}

function createNormalizedRegionRect(startPoint: Point, endPoint: Point, bounds: Rect): Rect {
  const minWidth = Math.min(REGION_MIN_EDGE_PX, Math.max(1, bounds.width));
  const minHeight = Math.min(REGION_MIN_EDGE_PX, Math.max(1, bounds.height));
  const isExpandingLeft = endPoint.x < startPoint.x;
  const isExpandingUp = endPoint.y < startPoint.y;
  let left = clamp(Math.min(startPoint.x, endPoint.x), bounds.x, bounds.x + bounds.width);
  let top = clamp(Math.min(startPoint.y, endPoint.y), bounds.y, bounds.y + bounds.height);
  let right = clamp(Math.max(startPoint.x, endPoint.x), bounds.x, bounds.x + bounds.width);
  let bottom = clamp(Math.max(startPoint.y, endPoint.y), bounds.y, bounds.y + bounds.height);

  if (right - left < minWidth) {
    if (isExpandingLeft) {
      left = clamp(right - minWidth, bounds.x, bounds.x + bounds.width - minWidth);
      right = left + minWidth;
    } else {
      right = clamp(left + minWidth, bounds.x + minWidth, bounds.x + bounds.width);
      left = right - minWidth;
    }
  }

  if (bottom - top < minHeight) {
    if (isExpandingUp) {
      top = clamp(bottom - minHeight, bounds.y, bounds.y + bounds.height - minHeight);
      bottom = top + minHeight;
    } else {
      bottom = clamp(top + minHeight, bounds.y + minHeight, bounds.y + bounds.height);
      top = bottom - minHeight;
    }
  }

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  };
}

function clampRectToBounds(rect: Rect, bounds: Rect): Rect {
  const width = clamp(rect.width, Math.min(REGION_MIN_EDGE_PX, bounds.width), bounds.width);
  const height = clamp(rect.height, Math.min(REGION_MIN_EDGE_PX, bounds.height), bounds.height);
  const x = clamp(rect.x, bounds.x, bounds.x + bounds.width - width);
  const y = clamp(rect.y, bounds.y, bounds.y + bounds.height - height);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function isPointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function formatBounds(bounds: Rect): string {
  return `${Math.round(bounds.width)} x ${Math.round(bounds.height)} px`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
