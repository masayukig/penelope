// The addresses in what she and the owner write: only http and https, and
// without the punctuation or the closing bracket after them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { linksOf } from "../src/ui/links.tsx";

/** The parts as [text, href] pairs; a part with no href is plain text. */
const parts = (text: string) => linksOf(text).map((part) => (part.href === undefined ? [part.text] : [part.text, part.href]));

describe("the addresses in a text", () => {
  it("finds a bare address among the words", () => {
    assert.deepEqual(parts("see https://example.com/a?b=1#c now"), [["see "], ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"], [" now"]]);
  });

  it("finds http as well as https, and more than one", () => {
    assert.deepEqual(parts("http://a.example.com and https://b.example.com"), [
      ["http://a.example.com", "http://a.example.com"],
      [" and "],
      ["https://b.example.com", "https://b.example.com"],
    ]);
  });

  it("leaves the text as it is when there is none", () => {
    assert.deepEqual(parts("ありません"), [["ありません"]]);
    assert.deepEqual(parts(""), []);
  });

  it("ends an address at Japanese words that follow it with no space", () => {
    assert.deepEqual(parts("https://example.com/pr/1を見てください"), [["https://example.com/pr/1", "https://example.com/pr/1"], ["を見てください"]]);
  });

  it("keeps the punctuation after an address out of it", () => {
    for (const end of ["。", "、", ".", ",", ":", ";", "!", "?", "'", '"', "*", "_", "~"]) {
      assert.deepEqual(parts(`https://example.com/x${end}`), [["https://example.com/x", "https://example.com/x"], [end]], end);
    }
  });

  it("keeps a closing bracket out of it, unless the address opened one", () => {
    assert.deepEqual(parts("（https://example.com/x）"), [["（"], ["https://example.com/x", "https://example.com/x"], ["）"]]);
    assert.deepEqual(parts("(https://example.com/x)"), [["("], ["https://example.com/x", "https://example.com/x"], [")"]]);
    assert.deepEqual(parts("[https://example.com/x]"), [["["], ["https://example.com/x", "https://example.com/x"], ["]"]]);
    assert.deepEqual(parts("https://example.com/wiki/Foo_(bar)."), [["https://example.com/wiki/Foo_(bar)", "https://example.com/wiki/Foo_(bar)"], ["."]]);
  });

  it("links no other scheme", () => {
    for (const text of ["javascript:alert(1)", "mailto:someone@example.com", "file:///etc/passwd", "data:text/html,x", "ftp://example.com", "www.example.com"]) {
      assert.deepEqual(parts(text), [[text]], text);
    }
  });

  it("does not take an address with nothing after its scheme", () => {
    assert.deepEqual(parts("https:// と書く"), [["https:// と書く"]]);
  });

  it("does not take https inside a word", () => {
    assert.deepEqual(parts("xhttps://example.com"), [["xhttps://example.com"]]);
  });
});
