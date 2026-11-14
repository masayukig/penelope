// The images that go into a turn as images: only those attached to an inline
// event (the owner's message), at most four in one input, none over the size
// limit. Every other attachment stays a path, which she can open with `read`.
// The type and the size are the backend's (it reads the type from the file's
// first bytes); the runner only reads the file.

import { readFile } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { DeliveredEvent } from "@penelope/contract";

export const IMAGES_PER_INPUT = 4;

/** The types that go in as images. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function inlineImages(events: DeliveredEvent[], maxBytes: number): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const event of events) {
    if (!event.inline) continue;
    for (const { path, mime_type: mimeType, size } of event.attachments ?? []) {
      if (images.length >= IMAGES_PER_INPUT) return images;
      if (!IMAGE_TYPES.has(mimeType) || size > maxBytes) continue;
      try {
        images.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType });
      } catch {
        // Not readable: it stays a path in the text.
      }
    }
  }
  return images;
}
