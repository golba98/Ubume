/**
 * Responsive layout constants and hook.
 *
 * Five modes based on both terminal columns and rows:
 *
 *   micro    very small rows/cols → one-line shell
 *   compact  normal short terminal → compact shell, no large logo
 *   normal   standard terminal → compact header, roomy content
 *   wide     large terminal → decorative header allowed
 *   max      maximized terminal → full decorative layout
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useStdout } from "ink";
import stringWidth from "string-width";
import * as renderDebug from "../core/perf/renderDebug.js";
import { setTerminalResizing, isTerminalResizing } from "../core/terminal/terminalControl.js";

export const BREAKPOINT_MAX = 180;
export const BREAKPOINT_WIDE = 140;
export const BREAKPOINT_NORMAL = 90;
export const BREAKPOINT_COMPACT = 60;
export const ROW_BREAKPOINT_MAX = 40;
export const ROW_BREAKPOINT_WIDE = 30;
export const ROW_BREAKPOINT_NORMAL = 20;
export const ROW_BREAKPOINT_COMPACT = 14;
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 10;
export const MIN_VIEWPORT_COLS = 20;
export const MIN_VIEWPORT_ROWS = 10;
export const RESTORE_SETTLE_MS = process.env.NODE_ENV === "test" ? 0 : 100;
export const STARTUP_TINY_MIN_COLS = 40;
export const STARTUP_TINY_MIN_ROWS = 14;
export const STARTUP_FULL_MIN_COLS = 100; // matches LOGO_LARGE_MIN_COLS in logoVariants.ts
export const STARTUP_FULL_MIN_BODY_ROWS = 4;
export const STARTUP_FULL_SAFE_PADDING_ROWS = 1;
export const STARTUP_COMPACT_INTRO_ROWS = 4;
export const STARTUP_TINY_MESSAGE_ROWS = 3;
export const transcriptContentIndent = 4; // 2 for DashCard border + 2 for prompt prefix
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 24;

export type LayoutMode = "compact" | "regular" | "expanded";
export type StartupHeaderMode = "large" | "compact" | "tiny";

export interface Layout {
  cols: number;
  rows: number;
  mode: LayoutMode;
}

export type PanelLayout = {
  mode: "compact" | "regular" | "expanded";
  availableRows: number;
  availableCols: number;
};

export type BottomChromeBudget = {
  runtimeMetadataRows: number;
  composerRows: number;
  transientStatusRows: number;
  bottomPaddingRows: number;
  totalRows: number;
};

export type AppLayoutBudget = {
  mode: LayoutMode;
  rows: number;
  cols: number;

  headerRows: number;
  headerGapRows: number;
  panelStagePaddingY: number;

  activePanelRows: number;
  activePanelCols: number;

  bottomChromeBudget: BottomChromeBudget;
  composerRows: number;

  showNormalLogo: boolean;
  showCompactHeader: boolean;
  placeMetadataBesideLogo: boolean;
  placeMetadataBelowLogo: boolean;

  // Backward compatibility fields:
  transcriptRows: number;
  panelRows: number;
  showLargeLogo: boolean;
  showPanelSeparators: boolean;
  showPanelColumnHeaders: boolean;
};

export const PanelAvailableRowsContext = createContext<number | undefined>(undefined);
export const AppLayoutBudgetContext = createContext<AppLayoutBudget | undefined>(undefined);
export const PanelLayoutContext = createContext<PanelLayout | undefined>(undefined);

export interface ActivePanelLayout {
  width: number;
  height: number;
  availableRows: number;
  availableCols: number;
}

export const ActivePanelLayoutContext = createContext<ActivePanelLayout | undefined>(undefined);

export function usePanelAvailableRows(): number | undefined {
  return useContext(PanelAvailableRowsContext);
}

export function useAppLayoutBudget(): AppLayoutBudget | undefined {
  return useContext(AppLayoutBudgetContext);
}

export function useActivePanelLayout(): ActivePanelLayout | undefined {
  return useContext(ActivePanelLayoutContext);
}

export function usePanelLayout(): PanelLayout | undefined {
  return useContext(PanelLayoutContext);
}

export interface TerminalViewport extends Layout {
  rawCols?: number;
  rawRows?: number;
  contentWidth: number;
  isCramped: boolean;
  unstable: boolean;
  layoutEpoch: number;
  isResizing: boolean;
}

// ─── Dimension helpers ────────────────────────────────────────────────────────

function isValidDimension(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizeDimension(value: number | undefined, fallback: number): number {
  if (!isValidDimension(value)) {
    // If even the fallback is invalid, use an absolute floor.
    return isValidDimension(fallback) ? Math.floor(fallback) : 10;
  }

  return Math.floor(value);
}

export function isRenderableViewport(cols: number | undefined, rows: number | undefined): boolean {
  return isValidDimension(cols)
    && isValidDimension(rows)
    && Math.floor(cols) >= MIN_VIEWPORT_COLS
    && Math.floor(rows) >= MIN_VIEWPORT_ROWS;
}

/** Returns true if the terminal is below the minimum supported size for a full UI. */
export function isCrampedTerminal(cols: number | undefined, rows: number | undefined): boolean {
  const safeCols = normalizeDimension(cols, DEFAULT_COLUMNS);
  const safeRows = normalizeDimension(rows, DEFAULT_ROWS);
  return safeCols < MIN_TERMINAL_COLS || safeRows < MIN_TERMINAL_ROWS;
}

/**
 * Leave a 1-column gutter so box-drawing borders never land exactly on the
 * terminal edge, which can trigger a horizontal scrollbar in some Windows hosts.
 */
export function getShellWidth(cols: number | undefined): number {
  return Math.max(20, (cols ?? 120) - 1);
}

/**
 * Returns the responsive width of the main content area. Large/maximized
 * terminals retain a small gutter but continue growing with the viewport.
 */
export function getContentWidth(cols: number | undefined): number {
  const shellWidth = getShellWidth(cols);

  if (shellWidth < 100) return shellWidth;
  if (shellWidth < 150) return shellWidth - 4;
  if (shellWidth < 200) return shellWidth - 8;

  return shellWidth - 12;
}

export function getUsableShellWidth(cols: number | undefined, reservedColumns = 0): number {
  return Math.max(1, getShellWidth(cols) - reservedColumns);
}

/**
 * Leave a 1-row gutter so renders do not land exactly on the terminal bottom
 * edge, which can trigger viewport scroll drift in some hosts.
 */
export function getShellHeight(rows: number | undefined): number {
  return Math.max(10, (rows ?? DEFAULT_ROWS) - 1);
}

export interface StartupHeaderModeParams {
  cols: number | undefined;
  rows: number | undefined;
  introRows: number;
  composerRows: number;
}

export function resolveStartupHeaderMode({
  cols,
  rows,
  introRows,
  composerRows,
}: StartupHeaderModeParams): StartupHeaderMode {
  const safeCols = normalizeDimension(cols, DEFAULT_COLUMNS);
  const safeRows = normalizeDimension(rows, DEFAULT_ROWS);

  if (safeCols < STARTUP_TINY_MIN_COLS || safeRows < STARTUP_TINY_MIN_ROWS) {
    return "tiny";
  }

  const shellHeight = getShellHeight(safeRows);
  const fullStartupRows = introRows
    + composerRows
    + STARTUP_FULL_MIN_BODY_ROWS
    + STARTUP_FULL_SAFE_PADDING_ROWS;

  if (safeCols >= STARTUP_FULL_MIN_COLS && shellHeight >= fullStartupRows) {
    return "large";
  }

  return "compact";
}

export function getVisualWidth(text: string): number {
  return stringWidth(text);
}

export function clampVisualText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (getVisualWidth(text) <= maxWidth) return text;

  const ellipsis = maxWidth > 1 ? "…" : "";
  const suffixWidth = getVisualWidth(ellipsis);
  let output = "";

  for (const char of Array.from(text)) {
    if (getVisualWidth(output + char) + suffixWidth > maxWidth) {
      break;
    }
    output += char;
  }

  return output + ellipsis;
}

export function computeMode(cols: number, rows: number): LayoutMode {
  if (rows <= 24 || cols <= 100) {
    return "compact";
  }
  if (cols >= 140 && rows >= 30) {
    return "expanded";
  }
  return "regular";
}

export function isDecorativeLayoutMode(mode: LayoutMode): boolean {
  return mode === "expanded";
}

export function isCompactShellMode(mode: LayoutMode): boolean {
  return mode === "compact" || mode === "regular";
}

export interface AppLayoutBudgetParams {
  cols: number | undefined;
  rows: number | undefined;
  composerRows?: number;
  panelHintRows?: number;
  headerRows?: number;
  headerGapRows?: number;
}

export function computeAppLayoutBudget({
  cols,
  rows,
  composerRows = 4,
  panelHintRows = 0,
  headerRows,
  headerGapRows,
}: AppLayoutBudgetParams): AppLayoutBudget {
  const safeCols = normalizeDimension(cols, DEFAULT_COLUMNS);
  const safeRows = normalizeDimension(rows, DEFAULT_ROWS);
  const mode = computeMode(safeCols, safeRows);
  const shellHeight = getShellHeight(safeRows);

  const showNormalLogo =
    process.env["UBUME_NO_ASCII_LOGO"] !== "1" && (
      mode === "regular" ||
      mode === "expanded" ||
      (mode === "compact" && safeCols >= 72)
    );

  const showCompactHeader = !showNormalLogo;

  const placeMetadataBesideLogo =
    showNormalLogo && safeCols >= 95;

  const placeMetadataBelowLogo =
    showNormalLogo && !placeMetadataBesideLogo;

  const resolvedHeaderRows = headerRows ?? (showNormalLogo ? 6 : 1);
  const resolvedHeaderGapRows = headerGapRows ?? (mode === "compact" ? 0 : 1);
  const panelStagePaddingY = mode === "compact" ? 0 : 1;
  const resolvedComposerRows = mode === "compact" ? 3 : Math.max(0, composerRows);
  const runtimeMetadataRows = 1;
  const transientStatusRows = 0;
  const bottomPaddingRows = mode === "compact" ? 0 : 1;
  const bottomChromeBudget: BottomChromeBudget = {
    runtimeMetadataRows,
    composerRows: resolvedComposerRows,
    transientStatusRows,
    bottomPaddingRows,
    totalRows: runtimeMetadataRows + resolvedComposerRows + transientStatusRows + bottomPaddingRows,
  };
  const baseReservedRows =
    resolvedHeaderRows +
    resolvedHeaderGapRows +
    panelStagePaddingY * 2 +
    bottomChromeBudget.totalRows +
    Math.max(0, panelHintRows);

  const activePanelRows = Math.max(1, shellHeight - baseReservedRows);
  const contentWidth = getContentWidth(safeCols);
  
  const isCompact = mode === "compact";
  const borderRows = 2;
  const titleRows = 1;
  const headerRowsInPanel = isCompact ? 0 : 1;
  const panelChromeRows = borderRows + titleRows + headerRowsInPanel;
  const innerAvailableRows = Math.max(1, activePanelRows - panelChromeRows);

  const borderCols = 4;
  const innerAvailableCols = Math.max(20, contentWidth - borderCols);

  return {
    mode,
    rows: safeRows,
    cols: safeCols,
    headerRows: resolvedHeaderRows,
    headerGapRows: resolvedHeaderGapRows,
    panelStagePaddingY,
    activePanelRows: innerAvailableRows,
    activePanelCols: innerAvailableCols,
    bottomChromeBudget,
    composerRows: resolvedComposerRows,
    showNormalLogo,
    showCompactHeader,
    placeMetadataBesideLogo,
    placeMetadataBelowLogo,
    
    // Backward compatibility fields:
    transcriptRows: activePanelRows,
    panelRows: innerAvailableRows,
    showLargeLogo: mode === "expanded",
    showPanelSeparators: mode === "expanded",
    showPanelColumnHeaders: mode === "expanded",
  };
}

export function createLayoutSnapshot(
  cols: number | undefined,
  rows: number | undefined,
  fallback: Layout = {
    cols: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS,
    mode: computeMode(DEFAULT_COLUMNS, DEFAULT_ROWS),
  },
): TerminalViewport {
  const nextCols = normalizeDimension(cols, fallback.cols);
  const nextRows = normalizeDimension(rows, fallback.rows);

  const stableLayout = {
    cols: nextCols,
    rows: nextRows,
    mode: computeMode(nextCols, nextRows),
  };

  const isCramped = isCrampedTerminal(nextCols, nextRows);
  const contentWidth = getContentWidth(nextCols);

  return {
    ...stableLayout,
    contentWidth,
    isCramped,
    unstable: false,
    layoutEpoch: 0,
    isResizing: false,
  };
}

function snapshot(stdout: NodeJS.WriteStream, fallback?: Layout): Layout {
  return createLayoutSnapshot(stdout.columns, stdout.rows, fallback);
}

export function createTerminalViewport(
  cols: number | undefined,
  rows: number | undefined,
  fallback?: TerminalViewport,
  isResizing = false,
): TerminalViewport {
  const fallbackLayout = fallback
    ? { cols: fallback.cols, rows: fallback.rows, mode: fallback.mode }
    : undefined;
  const unstable = !isRenderableViewport(cols, rows);
  const stableLayout = unstable && fallbackLayout
    ? fallbackLayout
    : createLayoutSnapshot(cols, rows, fallbackLayout);

  const isCramped = isCrampedTerminal(cols, rows);
  const contentWidth = getContentWidth(stableLayout.cols);

  return {
    ...stableLayout,
    rawCols: cols,
    rawRows: rows,
    contentWidth,
    isCramped,
    unstable,
    layoutEpoch: fallback?.layoutEpoch ?? 0,
    isResizing,
  };
}

export function advanceTerminalViewport(
  current: TerminalViewport,
  cols: number | undefined,
  rows: number | undefined,
  isResizing = false,
): TerminalViewport {
  const next = createTerminalViewport(cols, rows, current, isResizing);
  
  if (process.env.UBUME_LAYOUT_DEBUG === "1") {
    renderDebug.traceEvent("layout", "advanceViewport", {
      cols: next.cols,
      rows: next.rows,
      contentWidth: next.contentWidth,
      isCramped: next.isCramped,
      isResizing: next.isResizing,
      mode: next.mode,
    });
  }

  if (!next.unstable && current.unstable) {
    return {
      ...next,
      layoutEpoch: current.layoutEpoch + 1,
    };
  }

  return {
    ...next,
    layoutEpoch: current.layoutEpoch,
  };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/** React hook — returns live layout that ignores transient invalid restore sizes. */
export function useTerminalViewport(): TerminalViewport {
  const { stdout } = useStdout();
  const [viewport, setViewport] = useState<TerminalViewport>(() => createTerminalViewport(stdout.columns, stdout.rows));
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const commit = (isResizing = false) => {
      setViewport((current) => {
        const nextViewport = advanceTerminalViewport(current, stdout.columns, stdout.rows, isResizing);
        if (
          current.cols === nextViewport.cols &&
          current.rows === nextViewport.rows &&
          current.mode === nextViewport.mode &&
          current.unstable === nextViewport.unstable &&
          current.layoutEpoch === nextViewport.layoutEpoch &&
          current.rawCols === nextViewport.rawCols &&
          current.rawRows === nextViewport.rawRows &&
          current.isResizing === nextViewport.isResizing
        ) {
          renderDebug.traceFlickerEvent("measurementUpdate", {
            result: "skipped",
            cols: nextViewport.cols,
            rows: nextViewport.rows,
            mode: nextViewport.mode,
            unstable: nextViewport.unstable,
            isResizing: nextViewport.isResizing,
          });
          return current;
        }

        renderDebug.traceFlickerEvent("measurementUpdate", {
          result: "updated",
          cols: nextViewport.cols,
          rows: nextViewport.rows,
          mode: nextViewport.mode,
          unstable: nextViewport.unstable,
          isResizing: nextViewport.isResizing,
        });
        return nextViewport;
      });
    };

    const onResize = () => {
      renderDebug.traceEvent("terminal", "viewportHookResize", {
        cols: stdout.columns,
        rows: stdout.rows,
        renderable: isRenderableViewport(stdout.columns, stdout.rows),
      });
      renderDebug.traceLayoutValidity("useTerminalViewport", {
        rawCols: stdout.columns,
        rawRows: stdout.rows,
      });

      // Leading edge: immediately enter isResizing state but do NOT commit
      // new dimensions yet. This freezes the layout to prevent tearing while
      // dragging, and signals animations to pause.
      setTerminalResizing(true);
      setViewport((current) => ({ ...current, isResizing: true }));

      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
      }

      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        setTerminalResizing(false);
        // Trailing edge: commit final dimensions and exit isResizing state.
        commit(false);
      }, RESTORE_SETTLE_MS);
    };

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
      }
    };
  }, [stdout]);

  return viewport;
}

/**
 * Calculate available vertical rows for active panels, falling back to a layout-based
 * budget if availableRows is not explicitly provided.
 */
export function getAvailableRowsForPanel(
  layout: Layout,
  passedAvailableRows?: number
): number {
  if (passedAvailableRows !== undefined) {
    return passedAvailableRows;
  }

  return computeAppLayoutBudget({ cols: layout.cols, rows: layout.rows }).panelRows;
}
