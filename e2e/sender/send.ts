// The small sender the test runs in the receivers container, beside the
// receivers themselves, to post envelopes of its own making: it posts the
// envelope on its stdin to the backend's intake socket (docs/events.md,
// "取り込み口") and prints the status and the body of the answer.
import http from "node:http";
import process from "node:process";

const socketPath = process.env.PENELOPE_INTAKE_SOCKET ?? "/run/penelope/intake/backend.sock";

const parts: Buffer[] = [];
for await (const part of process.stdin) parts.push(part as Buffer);
const envelope = Buffer.concat(parts);

const request = http.request(
  { socketPath, path: "/v1/events", method: "POST", headers: { "content-type": "application/json", "content-length": envelope.length } },
  (response) => {
    const answer: Buffer[] = [];
    response.on("data", (part: Buffer) => answer.push(part));
    response.on("end", () => process.stdout.write(`${response.statusCode} ${Buffer.concat(answer).toString("utf8")}\n`));
  },
);
request.on("error", (error) => {
  process.stderr.write(`send: ${error.message}\n`);
  process.exitCode = 1;
});
request.end(envelope);
