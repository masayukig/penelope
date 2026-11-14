// The owner's browser, outside the Pod: the test runs this in the outside
// container to reach the backend's API for the UI and the fakes' control API,
// so that it needs no port published to the machine it runs on.
//
//   client.ts request <method> <url> [<headers as JSON>]   body on stdin
//       prints {status, headers, body} as one JSON line
//   client.ts stream <url> <cookie>
//       prints each SSE event as one JSON line {id?, event, data} until killed
import http from "node:http";
import process from "node:process";

const [mode, url, third] = process.argv.slice(2);

async function stdin(): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of process.stdin) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

if (mode === "request" && url) {
  const method = third ?? "GET";
  const headers = JSON.parse(process.argv[5] ?? "{}") as Record<string, string>;
  const body = method === "GET" ? undefined : new Uint8Array(await stdin());
  const response = await fetch(url, { method, headers, body, redirect: "manual" });
  process.stdout.write(
    `${JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })}\n`,
  );
} else if (mode === "stream" && url && third) {
  http.get(url, { headers: { cookie: third, accept: "text/event-stream" } }, (response) => {
    if (response.statusCode !== 200) {
      process.stderr.write(`the stream answered ${response.statusCode}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({ event: "open", data: null })}\n`);
    let buffer = "";
    response.setEncoding("utf8");
    response.on("data", (part: string) => {
      buffer += part;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event: { id?: string; event?: string; data: string[] } = { data: [] };
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "id") event.id = value;
          else if (field === "event") event.event = value;
          else if (field === "data") event.data.push(value);
        }
        if (event.data.length === 0) continue;
        process.stdout.write(`${JSON.stringify({ ...(event.id ? { id: event.id } : {}), event: event.event ?? "message", data: JSON.parse(event.data.join("\n")) })}\n`);
      }
    });
    response.on("end", () => process.exit(0));
  });
} else {
  process.stderr.write("usage: client.ts request <method> <url> [<headers>] | client.ts stream <url> <cookie>\n");
  process.exitCode = 2;
}
