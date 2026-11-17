// The addresses in what she and the owner write, as links that open in a new
// tab. Only http and https become links: an address of another scheme, or a
// written link to one, stays text. An address ends at the first character an
// address does not use (a space, or Japanese that follows it with no space),
// and the punctuation or the closing bracket after it is not part of it.
import type { MarkdownComponents, MarkdownInlinePlugin } from "@astryxdesign/core/Markdown";
import { createContext, type ReactNode, useContext } from "react";

/** A candidate: http or https, not inside a word, and the characters an address may use after it. */
const ADDRESS = /(?<![A-Za-z0-9])https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

/** What may close a sentence after an address, and so is not part of it. */
const TRAILING = new Set([".", ",", ":", ";", "!", "?", "'", '"', "*", "_", "~"]);
const CLOSING: Record<string, string> = { ")": "(", "]": "[" };

const count = (text: string, char: string) => text.split(char).length - 1;

/** The end of the address the candidate starts, or false when nothing is left of it after its scheme. */
function endOf(text: string, match: RegExpMatchArray): number | false {
  const start = match.index ?? 0;
  let address = match[0];
  for (;;) {
    const last = address.at(-1)!;
    const opening = CLOSING[last];
    if (TRAILING.has(last)) address = address.slice(0, -1);
    // A closing bracket the address did not open belongs to the text around it.
    else if (opening !== undefined && count(address, last) > count(address, opening)) address = address.slice(0, -1);
    else break;
  }
  if (!/^https?:\/\/[^/?#]/.test(address)) return false;
  return start + address.length;
}

export type Part = { text: string; href?: string };

/** The text as its parts: the addresses with their href, and the words between them. */
export function linksOf(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const start = match.index;
    const end = endOf(text, match);
    if (end === false) continue;
    if (start > at) parts.push({ text: text.slice(at, start) });
    const address = text.slice(start, end);
    parts.push({ text: address, href: address });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

const isWeb = (href: string) => /^https?:\/\//i.test(href);

/** A link to the web, in a new tab, that hands the page it opens nothing of this one. */
function WebLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Plain text with its addresses as links. */
export function Linked({ text }: { text: string }) {
  return (
    <>
      {linksOf(text).map((part, index) =>
        part.href === undefined ? (
          part.text
        ) : (
          <WebLink key={index} href={part.href}>
            {part.text}
          </WebLink>
        ),
      )}
    </>
  );
}

/** Whether the text being drawn is already inside a written link: no link goes in a link. */
const InLink = createContext(false);

function BareAddress({ address }: { address: string }) {
  return useContext(InLink) ? address : <WebLink href={address}>{address}</WebLink>;
}

/** A written link: to the web in a new tab, and any other only its words. */
function WrittenLink({ href, children }: { href: string; children: ReactNode }) {
  return <InLink.Provider value>{isWeb(href) ? <WebLink href={href}>{children}</WebLink> : <span>{children}</span>}</InLink.Provider>;
}

const bareAddresses: MarkdownInlinePlugin = {
  pattern: new RegExp(ADDRESS),
  getEndIndex: endOf,
  render: (match, key) => {
    const address = match.input!.slice(match.index, endOf(match.input!, match) || undefined);
    return <BareAddress key={key} address={address} />;
  },
};

/** What `Markdown` takes so that its links are these. */
export const markdownLinks: { inlinePlugins: MarkdownInlinePlugin[]; components: Partial<MarkdownComponents> } = {
  inlinePlugins: [bareAddresses],
  components: { link: WrittenLink },
};
