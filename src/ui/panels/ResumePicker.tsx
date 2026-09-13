import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import type { ConversationListEntry } from "../../core/workspace/conversationStore.js";
import { clampVisualText, usePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";
import { calculateResponsivePickerViewport } from "./responsivePickerViewport.js";

interface ResumePickerProps {
  conversations: readonly ConversationListEntry[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}

function activityLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function providerLabel(providerId: string | null): string {
  switch (providerId) {
    case "local": return "Local";
    case "anthropic": return "Anthropic";
    case "google": return "Google";
    case "mistral": return "Mistral";
    case "codexa-native": return "ubume-PyTorch";
    case "codexa-cupy": return "CuPy";
    case "antigravity": return "Antigravity";
    case "openai": return "OpenAI";
    default: return "Unavailable";
  }
}

export function ResumePicker({ conversations, onSelect, onCancel }: ResumePickerProps) {
  const theme = useTheme();
  const panelLayout = usePanelLayout();
  const { isFocused } = useFocus({ id: "resume-picker", autoFocus: true });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const availableRows = Math.max(1, panelLayout?.availableRows ?? 12);
  const width = Math.max(1, (panelLayout?.availableCols ?? 80) - 2);
  const viewport = useMemo(() => calculateResponsivePickerViewport({
    itemCount: conversations.length,
    selectedIndex,
    availableRows,
    chromeRows: availableRows >= 3 ? 2 : 0,
    scrollOffset,
  }), [availableRows, conversations.length, scrollOffset, selectedIndex]);

  useEffect(() => setSelectedIndex((index) => Math.max(0, Math.min(index, conversations.length - 1))), [conversations.length]);
  useEffect(() => setScrollOffset(viewport.start), [viewport.start]);

  const move = (index: number) => setSelectedIndex(Math.max(0, Math.min(index, conversations.length - 1)));
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      const selected = conversations[selectedIndex];
      if (selected) onSelect(selected.id);
      return;
    }
    if (key.upArrow || input === "k") return move(selectedIndex - 1);
    if (key.downArrow || input === "j") return move(selectedIndex + 1);
    if (key.home) return move(0);
    if (key.end) return move(conversations.length - 1);
    if (key.pageUp) return move(selectedIndex - Math.max(1, viewport.capacity));
    if (key.pageDown) return move(selectedIndex + Math.max(1, viewport.capacity));
  }, { isActive: isFocused });

  return (
    <Box borderStyle={availableRows >= 3 ? "round" : undefined} borderColor={theme.borderFocused} paddingX={availableRows >= 3 ? 1 : 0} width="100%" flexDirection="column" overflow="hidden">
      {availableRows >= 3 && <Text color={theme.accent} bold>Resume Conversation{conversations.length > 0 ? ` · ${selectedIndex + 1}/${conversations.length}` : ""}</Text>}
      {conversations.length === 0 && <Text color={theme.textMuted}>No previous conversations found.</Text>}
      {conversations.slice(viewport.start, viewport.end).map((conversation, offset) => {
        const index = viewport.start + offset;
        const selected = index === selectedIndex;
        const metadata = `${activityLabel(conversation.updatedAt)} · ${conversation.modelId} · ${providerLabel(conversation.providerId)} · ${conversation.messageCount} messages`;
        return <Text key={conversation.id} color={selected ? theme.accent : theme.textMuted} bold={selected} wrap="truncate">
          {selected ? "> " : "  "}{clampVisualText(`${conversation.title} — ${metadata}`, Math.max(1, width - 2))}
        </Text>;
      })}
      {availableRows >= 3 && <Text color={theme.textDim}>↑↓ navigate · Enter resume · Esc cancel</Text>}
    </Box>
  );
}
