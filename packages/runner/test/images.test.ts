import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DeliveredAttachment, DeliveredEvent } from "@penelope/contract";

import { IMAGES_PER_INPUT, inlineImages } from "../src/images.ts";

function event(seq: number, attachments: DeliveredAttachment[], inline = true): DeliveredEvent {
  const base = {
    seq,
    source: "ui",
    id: `m-${seq}`,
    occurred_at: "2026-11-14T09:00:00Z",
    received_at: "2026-11-14T09:00:00Z",
    summary: "s",
    delivery: "now" as const,
    appended: { path: "/sources/ui/2026-11-14.jsonl", lines: [1, 1] as [number, number] },
    attachments,
  };
  return inline ? { ...base, inline: true, payload: { text: "t" } } : { ...base, inline: false };
}

/** Files of `size` bytes in a new directory; the attachment says what the backend said. */
async function dir(): Promise<(name: string, mime_type: string, size: number) => Promise<DeliveredAttachment>> {
  const root = await mkdtemp(join(tmpdir(), "images-"));
  return async (name, mime_type, size) => {
    const path = join(root, name);
    await writeFile(path, Buffer.alloc(size, 1));
    return { path, mime_type, size };
  };
}

test("an inline event's images are read, by the type the backend gives", async () => {
  const file = await dir();
  const attachments = [
    await file("1-a.bin", "image/png", 10),
    await file("1-b.jpg", "image/jpeg", 10),
    await file("1-c.pdf", "application/pdf", 10),
  ];
  const images = await inlineImages([event(1, attachments)], 1000);
  assert.deepEqual(
    images.map((image) => image.mimeType),
    ["image/png", "image/jpeg"],
  );
  assert.equal(images[0]!.type, "image");
  assert.equal(Buffer.from(images[0]!.data, "base64").length, 10);
});

test("a file named like an image whose type is not one is not read", async () => {
  const file = await dir();
  const images = await inlineImages([event(1, [await file("1-x.png", "application/octet-stream", 10)])], 1000);
  assert.deepEqual(images, []);
});

test("no more than four images go into one input", async () => {
  const file = await dir();
  const attachments = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => file(`${n}.webp`, "image/webp", 5)));
  const images = await inlineImages([event(1, attachments)], 1000);
  assert.equal(images.length, IMAGES_PER_INPUT);
  assert.equal(IMAGES_PER_INPUT, 4);
});

test("an image over the limit by its size, one that cannot be read, and those of other events stay paths", async () => {
  const file = await dir();
  const small = await file("small.gif", "image/gif", 10);
  const images = await inlineImages(
    [
      event(1, [
        { ...small, size: 2000 },
        { path: join(tmpdir(), "missing-image.png"), mime_type: "image/png", size: 10 },
      ]),
      event(2, [small], false),
    ],
    1000,
  );
  assert.deepEqual(images, []);
});
