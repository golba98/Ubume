import React, { memo, useEffect, useMemo, useRef } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme.js";
import type { RuntimeSummary } from "../../config/runtimeConfig.js";
import type { CodexAuthState } from "../../core/auth/codexAuth.js";
import { HEADER_CONFIG_DEFAULTS, type HeaderConfig } from "../../config/settings.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { Screen, TimelineEvent, UIState } from "../../session/types.js";
import {
  ActivePanelLayoutContext,
  type ActivePanelLayout,
  AppLayoutBudgetContext,
  computeAppLayoutBudget,
  getContentWidth,
  getShellHeight,
  getShellWidth,
  isCrampedTerminal,
  PanelAvailableRowsContext,
  type Layout,
  type LayoutMode,
  type PanelLayout,
  PanelLayoutContext,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  type TerminalViewport,
} from "../layout.js";
import { Timeline } from "../timeline/Timeline.js";
import { MemoizedTopHeader, measureTopHeaderRows, type UpdateAvailableInfo } from "./TopHeader.js";

const COMPACT_HEADER_TO_COMPOSER_GAP_ROWS = 1;
const MEDIUM_HEADER_TO_COMPOSER_GAP_ROWS = 1;
const TALL_HEADER_TO_COMPOSER_GAP_ROWS = 1;

// ─── Types & constants ────────────────────────────────────────────────────────

type AppShellLayout = TerminalViewport;
export interface AppShellProps {
  layout: AppShellLayout;
  screen: Screen;
  authState: CodexAuthState;
  workspaceLabel: string;
  workspaceRoot?: string | null;
  runtimeSummary?: RuntimeSummary | null;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
  panel: React.ReactNode;
  mainPanel?: React.ReactNode;
  mainPanelMode?: "viewport" | "full-output";
  composer: React.ReactNode;
  composerRows: number;
  panelHint?: React.ReactNode;
  verboseMode?: boolean;
  clearCount?: number;
  headerConfig?: HeaderConfig;
  updateAvailable?: UpdateAvailableInfo | null;
}

// ─── Helpers & subcomponents ─────────────────────────────────────────────────

export function isCrampedViewport(rows: number | undefined): boolean {
  return (rows ?? 24) <= 24;
}

export function calculateNativeSpacerRows({
  shellRows,
  introRows,
  composerRows,
  staticRows,
  liveRows,
}: {
  shellRows: number;
  introRows: number;
  composerRows: number;
  staticRows: number;
  liveRows: number;
}): number {
  const availableBodyRows = Math.max(0, shellRows - introRows - composerRows);
  const visibleBodyContentRows = Math.max(0, staticRows) + Math.max(0, liveRows);
  return Math.max(0, availableBodyRows - visibleBodyContentRows);
}

export function calculateColdStartSpacerRows({
  shellRows,
  headerRows,
  composerRows,
  layoutMode,
  availableRows,
}: {
  shellRows: number;
  headerRows: number;
  composerRows: number;
  layoutMode: LayoutMode;
  availableRows: number;
}): number {
  if (availableRows <= 0) return 0;

  const rowsAfterHeaderAndComposer = Math.max(0, shellRows - headerRows - composerRows);
  const preferredRows = layoutMode === "compact" || shellRows <= 18
    ? 1
    : shellRows >= 36
      ? TALL_HEADER_TO_COMPOSER_GAP_ROWS
      : shellRows >= 28
        ? MEDIUM_HEADER_TO_COMPOSER_GAP_ROWS
        : COMPACT_HEADER_TO_COMPOSER_GAP_ROWS;

  return Math.max(0, Math.min(availableRows, rowsAfterHeaderAndComposer, preferredRows));
}

export function calculateHeaderToContentGapRows(layout: Layout): number {
  if (layout.mode === "compact" || layout.rows <= 18) return 0;
  return 1;
}

function CrampedView({ layout }: { layout: Layout }) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      width="100%"
      height={getShellHeight(layout.rows)}
      alignItems="center"
      justifyContent="center"
    >
      <Box borderStyle="round" borderColor={theme.error} paddingX={2} paddingY={1}>
        <Text color={theme.error} bold>
          Terminal too small — resize to at least {MIN_TERMINAL_COLS} x {MIN_TERMINAL_ROWS}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Current: {layout.cols} x {layout.rows}
        </Text>
      </Box>
    </Box>
  );
}

function injectPanelLayout(
  element: React.ReactNode,
  availableRows: number,
  activePanelLayout: ActivePanelLayout,
  panelLayout: PanelLayout
): React.ReactNode {
  if (!React.isValidElement(element)) {
    return element;
  }
  if (element.type === React.Fragment) {
    const fragment = element as React.ReactElement<{ children?: React.ReactNode }>;
    return React.cloneElement(
      fragment,
      fragment.props,
      React.Children.map(fragment.props.children, (child) =>
        injectPanelLayout(child, availableRows, activePanelLayout, panelLayout)
      )
    );
  }
  return React.cloneElement(
    element as React.ReactElement<{
      availableRows?: number;
      activePanelLayout?: ActivePanelLayout;
      panelLayout?: PanelLayout;
    }>,
    { availableRows, activePanelLayout, panelLayout }
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

function AppShellInner({
  layout,
  screen,
  authState,
  workspaceLabel,
  workspaceRoot = null,
  runtimeSummary = null,
  staticEvents,
  activeEvents,
  uiState,
  panel,
  mainPanel,
  mainPanelMode = "viewport",
  composer,
  composerRows,
  panelHint,
  verboseMode = false,
  clearCount = 0,
  headerConfig = HEADER_CONFIG_DEFAULTS,
  updateAvailable = null,
}: AppShellProps) {
  const theme = useTheme();
  renderDebug.useRenderDebug("AppShell", {
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
    layoutEpoch: layout.layoutEpoch,
    screen,
    authState,
    workspaceLabel,
    workspaceRoot,
    runtimeSummary,
    staticEvents,
    activeEvents,
    uiState,
    composer,
    composerRows,
    verboseMode,
  });
  renderDebug.useLifecycleDebug("AppShell", {
    screen,
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
  });

  if (layout.isCramped) {
    return <CrampedView layout={layout} />;
  }

  const shellWidth = getShellWidth(layout.cols);
  const shellHeight = getShellHeight(layout.rows);

  const showComposer = true;
  const showMainPanel = screen === "main" && mainPanel !== undefined && mainPanel !== null;
  const showMainPanelFullOutput = showMainPanel && mainPanelMode === "full-output";
  const showTimeline = screen === "main" && !showMainPanel;
  const showPanelStage = screen !== "main";
  const headerLayout = showPanelStage && layout.rows <= 24
    ? { ...layout, cols: Math.min(layout.cols, 71), mode: "compact" as const }
    : layout;
  const headerRows = measureTopHeaderRows(headerLayout, headerConfig, !!updateAvailable);
  const previousMeasurements = useRef<{
    timelineRows: number;
    composerRows: number;
    shellHeight: number;
    shellWidth: number;
  } | null>(null);

  const effectiveShowComposer = showComposer;
  const panelHintRows = showPanelStage && panelHint ? 2 : 0;

  // ─── App Layout Budget ────────────────────────────────────────────────────

  const appLayoutBudget = computeAppLayoutBudget({
    cols: layout.cols,
    rows: layout.rows,
    composerRows,
    panelHintRows,
    headerRows,
  });

  const headerToContentGapRows = appLayoutBudget.headerGapRows;
  const effectiveComposerRows = appLayoutBudget.composerRows;
  const bottomChromeRows = appLayoutBudget.bottomChromeBudget.totalRows;

  const finalTimelineRows = appLayoutBudget.transcriptRows;
  const finalShellHeight = shellHeight;
  const finalShellWidth = shellWidth;

  const { finalTimelineRows: resolvedTimelineRows } = useMemo(() => {
    const prev = previousMeasurements.current;
    const isValid = shellHeight > 0
      && shellWidth > 0
      && Number.isFinite(shellHeight)
      && Number.isFinite(shellWidth)
      && Number.isFinite(finalTimelineRows)
      && finalTimelineRows >= 2;

    if (!isValid && prev) {
      return {
        finalTimelineRows: prev.timelineRows,
      };
    }

    return {
      finalTimelineRows: Math.max(2, finalTimelineRows),
    };
  }, [shellHeight, shellWidth, finalTimelineRows]);

  useEffect(() => {
    previousMeasurements.current = {
      timelineRows: resolvedTimelineRows,
      composerRows: bottomChromeRows,
      shellHeight: finalShellHeight,
      shellWidth: finalShellWidth,
    };
  }, [resolvedTimelineRows, bottomChromeRows, finalShellHeight, finalShellWidth]);

  const contentWidth = getContentWidth(layout.cols);
  const panelStagePaddingY = appLayoutBudget.panelStagePaddingY;

  const panelAvailableRows = appLayoutBudget.panelRows;

  const activePanelLayout = useMemo<ActivePanelLayout>(() => {
    const panelBoxHeight = Math.max(3, resolvedTimelineRows - 2 * panelStagePaddingY);
    const showBorder = panelBoxHeight >= 7;
    const borderRows = showBorder ? 2 : 0;
    const borderCols = showBorder ? 4 : 0;
    const panelTitleRows = showBorder ? 1 : 0;
    const panelHeaderRows = panelBoxHeight >= 9 ? 1 : 0;
    const panelChromeRows = borderRows + panelTitleRows + panelHeaderRows;

    const availableRows = Math.max(1, panelBoxHeight - panelChromeRows);
    const availableCols = Math.max(20, contentWidth - borderCols);

    return {
      width: contentWidth,
      height: panelBoxHeight,
      availableRows,
      availableCols,
    };
  }, [resolvedTimelineRows, panelStagePaddingY, contentWidth]);

  const panelLayout = useMemo<PanelLayout>(() => {
    return {
      mode: appLayoutBudget.mode,
      availableRows: appLayoutBudget.activePanelRows,
      availableCols: appLayoutBudget.activePanelCols,
    };
  }, [appLayoutBudget.mode, appLayoutBudget.activePanelRows, appLayoutBudget.activePanelCols]);

  const mainContent = (
    <AppLayoutBudgetContext.Provider value={appLayoutBudget}>
    <Box flexDirection="column" width={contentWidth} height="100%">
      <MemoizedTopHeader
        authState={authState}
        workspaceLabel={workspaceLabel}
        layout={headerLayout}
        runtimeSummary={runtimeSummary}
        headerConfig={headerConfig}
        updateAvailable={updateAvailable}
      />

      {headerToContentGapRows > 0 && (
        <Box height={headerToContentGapRows} />
      )}

      <Box
        flexDirection="column"
        height={resolvedTimelineRows}
        overflow="hidden"
        display={showTimeline ? "flex" : "none"}
      >
        <Timeline
          key={`timeline-${clearCount}`}
          staticEvents={staticEvents}
          activeEvents={activeEvents}
          layout={layout}
          uiState={uiState}
          viewportRows={resolvedTimelineRows}
          verboseMode={verboseMode}
          authState={authState}
          workspaceLabel={workspaceLabel}
          workspaceRoot={workspaceRoot}
          contentSized
          showIntro={false}
        />
      </Box>

      {showMainPanel && (
        <Box flexDirection="column" height={resolvedTimelineRows} overflow="hidden" justifyContent="center">
          {mainPanel}
        </Box>
      )}

      {showPanelStage && (
        <Box flexDirection="column" height={resolvedTimelineRows} overflow="hidden" paddingY={panelStagePaddingY}>
          <PanelAvailableRowsContext.Provider value={panelAvailableRows}>
            <ActivePanelLayoutContext.Provider value={activePanelLayout}>
              <PanelLayoutContext.Provider value={panelLayout}>
                {process.env.CODEXA_DEBUG_LAYOUT === "1" && (
                  <Box>
                    <Text color="red">
                      DEBUG layout: rows={layout.rows} cols={layout.cols} mode={layout.mode} headerRows={headerRows} panelRows={panelAvailableRows} bottomChromeRows={appLayoutBudget.bottomChromeBudget.totalRows}
                    </Text>
                  </Box>
                )}
                {injectPanelLayout(panel, panelAvailableRows, activePanelLayout, panelLayout)}
              </PanelLayoutContext.Provider>
            </ActivePanelLayoutContext.Provider>
          </PanelAvailableRowsContext.Provider>
        </Box>
      )}

      {showPanelStage && panelHint}

      {effectiveShowComposer && (
        <Box flexDirection="column" flexShrink={0}>
          {composer}
        </Box>
      )}
    </Box>
    </AppLayoutBudgetContext.Provider>
  );

  if (showMainPanelFullOutput) {
    const fullOutputContent = (
      <Box flexDirection="column" width={contentWidth}>
        <MemoizedTopHeader
          authState={authState}
          workspaceLabel={workspaceLabel}
          layout={layout}
          runtimeSummary={runtimeSummary}
          headerConfig={headerConfig}
          updateAvailable={updateAvailable}
        />

        {headerToContentGapRows > 0 && (
          <Box height={headerToContentGapRows} />
        )}

        {mainPanel}

        {showComposer && (
          <Box flexDirection="column" flexShrink={0}>
            {composer}
          </Box>
        )}
      </Box>
    );

    if (shellWidth > contentWidth) {
      return (
        <Box flexDirection="column" width="100%" alignItems="center">
          {fullOutputContent}
        </Box>
      );
    }
    return fullOutputContent;
  }

  if (shellWidth > contentWidth) {
    return (
      <Box flexDirection="column" width="100%" height={finalShellHeight} alignItems="center">
        {mainContent}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" height={finalShellHeight}>
      {mainContent}
    </Box>
  );
}

export const AppShell = memo(AppShellInner, (prev, next) => {
  const panelPropsEqual = next.screen === "main"
    ? prev.mainPanel === next.mainPanel
    : (prev.panel === next.panel && prev.panelHint === next.panelHint);

  return (
    prev.layout.cols     === next.layout.cols     &&
    prev.layout.rows     === next.layout.rows     &&
    prev.layout.mode     === next.layout.mode     &&
    prev.layout.layoutEpoch === next.layout.layoutEpoch &&
    prev.screen          === next.screen          &&
    prev.authState       === next.authState       &&
    prev.workspaceLabel  === next.workspaceLabel  &&
    prev.workspaceRoot   === next.workspaceRoot   &&
    prev.runtimeSummary  === next.runtimeSummary  &&
    prev.staticEvents    === next.staticEvents    &&
    prev.activeEvents    === next.activeEvents    &&
    prev.uiState         === next.uiState         &&
    prev.composerRows    === next.composerRows    &&
    prev.composer        === next.composer        &&
    prev.mainPanel       === next.mainPanel       &&
    prev.mainPanelMode   === next.mainPanelMode   &&
    prev.verboseMode     === next.verboseMode     &&
    prev.clearCount      === next.clearCount      &&
    prev.updateAvailable === next.updateAvailable &&
    panelPropsEqual
  );
});
