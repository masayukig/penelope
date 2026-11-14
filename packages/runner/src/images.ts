// The images that go into a turn as images: only those attached to an inline
// event (the owner's message), at most four in one input, none over the size
// limit. Every other attachment stays a path, which she can open with `read`.

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { DeliveredEvent } from "@penelope/contract";

export const IMAGES_PER_INPUT = 4;

/** The types Pi takes as an image, by the file's extension. */
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function inlineImages(events: DeliveredEvent[], maxBytes: number): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const event of events) {
    if (!event.inline) continue;
    for (const path of event.attachments ?? []) {
      if (images.length >= IMAGES_PER_INPUT) return images;
      const mimeType = TYPES[extname(path).toLowerCase()];
      if (!mimeType) continue;
      try {
        if ((await stat(path)).size > maxBytes) continue;
        images.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType });
      } catch {
        // Not readable: it stays a path in the text.
      }
    }
  }
  return images;
}
