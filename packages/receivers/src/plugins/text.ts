// What the plugins share in making an envelope's text (docs/receivers.md,
// "`stream` の写し方" and "`summary` の形").

const STREAM_MAX = 100;
const SUMMARY_MAX = 200;

/**
 * A name mapped to a stream: upper case to lower, each other character
 * outside the segment's own to `_`, a leading `.` to `_`, cut at 100.
 * Nothing when there is nothing left.
 */
export function streamOf(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const mapped = [...name]
    .map((char) => (/^[A-Z]$/.test(char) ? char.toLowerCase() : /^[a-z0-9._-]$/.test(char) ? char : "_"))
    .join("")
    .replace(/^\./, "_")
    .slice(0, STREAM_MAX);
  return mapped === "" ? undefined : mapped;
}

/** A line made a summary: each run of line breaks and control characters to one space, cut at 200 code points. */
export function summaryLine(line: string): string {
  return [...line.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")].slice(0, SUMMARY_MAX).join("");
}
