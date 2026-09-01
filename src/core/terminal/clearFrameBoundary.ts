import { createHash } from "node:crypto";
import * as renderDebug from "../perf/renderDebug.js";
import { resetInkOutputForFreshFrame, type InkRenderInstance } from "./inkRenderReset.js";
import { traceTerminalClear } from "./terminalControl.js";

interface ClearBoundaryStdoutLike {
  columns?: number;
  rows?: number;
}

interface TerminalClearLike {
  clearTranscript: (source: string) => void;
  clearViewport: (source: string) => void;
  setAlternateScreen?: (enabled: boolean, source: string) => void;
}

interface LogShadowState {
  previousOutputLength: number;
  previousLineCount: number;
}

interface TerminalControlSequenceStats {
  cursorUpCount: number;
  cursorHomeCount: number;
  eraseLineCount: number;
  eraseDisplayCount: number;
  carriageReturnCount: number;
}

type InkLogLike = {
  (output: string): unknown;
  clear?: () => unknown;
  sync?: (output: string) => unknown;
  reset?: () => unknown;
  willRender?: (output: string) => unknown;
  isCursorDirty?: () => unknown;
};

interface SavedNormalBufferFrame {
  lastOutput: string;
  lastOutputToRender: string;
  lastOutputHeight: number;
  fullStaticOutput: string;
  cols: number | undefined;
}

export interface ClearFrameBoundaryRenderState {
  generation: number;
  staticEventsLength: number;
  activeEventsLength: number;
  transcriptCleared: boolean;
  clearGenerationReady?: boolean;
  uiStateKind: string;
}

export interface ClearFrameBoundaryController {
  beginClearGeneration: (generation: number) => boolean;
  /**
   * Mirror the React render state into the boundary's gate. Returns `true` when
   * a post-clear authoritative frame is now ready to commit but hasn't been
   * written yet — the caller must force one more render so Ink's
   * renderInteractiveFrame runs again and flushes it (see app.tsx).
   */
  syncRenderState: (state: ClearFrameBoundaryRenderState) => boolean;
  getState: () => {
    clearPending: boolean;
    pendingGeneration: number | null;
    committedGeneration: number | null;
    renderGeneration: number;
    transcriptCleared: boolean;
    lastFrameWasAuthoritative: boolean;
    widthRepaintPending: boolean;
    overlayActive: boolean;
    logShadow: LogShadowState;
  };
  dispose: () => void;
}

interface CreateClearFrameBoundaryOptions {
  instance: InkRenderInstance | null;
  terminalControl: TerminalClearLike;
  stdout: ClearBoundaryStdoutLike;
  source?: string;
  /**
   * Reports whether the committing render tree is an overlay screen (any
   * screen other than "main"). Read at frame-write time so alternate-screen
   * enter/exit happens atomically with the first frame of the new screen —
   * never from an effect that runs after the frame already hit the wrong
   * buffer. The callback must reflect the render that produced the frame
   * (app.tsx passes a ref assigned during render).
   */
  isOverlayActive?: () => boolean;
  /**
   * Called synchronously whenever a width change requires the home/transcript
   * content to be rebuilt. The physical clear is DEFERRED until the caller has
   * re-rendered with a fresh <Static> instance: Ink's <Static> never re-emits
   * items once flushed, so the boundary suppresses frames until a frame
   * arrives that carries the re-flushed static content, then clears and writes
   * that frame atomically. The caller must use this to force a fresh render
   * with a new <Static> key so its content gets reflushed at the new width.
   */
  onWidthResizeRefresh?: () => void;
  /**
   * Reports the repaint generation of the committing render tree (the counter
   * onWidthResizeRefresh bumps), read at frame-write time like isOverlayActive.
   * Lets the boundary tell the genuine post-bump <Static> re-flush apart from
   * an incremental pre-resize static chunk that happens to land while the
   * repaint is pending — committing the latter would clear the scrollback and
   * then write only that chunk, losing the rest of the transcript.
   */
  getRenderedRepaintGeneration?: () => number;
  /**
   * Reports the raw terminal column count the committing render tree was laid
   * out against, read at frame-write time. The viewport hook commits new
   * dimensions on a trailing settle (~100ms after the resize event), so the
   * <Static> re-flush must not be requested until a commit whose layout
   * already matches stdout.columns — remounting earlier would re-flush the
   * transcript at the pre-resize width.
   */
  getRenderedLayoutCols?: () => number | undefined;
}

interface FrameMarkerCounts {
  codexaLogoCount: number;
  providerMigratedCount: number;
  launchModeCount: number;
  composerCount: number;
  footerCount: number;
}

const LOGO_LINE = /██╔════╝██╔═══██╗/g;
const PROVIDER_MIGRATED = /Provider migrated/g;
const LAUNCH_MODE = /Launch mode/g;
const COMPOSER = /│ ❯/g;
const FOOTER_CONTEXT = /Context:/g;
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/**
 * Safety valve for the deferred width repaint: if the re-flushed static frame
 * never arrives (unexpected render stall), stop suppressing and commit the
 * next frame with whatever static content Ink has accumulated, so the UI can
 * never freeze behind the gate.
 */
const WIDTH_REPAINT_MAX_SUPPRESSED_FRAMES = 8;

function stableFrameHash(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text)) count += 1;
  pattern.lastIndex = 0;
  return count;
}

function countFrameMarkers(text: string): FrameMarkerCounts {
  const plainText = text.replace(ANSI_SEQUENCE, "");
  return {
    codexaLogoCount: countMatches(plainText, LOGO_LINE),
    providerMigratedCount: countMatches(plainText, PROVIDER_MIGRATED),
    launchModeCount: countMatches(plainText, LAUNCH_MODE),
    composerCount: countMatches(plainText, COMPOSER),
    footerCount: countMatches(plainText, FOOTER_CONTEXT),
  };
}

function buildFrameText(instance: InkRenderInstance, output: string, staticOutput = ""): string {
  const fullStaticOutput = instance.fullStaticOutput ?? "";
  if (!staticOutput) return `${fullStaticOutput}${output}`;
  if (!fullStaticOutput || staticOutput.includes(fullStaticOutput)) {
    return `${staticOutput}${output}`;
  }
  return `${fullStaticOutput}${staticOutput}${output}`;
}

function snapshotFrameState(instance: InkRenderInstance, logShadow: LogShadowState) {
  return {
    lastOutputLength: (instance.lastOutput ?? "").length,
    lastOutputToRenderLength: (instance.lastOutputToRender ?? "").length,
    lastOutputHeight: instance.lastOutputHeight ?? 0,
    fullStaticOutputLength: (instance.fullStaticOutput ?? "").length,
    logPreviousOutputLength: logShadow.previousOutputLength,
    logPreviousLineCount: logShadow.previousLineCount,
  };
}

function lineCountForOutput(output: string): number {
  if (output.length === 0) return 0;
  return output.split("\n").length;
}

function countAnsiMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text)) count += 1;
  pattern.lastIndex = 0;
  return count;
}

function inspectControlSequences(output: string): TerminalControlSequenceStats {
  return {
    cursorUpCount: countAnsiMatches(output, /\x1b\[[0-9]*A/g),
    cursorHomeCount: countAnsiMatches(output, /\x1b\[[0-9;]*H/g),
    eraseLineCount: countAnsiMatches(output, /\x1b\[[0-9]*K/g),
    eraseDisplayCount: countAnsiMatches(output, /\x1b\[[0-9]*J/g),
    carriageReturnCount: countAnsiMatches(output, /\r/g),
  };
}

function wrapInkLogForTrace(
  instance: InkRenderInstance,
  source: string,
  shadow: LogShadowState,
): () => void {
  const currentLog = instance.log;
  if (typeof currentLog !== "function") {
    return () => {};
  }

  const original = currentLog as InkLogLike;

  const wrapped: InkLogLike = ((output: string) => {
    const before = { ...shadow };
    const controlSequences = inspectControlSequences(output);
    const result = original(output);
    shadow.previousOutputLength = output.length;
    shadow.previousLineCount = lineCountForOutput(output);
    renderDebug.traceEvent("terminal", "inkLogWrite", {
      source,
      outputLength: output.length,
      outputHash: stableFrameHash(output),
      previousOutputLengthBefore: before.previousOutputLength,
      previousLineCountBefore: before.previousLineCount,
      previousOutputLengthAfter: shadow.previousOutputLength,
      previousLineCountAfter: shadow.previousLineCount,
      ...controlSequences,
    });
    return result;
  }) as InkLogLike;

  wrapped.clear = () => {
    const before = { ...shadow };
    const result = original.clear?.();
    shadow.previousOutputLength = 0;
    shadow.previousLineCount = 0;
    renderDebug.traceEvent("terminal", "inkLogClear", {
      source,
      previousOutputLengthBefore: before.previousOutputLength,
      previousLineCountBefore: before.previousLineCount,
      previousOutputLengthAfter: shadow.previousOutputLength,
      previousLineCountAfter: shadow.previousLineCount,
    });
    return result;
  };

  wrapped.sync = (output: string) => {
    const before = { ...shadow };
    const controlSequences = inspectControlSequences(output);
    const result = original.sync?.(output);
    shadow.previousOutputLength = output.length;
    shadow.previousLineCount = lineCountForOutput(output);
    renderDebug.traceEvent("terminal", "inkLogSync", {
      source,
      outputLength: output.length,
      previousOutputLengthBefore: before.previousOutputLength,
      previousLineCountBefore: before.previousLineCount,
      previousOutputLengthAfter: shadow.previousOutputLength,
      previousLineCountAfter: shadow.previousLineCount,
      ...controlSequences,
    });
    return result;
  };

  wrapped.reset = () => {
    const before = { ...shadow };
    const result = original.reset?.();
    shadow.previousOutputLength = 0;
    shadow.previousLineCount = 0;
    renderDebug.traceEvent("terminal", "inkLogReset", {
      source,
      previousOutputLengthBefore: before.previousOutputLength,
      previousLineCountBefore: before.previousLineCount,
      previousOutputLengthAfter: shadow.previousOutputLength,
      previousLineCountAfter: shadow.previousLineCount,
    });
    return result;
  };

  wrapped.willRender = original.willRender ? (output: string) => original.willRender?.(output) : undefined;
  wrapped.isCursorDirty = original.isCursorDirty ? () => original.isCursorDirty?.() : undefined;

  instance.log = wrapped as unknown as { reset?: () => void };

  return () => {
    instance.log = original as unknown as { reset?: () => void };
  };
}

export function createClearFrameBoundaryController({
  instance,
  terminalControl,
  stdout,
  source = "src/core/terminal/clearFrameBoundary.ts",
  isOverlayActive,
  onWidthResizeRefresh,
  getRenderedRepaintGeneration,
  getRenderedLayoutCols,
}: CreateClearFrameBoundaryOptions): ClearFrameBoundaryController | null {
  const originalRenderInteractiveFrame = instance?.renderInteractiveFrame;
  if (!instance || typeof originalRenderInteractiveFrame !== "function") {
    renderDebug.traceEvent("terminal", "clearBoundaryInit", {
      source,
      liveInkInstanceResolved: Boolean(instance),
      renderInteractiveFrameResolved: false,
    });
    return null;
  }

  let clearPending = false;
  let pendingGeneration: number | null = null;
  let committedGeneration: number | null = null;
  let renderGeneration = 0;
  let transcriptCleared = false;
  let clearGenerationReady = false;
  let staticEventsLength = 0;
  let activeEventsLength = 0;
  let uiStateKind = "IDLE";
  let lastFrameWasAuthoritative = false;
  let suppressedPostClearStaticOutput = "";
  // Deferred width repaint: armed when the terminal width changes under a
  // main-screen frame, resolved when the re-flushed static frame arrives.
  let widthRepaintPending = false;
  let widthRepaintSuppressedFrames = 0;
  let widthRepaintTargetGeneration: number | null = null;
  let widthRepaintReflushRequested = false;
  // Alternate-screen overlay state. While an overlay is active, the normal
  // buffer's Ink caches are parked here so diffing can resume against the
  // buffer's true contents when the overlay exits (DECSET 1049 restores the
  // normal buffer byte-for-byte).
  let overlayActive = false;
  let savedNormalFrame: SavedNormalBufferFrame | null = null;
  let overlayCapturedStaticOutput = "";
  let previousCols = stdout.columns;
  let previousRows = stdout.rows;
  const logShadow: LogShadowState = { previousOutputLength: 0, previousLineCount: 0 };

  const restoreLog = wrapInkLogForTrace(instance, source, logShadow);
  const boundOriginal = originalRenderInteractiveFrame.bind(instance);

  const isPostClearFrameReady = (): boolean => {
    if (!clearPending || pendingGeneration === null) return false;
    return renderGeneration >= pendingGeneration && (transcriptCleared || clearGenerationReady);
  };

  const setAlternateScreen = (enabled: boolean, reason: string): void => {
    terminalControl.setAlternateScreen?.(enabled, `${source}:${reason}`);
  };

  /**
   * Ink's onRender appends this frame's static chunk to fullStaticOutput
   * BEFORE calling renderInteractiveFrame. When the chunk must not land in the
   * currently active buffer (overlay frames), peel it back off so the cache
   * keeps describing the normal buffer only.
   */
  const detachStaticChunkFromFullStatic = (staticOutput: string): void => {
    if (!staticOutput) return;
    const fullStatic = instance.fullStaticOutput ?? "";
    if (fullStatic.endsWith(staticOutput)) {
      instance.fullStaticOutput = fullStatic.slice(0, fullStatic.length - staticOutput.length);
    }
  };

  const armWidthRepaint = (reason: string): void => {
    widthRepaintPending = true;
    widthRepaintSuppressedFrames = 0;
    widthRepaintTargetGeneration = null;
    // The <Static> re-flush is requested later, from the first suppressed
    // frame whose committed layout already matches the new terminal width —
    // requesting it here would remount <Static> against the pre-resize layout
    // (the viewport hook commits dimensions on a trailing settle).
    widthRepaintReflushRequested = false;
    renderDebug.traceEvent("terminal", "widthRepaintArmed", {
      source,
      reason,
      currentCols: stdout.columns,
    });
  };

  const commitAuthoritativeFrame = (
    output: string,
    outputHeight: number,
    staticOutput: string,
    clearMode: "transcript" | "viewport",
    reason: string,
  ): void => {
    traceTerminalClear(`${source}:${reason}`, {
      mode: clearMode,
      clearGeneration: pendingGeneration ?? committedGeneration,
    });
    if (clearMode === "transcript") {
      terminalControl.clearTranscript(`${source}:${reason}`);
    } else {
      terminalControl.clearViewport(`${source}:${reason}`);
    }
    const resetRan = resetInkOutputForFreshFrame({ instance, columns: stdout.columns });
    renderDebug.traceEvent("terminal", "authoritativeFrameCommit", {
      source,
      reason,
      clearMode,
      inkCacheResetEmitted: resetRan,
      staticLength: staticOutput.length,
      outputLength: output.length,
    });
    lastFrameWasAuthoritative = true;
    boundOriginal(output, outputHeight, staticOutput);
    // Keep fullStaticOutput describing what is actually above the live frame in
    // this buffer; onRender's accumulation was wiped by the cache reset above.
    instance.fullStaticOutput = staticOutput;
  };

  instance.renderInteractiveFrame = (output: string, outputHeight: number, staticOutput: string) => {
    const currentCols = stdout.columns;
    const currentRows = stdout.rows;
    const widthChanged = previousCols !== currentCols;
    const resizeDetected = widthChanged || previousRows !== currentRows;
    const overlayNow = Boolean(isOverlayActive?.());
    previousCols = currentCols;
    previousRows = currentRows;

    if (resizeDetected) {
      renderDebug.traceEvent("terminal", "resizeAfterClear", {
        currentCols,
        currentRows,
        widthChanged,
        clearPending,
        widthRepaintPending,
        overlayActive,
        overlayNow,
      });
    }

    // ── Overlay enter: main → overlay ─────────────────────────────────────
    // Switch buffers BEFORE the overlay frame is written so it lands in the
    // alternate screen, never in the normal buffer/scrollback.
    if (overlayNow && !overlayActive) {
      detachStaticChunkFromFullStatic(staticOutput);
      savedNormalFrame = {
        lastOutput: instance.lastOutput ?? "",
        lastOutputToRender: instance.lastOutputToRender ?? "",
        lastOutputHeight: instance.lastOutputHeight ?? 0,
        fullStaticOutput: instance.fullStaticOutput ?? "",
        cols: currentCols,
      };
      // Static content that arrives from this frame on belongs to the normal
      // buffer's transcript — hold it until the overlay exits.
      overlayCapturedStaticOutput = staticOutput;
      overlayActive = true;
      setAlternateScreen(true, "overlayEnter");
      // DECSET 1049 keeps the cursor where the normal buffer left it; home it
      // so the overlay frame starts at the top of the blank alternate buffer.
      terminalControl.clearViewport(`${source}:overlayEnter`);
      resetInkOutputForFreshFrame({ instance, columns: currentCols });
      renderDebug.traceEvent("terminal", "overlayEnter", {
        source,
        currentCols,
        currentRows,
        savedLastOutputHeight: savedNormalFrame.lastOutputHeight,
        capturedStaticLength: overlayCapturedStaticOutput.length,
      });
      boundOriginal(output, outputHeight, "");
      return;
    }

    // ── Overlay exit: overlay → main ──────────────────────────────────────
    if (!overlayNow && overlayActive) {
      overlayActive = false;
      detachStaticChunkFromFullStatic(staticOutput);
      setAlternateScreen(false, "overlayExit");

      const saved = savedNormalFrame;
      savedNormalFrame = null;
      const pendingStatic = `${overlayCapturedStaticOutput}${staticOutput}`;
      overlayCapturedStaticOutput = "";

      if (clearPending) {
        // A /clear was issued while the overlay was open; the post-clear gate
        // owns the next authoritative frame. Fall through to the clear
        // machinery below with the caches untouched.
        if (pendingStatic) {
          suppressedPostClearStaticOutput = pendingStatic;
        }
      } else {
        // DECSET 1049l restored the normal buffer exactly as saved; restore the
        // caches so Ink diffs against what is really on screen.
        if (saved) {
          instance.lastOutput = saved.lastOutput;
          instance.lastOutputToRender = saved.lastOutputToRender;
          instance.lastOutputHeight = saved.lastOutputHeight;
          instance.fullStaticOutput = saved.fullStaticOutput;
          (instance.log as InkLogLike | undefined)?.sync?.(saved.lastOutputToRender);
        }
        renderDebug.traceEvent("terminal", "overlayExit", {
          source,
          currentCols,
          currentRows,
          widthChangedWhileAway: saved ? saved.cols !== currentCols : false,
          pendingStaticLength: pendingStatic.length,
        });

        if (saved && saved.cols !== currentCols) {
          // The terminal was resized while the overlay was open; the restored
          // normal buffer reflowed and is stale. Repaint it from scratch. The
          // remounted <Static> re-emits everything held in React state, so the
          // pending chunks are covered by the re-flush.
          armWidthRepaint("overlayExitWidthChanged");
          return;
        }

        instance.fullStaticOutput = `${instance.fullStaticOutput ?? ""}${pendingStatic}`;
        boundOriginal(output, outputHeight, pendingStatic);
        return;
      }
    }

    // ── Overlay steady state ──────────────────────────────────────────────
    if (overlayNow) {
      if (staticOutput) {
        // Transcript rows flushed while the overlay is open would be written
        // into the alternate buffer and lost on exit; hold them instead.
        detachStaticChunkFromFullStatic(staticOutput);
        overlayCapturedStaticOutput += staticOutput;
      }
      if (widthChanged) {
        // The alternate buffer has no scrollback; a viewport clear plus a full
        // rewrite is a complete repaint.
        terminalControl.clearViewport(`${source}:overlayResize`);
        resetInkOutputForFreshFrame({ instance, columns: currentCols });
        lastFrameWasAuthoritative = true;
      }
      boundOriginal(output, outputHeight, "");
      return;
    }

    // ── Main screen: /clear generation gate ───────────────────────────────
    const postClearReady = isPostClearFrameReady();
    const isFirstPostClearCommit = clearPending && postClearReady;
    const staleFrameSuppressed = clearPending && !postClearReady;

    // ── Main screen: deferred width repaint ───────────────────────────────
    // A width change reflows the previously-rendered frame; a diffed write
    // would leave that reflowed frame stacked behind the new one — GNOME
    // Terminal keeps it in scrollback on a grow and re-exposes it. But this
    // frame was still built from React state that may predate the resize, and
    // <Static> never re-emits flushed content on its own. So: suppress frames
    // until the caller has re-rendered with a fresh <Static> (its re-flushed
    // content arrives as staticOutput), then clear scrollback and write that
    // frame atomically. Skip while a clear is pending: that path owns the next
    // authoritative frame and already repaints from a clean baseline.
    if (widthChanged && !clearPending && !widthRepaintPending) {
      armWidthRepaint("widthChanged");
    }

    if (widthRepaintPending && !clearPending) {
      widthRepaintSuppressedFrames += 1;

      // Phase 1: wait for a commit whose layout matches the new terminal
      // width (the viewport hook commits dimensions on a trailing settle),
      // then request the <Static> re-flush exactly once.
      const renderedLayoutCols = getRenderedLayoutCols?.();
      const layoutReady = getRenderedLayoutCols === undefined
        || renderedLayoutCols === currentCols;
      if (!widthRepaintReflushRequested) {
        if (layoutReady && widthRepaintSuppressedFrames <= WIDTH_REPAINT_MAX_SUPPRESSED_FRAMES) {
          widthRepaintReflushRequested = true;
          widthRepaintTargetGeneration = getRenderedRepaintGeneration
            ? getRenderedRepaintGeneration() + 1
            : null;
          renderDebug.traceEvent("terminal", "widthRepaintReflushRequested", {
            source,
            currentCols,
            suppressedFrames: widthRepaintSuppressedFrames,
            targetGeneration: widthRepaintTargetGeneration,
          });
          onWidthResizeRefresh?.();
          // This frame still carries the pre-remount static state; suppress it
          // and commit the re-flushed frame the bump produces.
          if (getRenderedRepaintGeneration !== undefined) {
            return;
          }
        }
      }

      // Phase 2: commit the first frame that carries the re-flushed static
      // content from the post-bump render.
      const repaintGenerationRendered = widthRepaintTargetGeneration === null
        || (getRenderedRepaintGeneration?.() ?? 0) >= widthRepaintTargetGeneration;
      const repaintFrameReady = staticOutput !== ""
        && repaintGenerationRendered
        && widthRepaintReflushRequested;
      if (repaintFrameReady) {
        widthRepaintPending = false;
        widthRepaintTargetGeneration = null;
        widthRepaintReflushRequested = false;
        commitAuthoritativeFrame(output, outputHeight, staticOutput, "transcript", "resizeRefresh");
        renderDebug.traceEvent("terminal", "resizeRefreshCommitted", {
          committedGeneration,
          currentCols,
          resizeRefreshConsumed: true,
          ...countFrameMarkers(`${staticOutput}${output}`),
        });
        return;
      }
      if (widthRepaintSuppressedFrames <= WIDTH_REPAINT_MAX_SUPPRESSED_FRAMES) {
        renderDebug.traceEvent("terminal", "widthRepaintFrameSuppressed", {
          source,
          suppressedFrames: widthRepaintSuppressedFrames,
          currentCols,
          layoutReady,
          reflushRequested: widthRepaintReflushRequested,
        });
        return;
      }
      // Safety valve: never freeze the UI behind the gate. Repaint with the
      // static content Ink has accumulated, even if it predates the resize.
      widthRepaintPending = false;
      widthRepaintTargetGeneration = null;
      widthRepaintReflushRequested = false;
      commitAuthoritativeFrame(
        output,
        outputHeight,
        staticOutput || (instance.fullStaticOutput ?? ""),
        "transcript",
        "resizeRefreshFallback",
      );
      return;
    }

    const frameClassification = isFirstPostClearCommit
      ? "post-clear"
      : (clearPending ? "pre-clear" : "normal");
    const effectiveStaticOutput = isFirstPostClearCommit && !staticOutput && suppressedPostClearStaticOutput
      ? suppressedPostClearStaticOutput
      : staticOutput;
    const frameText = isFirstPostClearCommit
      ? `${effectiveStaticOutput}${output}`
      : buildFrameText(instance, output, staticOutput);
    const markerCounts = countFrameMarkers(frameText);
    const frameHash = stableFrameHash(frameText);
    const clearGenerationUsed = isFirstPostClearCommit ? pendingGeneration : committedGeneration;
    const before = snapshotFrameState(instance, logShadow);

    renderDebug.traceEvent("terminal", "clearBoundaryFrame", {
      clearPending,
      pendingGeneration,
      committedGeneration,
      renderGeneration,
      transcriptCleared,
      staticEventsLength,
      activeEventsLength,
      uiStateKind,
      frameClassification,
      isPostClearFrame: postClearReady,
      staleFrameSuppressed,
      frameWriteAllowed: !staleFrameSuppressed,
      widthChanged,
      currentCols,
      currentRows,
      clearGenerationUsed,
      frameLength: frameText.length,
      frameHash,
      ...markerCounts,
      ...before,
      previousLineCountBefore: before.logPreviousLineCount,
      lastOutputHeightBefore: before.lastOutputHeight,
      physicalClearImmediatelyBeforeFrame: isFirstPostClearCommit,
    });

    if (staleFrameSuppressed) {
      if (staticOutput) {
        suppressedPostClearStaticOutput = staticOutput;
      }
      return;
    }

    if (isFirstPostClearCommit) {
      commitAuthoritativeFrame(output, outputHeight, effectiveStaticOutput, "transcript", "firstPostClearFrame");
      renderDebug.traceEvent("terminal", "clearBoundaryCommit", {
        clearGeneration: pendingGeneration,
        physicalTerminalClearEmitted: true,
        before,
        afterReset: snapshotFrameState(instance, logShadow),
      });
    } else {
      lastFrameWasAuthoritative = false;
      boundOriginal(output, outputHeight, effectiveStaticOutput);
    }

    const after = snapshotFrameState(instance, logShadow);
    renderDebug.traceEvent("terminal", "clearBoundaryFrameCommitted", {
      clearPending,
      pendingGeneration,
      committedGeneration,
      renderGeneration,
      transcriptCleared,
      frameClassification: isFirstPostClearCommit ? "post-clear-authoritative" : frameClassification,
      frameLength: frameText.length,
      frameHash,
      ...markerCounts,
      ...after,
      diffedFrame: !isFirstPostClearCommit,
      fullAuthoritativeFrame: isFirstPostClearCommit,
      widthChanged,
      currentCols,
      currentRows,
      clearGenerationUsed,
      previousLineCountAfter: after.logPreviousLineCount,
      lastOutputHeightAfter: after.lastOutputHeight,
      physicalClearImmediatelyBeforeFrame: isFirstPostClearCommit,
    });

    if (isFirstPostClearCommit) {
      committedGeneration = pendingGeneration;
      clearPending = false;
      pendingGeneration = null;
      suppressedPostClearStaticOutput = "";
      renderDebug.traceEvent("terminal", "firstCommittedPostClearFrame", {
        committedGeneration,
        frameHash,
        firstFrameAuthoritative: true,
        ...markerCounts,
      });
    }
  };

  renderDebug.traceEvent("terminal", "clearBoundaryInit", {
    source,
    liveInkInstanceResolved: true,
    renderInteractiveFrameResolved: true,
  });

  return {
    beginClearGeneration(generation) {
      if (!Number.isFinite(generation)) return false;
      clearPending = true;
      pendingGeneration = generation;
      suppressedPostClearStaticOutput = "";
      // The post-clear frame repaints from a physically cleared baseline, which
      // supersedes any in-flight width repaint.
      widthRepaintPending = false;
      renderDebug.traceEvent("terminal", "clearBoundaryBegin", {
        clearGeneration: generation,
        clearPending,
        renderGeneration,
        transcriptCleared,
        staticEventsLength,
        activeEventsLength,
        uiStateKind,
        before: snapshotFrameState(instance, logShadow),
      });
      return true;
    },
    syncRenderState(state) {
      if (!Number.isFinite(state.generation)) return false;
      renderGeneration = state.generation;
      transcriptCleared = state.transcriptCleared;
      clearGenerationReady = state.clearGenerationReady === true;
      staticEventsLength = state.staticEventsLength;
      activeEventsLength = state.activeEventsLength;
      uiStateKind = state.uiStateKind;
      // Ink writes a frame during the React commit (resetAfterCommit), which runs
      // BEFORE the passive effect that calls this. So the cleared frame's
      // renderInteractiveFrame already ran (and was suppressed) against the stale
      // gate. When the gate is now satisfiable, signal the host to force exactly
      // one more render so the authoritative post-clear frame is flushed.
      const postClearRepaintPending = clearPending && isPostClearFrameReady();
      renderDebug.traceEvent("terminal", "clearBoundaryRenderState", {
        renderGeneration,
        transcriptCleared,
        clearGenerationReady,
        staticEventsLength,
        activeEventsLength,
        uiStateKind,
        clearPending,
        pendingGeneration,
        committedGeneration,
        postClearRepaintPending,
      });
      return postClearRepaintPending;
    },
    getState() {
      return {
        clearPending,
        pendingGeneration,
        committedGeneration,
        renderGeneration,
        transcriptCleared,
        lastFrameWasAuthoritative,
        widthRepaintPending,
        overlayActive,
        logShadow: { ...logShadow },
      };
    },
    dispose() {
      if (overlayActive) {
        setAlternateScreen(false, "dispose");
        overlayActive = false;
      }
      instance.renderInteractiveFrame = originalRenderInteractiveFrame;
      restoreLog();
    },
  };
}
