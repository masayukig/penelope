import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DeliveredEvent } from "@penelope/contract";

import { IMAGES_PER_INPUT, inlineImages } from "../src/images.ts";

function event(seq: number, attachments: string[], inline = true): DeliveredEvent {
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

async function files(names: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "images-"));
  for (const [name, size] of Object.entries(names)) await writeFile(join(dir, name), Buffer.alloc(size, 1));
  return dir;
}

test("an inline event's images are read, with their type from the name", async () => {
  const dir = await files({ "1-a.png": 10, "1-b.JPG": 10, "1-c.pdf": 10 });
  const images = await inlineImages([event(1, ["a.png", "b.JPG", "c.pdf"].map((n) => join(dir, `1-${n}`)))], 1000);
  assert.deepEqual(
    images.map((image) => image.mimeType),
    ["image/png", "image/jpeg"],
  );
  assert.equal(images[0]!.type, "image");
  assert.equal(Buffer.from(images[0]!.data, "base64").length, 10);
});

test("no more than four images go into one input", async () => {
  const names = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`${n}.webp`, 5]));
  const dir = await files(names);
  const images = await inlineImages([event(1, Object.keys(names).map((n) => join(dir, n)))], 1000);
  assert.equal(images.length, IMAGES_PER_INPUT);
  assert.equal(IMAGES_PER_INPUT, 4);
});

test("an image over the limit, one that cannot be read, and those of other events are left as paths", async () => {
  const dir = await files({ "big.png": 2000, "small.gif": 10 });
  const images = await inlineImages(
    [
      event(1, [join(dir, "big.png"), join(dir, "missing.png")]),
      event(2, [join(dir, "small.gif")], false),
    ],
    1000,
  );
  assert.deepEqual(images, []);
});
