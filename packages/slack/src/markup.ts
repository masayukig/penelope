// Slack's markup read as text (https://docs.slack.dev/messaging/formatting-message-text):
// the people and channels it names by ID by their names, links with their
// address, and the three escaped characters as they are.

/** `text` with its markup turned into what it says. `names` gives the names of the IDs it mentions. */
export function plainText(text: string, names: Readonly<Record<string, string>>): string {
  return text
    .replace(/<@([UWB][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names[id] ?? id}`)
    .replace(/<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label || names[id] || id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => label || "@group")
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<mailto:[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<([a-z][a-z0-9+.-]*:[^|>]*)\|([^>]*)>/g, "$2 ($1)")
    .replace(/<([a-z][a-z0-9+.-]*:[^>]*)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
