import React, { memo, useEffect, useMemo, useRef } from "react";
import { Box, Static, Text } from "ink";
import type { RuntimeSummary } from "../../config/runtimeConfig.js";
import type { CodexAuthState } from "../../core/auth/codexAuth.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { TimelineEvent, UIState } from "../../session/types.js";
import {
  buildActiveRenderItems,
  buildIntroRenderItem,
  buildStaticRenderItems,
  buildTimelineItems,
  TimelineRowView,
} from "./Timeline.js";
import { buildNativeTranscriptParts, type NativeTranscriptRowItem, type TimelineRow } from "./timelineMeasure.js";
import { getShellHeight, getShellWidth, resolveStartupHeaderMode, type TerminalViewport } from "../layout.js";
import { LOGO_COMPACT, LOGO_COMPACT_MIN_COLS, LOGO_LARGE, LOGO_MEDIUM, selectLogoVariant } from "../render/logoVariants.js";
import { useTheme } from "../theme.js";

export interface TranscriptShellProps {
  layout: TerminalViewport;
  authState: CodexAuthState;
  workspaceLabel: string;
  workspaceRoot?: string | null;
  runtimeSummary?: RuntimeSummary | null;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
  composer: React.ReactNode;
  composerRows?: number;
  notice?: string | null;
  verboseMode?: boolean;
  clearCount?: number;
  visible?: boolean;
}

function isTranscriptEvent(event: TimelineEvent): boolean {
  return event.type === "user" || event.type === "assistant" || event.type === "run" || event.type === "shell";
}

export function isHomeScreenState({
  staticEvents,
  activeEvents,
  uiState,
}: {
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
}): boolean {
  return uiState.kind === "IDLE"
    && !staticEvents.some(isTranscriptEvent)
    && !activeEvents.some(isTranscriptEvent);
}

function getLogoVariantName(rows: readonly string[]): "large" | "medium" | "compact" | "wordmark" | "none" {
  if (rows.length === 0) return process.env["CODEXA_NO_ASCII_LOGO"] === "1" ? "none" : "wordmark";
  if (rows === LOGO_LARGE || rows.join("\n") === LOGO_LARGE.join("\n")) return "large";
  if (rows === LOGO_MEDIUM || rows.join("\n") === LOGO_MEDIUM.join("\n")) return "medium";
  if (rows === LOGO_COMPACT || rows.join("\n") === LOGO_COMPACT.join("\n")) return "compact";
  return "wordmark";
}

function getLogoHiddenReason({
  startupHeaderMode,
  logoVariant,
  width,
}: {
  startupHeaderMode: ReturnType<typeof resolveStartupHeaderMode>;
  logoVariant: ReturnType<typeof getLogoVariantName>;
  width: number;
}): string | null {
  if (startupHeaderMode === "tiny") return "terminal-too-small";
  if (process.env["CODEXA_NO_ASCII_LOGO"] === "1") return "CODEXA_NO_ASCII_LOGO";
  if (logoVariant === "wordmark") return `no-ascii-variant-fits-width-${width}`;
  if (logoVariant === "none") return `no-logo-variant-fits-width-${width}`;
  return null;
}

function TranscriptShellInner({
  layout,
  authState,
  workspaceLabel,
  workspaceRoot = null,
  runtimeSummary = null,
  staticEvents,
  activeEvents,
  uiState,
  composer,
  composerRows,
  notice = null,
  verboseMode = false,
  clearCount = 0,
  visible = true,
}: TranscriptShellProps) {
  const theme = useTheme();
  const startupHeaderMode = useMemo(
    () => resolveStartupHeaderMode({
      cols: layout.cols,
      rows: layout.rows,
      introRows: 8,
      composerRows: composerRows ?? 5,
    }),
    [composerRows, layout.cols, layout.rows],
  );
  const homeScreenActive = visible && isHomeScreenState({ staticEvents, activeEvents, uiState });
  const shellWidth = getShellWidth(layout.cols);
  const introInnerWidth = Math.max(10, shellWidth - 2);
  const selectedLogoRows = startupHeaderMode === "tiny"
    ? []
    : startupHeaderMode === "large"
      ? selectLogoVariant(introInnerWidth)
      : introInnerWidth >= LOGO_COMPACT_MIN_COLS ? LOGO_COMPACT : [];
  const selectedLogoVariant = getLogoVariantName(selectedLogoRows);
  const logoHiddenReason = getLogoHiddenReason({
    startupHeaderMode,
    logoVariant: selectedLogoVariant,
    width: introInnerWidth,
  });
  const startupTraceKeyRef = useRef<string | null>(null);
  const visibleTranscriptRef = useRef({ staticEvents, activeEvents, uiState });
  if (visible) {
    visibleTranscriptRef.current = { staticEvents, activeEvents, uiState };
  }
  const renderedTranscript = visibleTranscriptRef.current;
  const conversationViewportRows = Math.max(
    2,
    getShellHeight(layout.rows) - (composerRows ?? 0) - (notice ? 1 : 0),
  );
  const nativeTranscript = useMemo(() => {
    const staticItems = buildTimelineItems(renderedTranscript.staticEvents);
    const activeItems = buildTimelineItems(renderedTranscript.activeEvents);
    const allTurnIds = [...staticItems, ...activeItems]
      .flatMap((item) => item.type === "turn" ? [item.turnId] : []);
    const activeTurnId = activeItems.find((item) => item.type === "turn")?.turnId ?? null;
    return buildNativeTranscriptParts(
      [
        buildIntroRenderItem({
          authState,
          workspaceLabel,
          layout,
          providerLabel: runtimeSummary?.providerLabel ?? null,
          startupHeaderMode,
        }),
        ...buildStaticRenderItems(staticItems, allTurnIds, activeTurnId, null, null),
        ...buildActiveRenderItems(activeItems, allTurnIds, renderedTranscript.uiState),
      ],
      {
        totalWidth: shellWidth,
        verboseMode,
        debugLabel: "transcript-shell-native",
        workspaceRoot,
      },
    );
  }, [activeEvents, authState, layout, renderedTranscript, runtimeSummary?.providerLabel, shellWidth, startupHeaderMode, staticEvents, uiState, verboseMode, visible, workspaceLabel, workspaceRoot]);
  const committedRows = useMemo(
    () => nativeTranscript.staticItems.reduce((total, item) => total + item.rows.length, 0),
    [nativeTranscript.staticItems],
  );
  const spacerRows = Math.max(0, conversationViewportRows - committedRows - nativeTranscript.liveRows.length);

  useEffect(() => {
    const nextKey = [
      layout.cols,
      layout.rows,
      layout.mode,
      startupHeaderMode,
      homeScreenActive ? "home" : "transcript",
      staticEvents.length,
      activeEvents.length,
      uiState.kind,
      selectedLogoVariant,
      clearCount,
    ].join("|");
    if (startupTraceKeyRef.current === nextKey) return;
    startupTraceKeyRef.current = nextKey;
    renderDebug.traceEvent("startup", "homeRender", {
      cols: layout.cols,
      rows: layout.rows,
      layoutMode: layout.mode,
      activeRoot: "TranscriptShell",
      messageCount: [...staticEvents, ...activeEvents].filter(isTranscriptEvent).length,
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      uiStateKind: uiState.kind,
      selectedLayoutMode: startupHeaderMode,
      selectedLogoVariant,
      logoBranchSelected: selectedLogoVariant !== "none" && selectedLogoVariant !== "wordmark",
      logoHiddenReason,
      composerCount: visible ? 1 : 0,
      footerCount: visible ? 1 : 0,
      homeScreenRendererUsed: homeScreenActive,
      staticItemCount: staticEvents.length,
      liveRowCount: activeEvents.length,
      clearCount,
    });
  }, [
    activeEvents,
    clearCount,
    homeScreenActive,
    layout.cols,
    layout.mode,
    layout.rows,
    logoHiddenReason,
    selectedLogoVariant,
    startupHeaderMode,
    staticEvents,
    uiState.kind,
    visible,
  ]);

  return (
    <Box flexDirection="column" width="100%" display={visible ? "flex" : "none"}>
      <Static key={`native-static-${clearCount}`} items={nativeTranscript.staticItems}>
        {(item: NativeTranscriptRowItem) => <NativeRowsItem key={item.key} rows={item.rows} />}
      </Static>
      {spacerRows > 0 && <Box height={spacerRows} />}
      <NativeRowsItem rows={nativeTranscript.liveRows} />

      {visible && notice && (
        <Box width="100%" paddingX={1}>
          <Text color={theme.success} wrap="truncate">{notice}</Text>
        </Box>
      )}
      {visible && composer}
    </Box>
  );
}

export const TranscriptShell = memo(function TranscriptShell(props: TranscriptShellProps) {
  return (
    <TranscriptShellInner
      key={`clear-${props.clearCount ?? 0}`}
      {...props}
    />
  );
});

function NativeRowsItem({ rows }: { rows: TimelineRow[] }) {
  return (
    <Box flexDirection="column">
      {rows.map((row) => <TimelineRowView key={row.key} row={row} />)}
    </Box>
  );
}
