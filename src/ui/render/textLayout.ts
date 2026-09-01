import stringWidth from "string-width";

interface WindowSlice {
  text: string;
  cursorColumn: number;
}

export interface TextUnit {
  text: string;
  start: number;
  end: number;
  width: number;
}

export interface WrappedTextRow {
  text: string;
  start: number;
  end: number;
  breakType: "soft" | "hard" | "end";
}

// ─── Character measurement ───────────────────────────────────────────────────

export function getCharWidth(char: string): number {
  return Math.max(1, stringWidth(char));
}

export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function getTextUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  let offset = 0;

  for (const char of text) {
    const length = char.length;
    units.push({
      text: char,
      start: offset,
      end: offset + length,
      width: getCharWidth(char),
    });
    offset += length;
  }

  return units;
}

export function getTextWidth(text: string): number {
  return stringWidth(text);
}

function trimToWidthFromEnd(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let width = 0;
  const kept: TextUnit[] = [];
  const units = getTextUnits(text);

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    if (width + unit.width > maxWidth) break;
    kept.unshift(unit);
    width += unit.width;
  }

  return kept.map((unit) => unit.text).join("");
}

function trimToWidthFromStart(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let width = 0;
  let output = "";

  for (const unit of getTextUnits(text)) {
    if (width + unit.width > maxWidth) break;
    output += unit.text;
    width += unit.width;
  }

  return output;
}

// ─── Input window ────────────────────────────────────────────────────────────

export function flattenInputForDisplay(text: string, cursor: number): { text: string; cursor: number } {
  const normalized = normalizeLineBreaks(text);
  const units = getTextUnits(normalized);
  let output = "";
  let mappedCursor = 0;

  for (const unit of units) {
    if (unit.start === cursor) {
      mappedCursor = output.length;
    }

    if (unit.text === "\n") {
      output += " ↩ ";
      continue;
    }
    if (unit.text === "\t") {
      output += "  ";
      continue;
    }
    output += unit.text;
  }

  if (cursor >= normalized.length) {
    mappedCursor = output.length;
  }

  return { text: output, cursor: mappedCursor };
}

export function createInlineInputWindow(text: string, cursor: number, maxWidth: number): WindowSlice {
  const safeWidth = Math.max(1, maxWidth);
  const flattened = flattenInputForDisplay(text, cursor);
  const units = getTextUnits(flattened.text);
  const charStartWidths: number[] = [];
  let totalWidth = 0;

  for (const unit of units) {
    charStartWidths.push(totalWidth);
    totalWidth += unit.width;
  }

  const cursorWidth = getTextWidth(flattened.text.slice(0, flattened.cursor));
  if (totalWidth <= safeWidth) {
    return { text: flattened.text, cursorColumn: cursorWidth };
  }

  const preferredStart = Math.max(0, cursorWidth - Math.floor(safeWidth * 0.65));
  let windowStart = preferredStart;
  if (windowStart + safeWidth > totalWidth) {
    windowStart = Math.max(0, totalWidth - safeWidth);
  }
  const windowEnd = windowStart + safeWidth;

  let startIndex = 0;
  while (startIndex < units.length && charStartWidths[startIndex]! + units[startIndex]!.width <= windowStart) {
    startIndex += 1;
  }

  let endIndex = startIndex;
  while (endIndex < units.length && charStartWidths[endIndex]! < windowEnd) {
    endIndex += 1;
  }

  let visibleText = units.slice(startIndex, endIndex).map((unit) => unit.text).join("");
  let cursorColumn = Math.max(0, cursorWidth - (charStartWidths[startIndex] ?? 0));
  const truncatedLeft = startIndex > 0;
  const truncatedRight = endIndex < units.length;

  if (truncatedLeft) {
    const ellipsis = "…";
    const available = Math.max(1, safeWidth - getCharWidth(ellipsis) - (truncatedRight ? getCharWidth(ellipsis) : 0));
    visibleText = ellipsis + trimToWidthFromEnd(visibleText, available);
    cursorColumn = Math.min(getTextWidth(visibleText), Math.max(getCharWidth(ellipsis), cursorColumn + getCharWidth(ellipsis)));
  }

  if (truncatedRight) {
    const ellipsis = "…";
    const available = Math.max(1, safeWidth - (truncatedLeft ? getCharWidth(ellipsis) : 0) - getCharWidth(ellipsis));
    const baseText = truncatedLeft ? visibleText.slice(1) : visibleText;
    visibleText = `${truncatedLeft ? "…" : ""}${trimToWidthFromStart(baseText, available)}${ellipsis}`;
  }

  return {
    text: visibleText,
    cursorColumn: Math.max(0, Math.min(getTextWidth(visibleText), cursorColumn)),
  };
}

export function splitTextAtColumn(text: string, column: number): { before: string; current: string; after: string } {
  const safeColumn = Math.max(0, column);
  let width = 0;
  const units = getTextUnits(text);

  for (const unit of units) {
    if (width + unit.width > safeColumn) {
      return {
        before: text.slice(0, unit.start),
        current: unit.text,
        after: text.slice(unit.end),
      };
    }

    width += unit.width;
    if (width > safeColumn) break;
  }

  return {
    before: text,
    current: "",
    after: "",
  };
}

// ─── Text wrapping ────────────────────────────────────────────────────────────

export function wrapTextRows(
  text: string,
  maxWidth: number,
  firstLineWidth: number = maxWidth,
): WrappedTextRow[] {
  const normalized = normalizeLineBreaks(text);
  const safeWidth = Math.max(1, maxWidth);
  const safeFirstWidth = Math.max(1, firstLineWidth);
  const rows: WrappedTextRow[] = [];
  let rowUnits: TextUnit[] = [];
  let rowWidth = 0;
  let skippingSoftWhitespace = false;

  const unitsText = (units: TextUnit[]) => units.map((unit) => unit.text).join("");
  const unitsWidth = (units: TextUnit[]) => units.reduce((total, current) => total + current.width, 0);
  const pushRow = (units: TextUnit[], end: number, breakType: WrappedTextRow["breakType"]) => {
    rows.push({
      text: unitsText(units),
      start: units[0]?.start ?? end,
      end,
      breakType,
    });
  };
  const findWordBoundary = (units: TextUnit[]): { breakStart: number; continuationStart: number } | null => {
    for (let index = units.length - 2; index >= 0; index -= 1) {
      if (!/^[ \t]$/.test(units[index]!.text)) continue;

      let breakStart = index;
      while (breakStart > 0 && /^[ \t]$/.test(units[breakStart - 1]!.text)) {
        breakStart -= 1;
      }

      let continuationStart = index + 1;
      while (continuationStart < units.length && /^[ \t]$/.test(units[continuationStart]!.text)) {
        continuationStart += 1;
      }

      if (breakStart > 0 && continuationStart < units.length) {
        return { breakStart, continuationStart };
      }
      index = breakStart;
    }
    return null;
  };

  for (const unit of getTextUnits(normalized)) {
    if (unit.text === "\n") {
      pushRow(rowUnits, unit.start, "hard");
      rowUnits = [];
      rowWidth = 0;
      skippingSoftWhitespace = false;
      continue;
    }

    if (skippingSoftWhitespace && /^[ \t]$/.test(unit.text)) continue;
    skippingSoftWhitespace = false;

    // Only the first emitted row honors firstLineWidth; later rows use maxWidth.
    const limit = rows.length === 0 ? safeFirstWidth : safeWidth;
    if (rowUnits.length > 0 && rowWidth + unit.width > limit) {
      const candidate = [...rowUnits, unit];
      const boundary = findWordBoundary(candidate);
      if (boundary) {
        const before = candidate.slice(0, boundary.breakStart);
        const after = candidate.slice(boundary.continuationStart);
        pushRow(before, candidate[boundary.breakStart]!.start, "soft");
        rowUnits = after;
        rowWidth = unitsWidth(after);
      } else if (/^[ \t]$/.test(unit.text)) {
        pushRow(rowUnits, unit.start, "soft");
        rowUnits = [];
        rowWidth = 0;
        skippingSoftWhitespace = true;
      } else {
        pushRow(rowUnits, unit.start, "soft");
        rowUnits = [unit];
        rowWidth = unit.width;
      }
      continue;
    }

    rowUnits.push(unit);
    rowWidth += unit.width;
  }

  if (rowUnits.length > 0) {
    pushRow(rowUnits, normalized.length, "end");
  } else {
    rows.push({
      text: "",
      start: normalized.length,
      end: normalized.length,
      breakType: "end",
    });
  }

  return rows.length > 0 ? rows : [{
    text: "",
    start: 0,
    end: 0,
    breakType: "end",
  }];
}

export function wrapPlainText(
  text: string,
  maxWidth: number,
  firstLineWidth: number = maxWidth,
): string[] {
  return wrapTextRows(text, maxWidth, firstLineWidth).map((row) => row.text);
}

export function wrapCommandText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 2) return [];
  const normalized = normalizeLineBreaks(text);
  const rows: string[] = [];
  let currentLine = "";
  let currentWidth = 0;
  
  // Split on whitespace, but keep the whitespace tokens
  const tokens = normalized.split(/([ \t]+)/);
  
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    if (!token) continue;
    
    if (token === "\n") {
      rows.push(currentLine);
      currentLine = "  ";
      currentWidth = 2;
      continue;
    }
    
    let tokenWidth = getTextWidth(token);
    
    // Skip leading whitespace on continuation lines
    if (/^[ \t]+$/.test(token) && currentLine === "  ") {
      continue;
    }

    if (currentWidth + tokenWidth > maxWidth) {
      if (/^[ \t]+$/.test(token)) {
        // Space that pushes us over the edge, ignore it and break
        rows.push(currentLine);
        currentLine = "  ";
        currentWidth = 2;
        continue;
      }
      
      if (currentWidth > 2) {
        // We have some content on this line, push it and start a new line
        rows.push(currentLine);
        currentLine = "  ";
        currentWidth = 2;
      }
      
      // Now check if the token alone exceeds the available width (maxWidth - 2)
      while (tokenWidth > maxWidth - currentWidth) {
        const available = maxWidth - currentWidth;
        const split = splitTextAtColumn(token, available);
        
        currentLine += split.before;
        rows.push(currentLine);
        
        token = split.current + split.after;
        tokenWidth = getTextWidth(token);
        currentLine = "  ";
        currentWidth = 2;
      }
      
      currentLine += token;
      currentWidth += tokenWidth;
      
    } else {
      currentLine += token;
      currentWidth += tokenWidth;
    }
  }
  
  if (currentLine.trim().length > 0 || currentLine === "  ") {
    // only push if there is actual content, or if it is an intentionally empty line (rare)
    if (currentLine !== "  ") {
       rows.push(currentLine);
    }
  }
  
  if (rows.length > 0 && rows[0].startsWith("  ") && !text.startsWith("  ")) {
    rows[0] = rows[0].substring(2);
  }
  
  return rows;
}
