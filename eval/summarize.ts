import { readFileSync } from "node:fs";
import { sum, type Score } from "./scoring.ts";

type Run = { label: "base" | "candidate"; revision: string; score: Score };
const rows = readFileSync(process.argv[2]!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Run);
const versions = Object.fromEntries((["base", "candidate"] as const).map((label) => {
  const runs = rows.filter((row) => row.label === label);
  return [label, { revision: runs[0]!.revision, runs: runs.length, score: sum(runs.map(({ score }) => score)) }];
}));
console.log(JSON.stringify({ kind: "summary", versions }));
