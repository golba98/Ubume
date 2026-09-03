import type { ProviderImageAttachment } from "../../core/providerRuntime/types.js";
import { createAtomicContentToken, IMAGE_ATTACHMENT_PATTERN } from "./pastedContent.js";

export type ImageAttachmentRegistry = Map<string, ProviderImageAttachment>;

export function createImageAttachmentToken(attachment: ProviderImageAttachment): string {
  return createAtomicContentToken(`[Image: ${attachment.name}]`);
}

export function selectImageAttachments(value: string, registry: ImageAttachmentRegistry): ProviderImageAttachment[] {
  IMAGE_ATTACHMENT_PATTERN.lastIndex = 0;
  const attachments: ProviderImageAttachment[] = [];
  for (const match of value.matchAll(IMAGE_ATTACHMENT_PATTERN)) {
    const attachment = registry.get(match[0]);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}
