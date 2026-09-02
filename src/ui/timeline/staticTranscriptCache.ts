import type { AssistantEvent, ErrorEvent, RunEvent, ShellEvent, SystemEvent, UserPromptEvent } from "../../session/types.js";
import type { RenderTimelineItem } from "./Timeline.js";
import type { TurnOpacity } from "./TurnGroup.js";
import { buildNativeTranscriptParts, type NativeTranscriptRowItem, type TimelineRow } from "./timelineMeasure.js";

/**
 * Incremental row builder for the finalized (static) half of the transcript.
 *
 * Ink's <Static> prints each item once and never re-renders it, and finalized
 * timeline events are immutable, so rebuilding every past turn's rows on each
 * React commit (every keystroke, every streaming flush) is pure waste that
 * grows with session length. This cache keys rows by the render item's key
 * and revalidates by event identity plus the derived opacity, so a commit
 * that changes nothing in the static half costs one Map lookup per item.
 *
 * Retention: only the newest MAX_RETAINED_STATIC_TURNS turns keep row objects.
 * Older turns still emit placeholder items (with no rows) so the <Static> item
 * count stays monotonic — Ink advances its printed index by items.length, so a
 * shrinking list would swallow the next newly finalized turn. A turn that
 * leaves the window keeps exactly the item keys it had while retained; those
 * keys survive generation changes so the count never drops. Their rows are
 * already in the terminal's scrollback; the only visible effect is that a
 * width resize (which re-flushes <Static> from these items) redraws just the
 * retained window.
 */
export const MAX_RETAINED_STATIC_TURNS = 200;

const EMPTY_ROWS: TimelineRow[] = Object.freeze([]) as unknown as TimelineRow[];

interface CachedTurnEntry {
  kind: "turn";
  user: UserPromptEvent | null;
  run: RunEvent | null;
  assistant: AssistantEvent | null;
  opacity: TurnOpacity;
  items: NativeTranscriptRowItem[];
}

interface CachedEventEntry {
  kind: "event";
  event: SystemEvent | ErrorEvent | ShellEvent;
  items: NativeTranscriptRowItem[];
}

type CachedEntry = CachedTurnEntry | CachedEventEntry;

export interface StaticTranscriptBuildOptions {
  totalWidth: number;
  verboseMode: boolean;
  workspaceRoot: string | null;
}

export interface StaticTranscriptCache {
  generation: string;
  entries: Map<string, CachedEntry>;
  /** Item keys of turns outside the retention window; kept across generations. */
  placeholders: Map<string, string[]>;
}

export function createStaticTranscriptCache(): StaticTranscriptCache {
  return { generation: "", entries: new Map(), placeholders: new Map() };
}

export function staticTranscriptGeneration(options: StaticTranscriptBuildOptions): string {
  return `${options.totalWidth}|${options.verboseMode ? 1 : 0}|${options.workspaceRoot ?? ""}`;
}

function isCacheHit(cached: CachedEntry, item: RenderTimelineItem): boolean {
  if (item.type === "event") return cached.kind === "event" && cached.event === item.event;
  if (item.type !== "turn" || cached.kind !== "turn") return false;
  return cached.user === item.item.user
    && cached.run === item.item.run
    && cached.assistant === item.item.assistant
    && cached.opacity === item.renderState.opacity;
}

function isCacheable(item: RenderTimelineItem, liveRowCount: number): boolean {
  if (item.type === "event") return true;
  if (item.type !== "turn") return false;
  return item.item.run?.status !== "running" && item.renderState.question === null && liveRowCount === 0;
}

/**
 * Build native row items for the given render items, reusing cached rows for
 * every item whose inputs are unchanged. Output is identical to a single
 * batched buildNativeTranscriptParts call over the same items, except that
 * turns outside the retention window carry empty rows.
 */
export function buildStaticTranscript(
  cache: StaticTranscriptCache,
  renderItems: RenderTimelineItem[],
  options: StaticTranscriptBuildOptions,
): { staticItems: NativeTranscriptRowItem[]; liveRows: TimelineRow[] } {
  const generation = staticTranscriptGeneration(options);
  if (cache.generation !== generation) {
    cache.generation = generation;
    cache.entries.clear();
  }

  const buildOptions = {
    totalWidth: options.totalWidth,
    verboseMode: options.verboseMode,
    workspaceRoot: options.workspaceRoot,
    debugLabel: "transcript-shell-static",
  };
  const staticItems: NativeTranscriptRowItem[] = [];
  const liveRows: TimelineRow[] = [];
  const seen = new Set<string>();

  let turnCount = 0;
  for (const item of renderItems) if (item.type === "turn") turnCount += 1;
  const firstRetainedTurnOrdinal = Math.max(0, turnCount - MAX_RETAINED_STATIC_TURNS);
  let turnOrdinal = 0;

  for (const item of renderItems) {
    if (item.type === "intro") {
      staticItems.push(...buildNativeTranscriptParts([item], buildOptions).staticItems);
      continue;
    }

    if (item.type === "turn") {
      const ordinal = turnOrdinal;
      turnOrdinal += 1;
      if (ordinal < firstRetainedTurnOrdinal) {
        let keys = cache.placeholders.get(item.key);
        if (!keys) {
          // Leaving the window: keep this turn's item keys so the count stays
          // exactly what Ink already printed. A turn first seen outside the
          // window was never printed by this <Static>, so one item suffices.
          keys = cache.entries.get(item.key)?.items.map((entry) => entry.key) ?? [item.key];
          cache.placeholders.set(item.key, keys);
          cache.entries.delete(item.key);
        }
        for (const key of keys) staticItems.push({ key, rows: EMPTY_ROWS });
        continue;
      }
    }

    const cached = cache.entries.get(item.key);
    if (cached && isCacheHit(cached, item)) {
      staticItems.push(...cached.items);
      seen.add(item.key);
      continue;
    }

    const parts = buildNativeTranscriptParts([item], buildOptions);
    staticItems.push(...parts.staticItems);
    liveRows.push(...parts.liveRows);
    if (!isCacheable(item, parts.liveRows.length)) continue;

    cache.entries.set(
      item.key,
      item.type === "event"
        ? { kind: "event", event: item.event, items: parts.staticItems }
        : {
          kind: "turn",
          user: item.item.user,
          run: item.item.run,
          assistant: item.item.assistant,
          opacity: item.renderState.opacity,
          items: parts.staticItems,
        },
    );
    seen.add(item.key);
  }

  if (cache.entries.size > seen.size) {
    for (const key of cache.entries.keys()) {
      if (!seen.has(key)) cache.entries.delete(key);
    }
  }

  return { staticItems, liveRows };
}
