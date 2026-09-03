import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme.js";
import { Panel } from "../panels/Panel.js";
import { maybeRenderDiff, type DiffRenderLineType } from "./diffRenderer.js";
import { formatLocalPathForTerminal, formatTerminalAnswerInline } from "./terminalAnswerFormat.js";

// ─── Markdown parser ─────────────────────────────────────────────────────────

type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string };

function parseInline(text: string): InlinePart[] {
  const formattedText = formatTerminalAnswerInline(text);
  const parts: InlinePart[] = [];
  const pat = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pat.exec(formattedText)) !== null) {
    if (match.index > last) parts.push({ kind: "text", text: formattedText.slice(last, match.index) });
    if (match[1] !== undefined) parts.push({ kind: "code", text: formatLocalPathForTerminal(match[1]) });
    if (match[2] !== undefined) parts.push({ kind: "bold", text: match[2] });
    last = pat.lastIndex;
  }

  if (last < formattedText.length) parts.push({ kind: "text", text: formattedText.slice(last) });
  return parts.length > 0 ? parts : [{ kind: "text", text: formattedText }];
}

export type CodeSegment = { type: "code"; lang: string; lines: string[] };
export type HeaderSegment = { type: "header"; level: 1 | 2 | 3; parts: InlinePart[] };
export type ListItem = { num: number; parts: InlinePart[] };
export type ListSegment = { type: "list"; ordered: boolean; items: ListItem[] };
export type ParaSegment = { type: "para"; lines: InlinePart[][] };
export type Segment = CodeSegment | HeaderSegment | ListSegment | ParaSegment;

const SHELL_CODE_LANGUAGES = new Set([
  "bash", "sh", "shell", "zsh", "fish", "powershell", "pwsh", "cmd", "bat", "batch",
]);

export function isShellCodeLanguage(language: string): boolean {
  return SHELL_CODE_LANGUAGES.has(language.trim().toLowerCase());
}

const FENCE_RE = /^```(.*)$/;
const HEADER_RE = /^(#{1,3})\s+(.+)/;
const BULLET_RE = /^\s*[-*]\s+(.+)/;
const ORDERED_RE = /^\s*(\d+)\.\s+(.+)/;

function isBlockStart(line: string): boolean {
  return FENCE_RE.test(line) || HEADER_RE.test(line) || BULLET_RE.test(line) || ORDERED_RE.test(line);
}

export function parseMarkdown(content: string): Segment[] {
  const lines = content.split("\n");
  const out: Segment[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const codeLines: string[] = [];
      const lang = (fenceMatch[1] ?? "").trim();
      index += 1;
      while (index < lines.length && !FENCE_RE.test(lines[index]!)) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      index += 1;
      out.push({ type: "code", lang, lines: codeLines });
      continue;
    }

    const headerMatch = HEADER_RE.exec(line);
    if (headerMatch) {
      out.push({
        type: "header",
        level: Math.min(3, headerMatch[1]!.length) as 1 | 2 | 3,
        parts: parseInline(headerMatch[2]!),
      });
      index += 1;
      continue;
    }

    if (BULLET_RE.test(line)) {
      const items: ListItem[] = [];
      let counter = 1;
      while (index < lines.length) {
        const match = BULLET_RE.exec(lines[index]!);
        if (!match) break;
        items.push({ num: counter, parts: parseInline(match[1]!) });
        counter += 1;
        index += 1;
      }
      out.push({ type: "list", ordered: false, items });
      continue;
    }

    if (ORDERED_RE.test(line)) {
      const items: ListItem[] = [];
      while (index < lines.length) {
        const match = ORDERED_RE.exec(lines[index]!);
        if (!match) break;
        items.push({ num: Number.parseInt(match[1]!, 10), parts: parseInline(match[2]!) });
        index += 1;
      }
      out.push({ type: "list", ordered: true, items });
      continue;
    }

    const paraLines: InlinePart[][] = [];
    while (index < lines.length && !isBlockStart(lines[index]!) && lines[index]!.trim() !== '') {
      paraLines.push(parseInline(lines[index]!));
      index += 1;
    }
    if (paraLines.length > 0) {
      out.push({ type: "para", lines: paraLines });
    }
  }

  return out;
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

function InlineText({ parts, color }: { parts: InlinePart[]; color: string }) {
  const theme = useTheme();

  return (
    <Text color={color} wrap="wrap">
      {parts.map((part, index) => {
        if (part.kind === "code") return <Text key={index} color={theme.info}>{part.text}</Text>;
        if (part.kind === "bold") return <Text key={index} bold>{part.text}</Text>;
        return <Text key={index}>{part.text}</Text>;
      })}
    </Text>
  );
}

function renderTreeLabel(label: string, theme: ReturnType<typeof useTheme>) {
  const trimmed = label.trimEnd();
  const slash = trimmed.endsWith("/") ? "/" : "";
  const base = slash ? trimmed.slice(0, -1) : trimmed;
  const lastDot = base.lastIndexOf(".");
  const isDirectory = slash === "/" || (lastDot <= 0 && base.length > 0);

  if (isDirectory) {
    return (
      <Text color={theme.text} bold>
        {base}
        {slash}
      </Text>
    );
  }

  return (
    <Text color={theme.text}>
      {base.slice(0, lastDot)}
      <Text color={theme.textDim}>{base.slice(lastDot)}</Text>
    </Text>
  );
}

function TreeLine({ line }: { line: string }) {
  const theme = useTheme();
  const match = /^([│├└─\s]*)(.*)$/.exec(line);
  const prefix = match?.[1] ?? "";
  const label = match?.[2] ?? line;

  return (
    <Box width="100%">
      <Text color={theme.textDim}>{prefix}</Text>
      {renderTreeLabel(label, theme)}
    </Box>
  );
}

function isTreeLine(line: string): boolean {
  return /^[│├└─\s]+/.test(line);
}

function getDiffColor(kind: DiffRenderLineType, theme: ReturnType<typeof useTheme>): string {
  switch (kind) {
    case "add":
      return theme.success;
    case "remove":
      return theme.error;
    case "hunk":
      return theme.accent;
    case "file":
    case "meta":
      return theme.info;
    case "context":
    default:
      return theme.textMuted;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RenderMessage({ segments, width, brightHeadings = false }: { segments: Segment[]; width: number; brightHeadings?: boolean }) {
  const theme = useTheme();

  return (
    <Box flexDirection="column" width="100%">
      {segments.map((segment, index) => {
        const marginTop = index > 0 ? 1 : 0;

        if (segment.type === "code") {
          const lang = (segment.lang || "").toLowerCase();
          const looksLikeTree = segment.lines.some((line) => isTreeLine(line));

          let title = segment.lang || "code";
          let codeLines = segment.lines;
          const firstLine = codeLines[0]?.trim() || "";
          if (/^[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+$/.test(firstLine)) {
            title = firstLine;
            codeLines = codeLines.slice(1);
          }

          const panelWidth = Math.max(10, width);
          const diffLines = maybeRenderDiff(codeLines.join("\n"), { force: lang === "diff" });

          if (isShellCodeLanguage(lang)) {
            const marker = lang === "cmd" || lang === "bat" || lang === "batch"
              ? `REM ${lang}`
              : `# ${lang}`;
            return (
              <Box key={index} marginTop={marginTop} flexDirection="column" paddingLeft={2} width="100%">
                <Text color={theme.textDim}>{marker}</Text>
                {codeLines.map((line, lineIndex) => (
                  <Text key={lineIndex} color={theme.textMuted} wrap="wrap">{line || " "}</Text>
                ))}
              </Box>
            );
          }

          return (
            <Box
              key={index}
              marginTop={marginTop}
              flexDirection="column"
              paddingLeft={2}
              width="100%"
            >
              <Panel cols={panelWidth} title={title}>
                {diffLines
                  ? diffLines.map((line, lineIndex) => (
                    <Text key={lineIndex} color={getDiffColor(line.type, theme)} wrap="wrap">
                      {line.text || " "}
                    </Text>
                  ))
                  : codeLines.map((line, lineIndex) => (
                    looksLikeTree ? (
                      <TreeLine key={lineIndex} line={line || " "} />
                    ) : (
                      <Box key={lineIndex}>
                        <Box width={3} flexShrink={0} marginRight={1} justifyContent="flex-end">
                          <Text color={theme.textDim}>{lineIndex + 1}</Text>
                        </Box>
                        <Text color={theme.textMuted} wrap="wrap">{line || " "}</Text>
                      </Box>
                    )
                  ))}
              </Panel>
            </Box>
          );
        }

        if (segment.type === "header") {
          const color = segment.level === 1 ? theme.accent : segment.level === 2 ? theme.text : (brightHeadings ? theme.text : theme.textMuted);
          return (
            <Box key={index} flexDirection="column" marginTop={marginTop}>
              {segment.level <= 2 && <Text color={theme.border}>{"───"}</Text>}
              <Box>
                <Text color={color}>{segment.level <= 2 ? "✧ " : "• "}</Text>
                <InlineText parts={segment.parts} color={color} />
              </Box>
            </Box>
          );
        }

        if (segment.type === "list") {
          return (
            <Box key={index} flexDirection="column" marginTop={marginTop}>
              {segment.items.map((item, itemIndex) => (
                <Box key={itemIndex}>
                  <Text color={theme.accent}>{segment.ordered ? `${item.num}. ` : "• "}</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <InlineText parts={item.parts} color={theme.text} />
                  </Box>
                </Box>
              ))}
            </Box>
          );
        }

        const hasContent = segment.lines.some(
          (parts) => !(parts.length === 1 && parts[0]!.kind === "text" && !parts[0]!.text.trim()),
        );
        if (!hasContent) return null;

        return (
          <Box key={index} flexDirection="column" marginTop={marginTop}>
            {segment.lines.map((parts, lineIndex) => {
              if (parts.length === 1 && parts[0]!.kind === "text" && !parts[0]!.text.trim()) {
                return null;
              }
              return <InlineText key={lineIndex} parts={parts} color={theme.text} />;
            })}
          </Box>
        );
      })}
    </Box>
  );
}

export const MemoizedRenderMessage = React.memo(RenderMessage, (prev, next) => (
  prev.segments === next.segments && prev.width === next.width && prev.brightHeadings === next.brightHeadings
));

