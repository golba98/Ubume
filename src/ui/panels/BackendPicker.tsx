import React from "react";
import { AVAILABLE_BACKENDS } from "../../config/settings.js";
import { FOCUS_IDS } from "../input/focus.js";
import { SelectionPanel } from "./SelectionPanel.js";

interface BackendPickerProps {
  currentBackend: string;
  onSelect: (backend: string) => void;
  onCancel: () => void;
}

export function BackendPicker({ currentBackend, onSelect, onCancel }: BackendPickerProps) {
  const items = AVAILABLE_BACKENDS.map((backend) => ({
    label: backend.id === currentBackend ? `${backend.label}  ✓` : `${backend.label}  ${backend.id}`,
    value: backend.id,
  }));

  return (
    <SelectionPanel
      focusId={FOCUS_IDS.backendPicker}
      title="Select backend"
      subtitle="Ubume is connected and ready. Native OpenAI is reserved for a later implementation pass."
      items={items}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}
