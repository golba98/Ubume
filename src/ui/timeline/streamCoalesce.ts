import type { RunProgressBlock } from "../../session/types.js";

interface ThinkingLikeEvent {
  kind: string;
  streamSeq: number;
  block: RunProgressBlock;
}

/**
 * Merge each run of consecutive `kind === "thinking"` events into a single
 * event so contiguous chain-of-thought renders under one header. Local models
 * emit every reasoning paragraph as its own progress item, which otherwise
 * stacks one labeled block per sentence. Thoughts separated by a tool call or
 * response segment stay separate — only uninterrupted runs merge.
 */
export function coalesceConsecutiveThinking<T extends { kind: string; streamSeq: number }>(events: T[]): T[] {
  const result: T[] = [];
  let index = 0;
  while (index < events.length) {
    const event = events[index]!;
    if (event.kind !== "thinking") {
      result.push(event);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < events.length && events[end]!.kind === "thinking") {
      end += 1;
    }
    if (end - index === 1) {
      result.push(event);
      index = end;
      continue;
    }

    const members = events.slice(index, end) as unknown as ThinkingLikeEvent[];
    const first = members[0]!;
    const last = members[members.length - 1]!;
    const mergedBlock: RunProgressBlock = {
      ...first.block,
      text: members
        .map((member) => member.block.text)
        .filter((text) => text.trim().length > 0)
        .join("\n\n"),
      updatedAt: Math.max(...members.map((member) => member.block.updatedAt)),
      status: last.block.status,
    };
    result.push({ ...event, block: mergedBlock });
    index = end;
  }
  return result;
}
