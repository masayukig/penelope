import { questions } from "./scenario.ts";

type Category = (typeof questions)[number]["category"];
type Points = { passed: number; total: number };
export type Score = Points & { categories: Record<Category, Points> };

const points = (): Points => ({ passed: 0, total: 0 });
const add = (to: Points, from: Points) => {
  to.passed += from.passed;
  to.total += from.total;
};
function emptyScore(): Score {
  return {
    ...points(),
    categories: { rule_changes: points(), corrections: points(), uncertainty: points(), added_details: points(), preservation: points() },
  };
}

export function score(raw: string) {
  let parsed: Record<string, Record<string, unknown> | undefined> = {};
  let validJSON = true;
  try {
    parsed = JSON.parse(raw) ?? {};
  } catch {
    validJSON = false;
  }
  const checks = questions.flatMap(({ id, category, fields, evidence: expected }) => {
    const response = parsed[id];
    const evidence = response?.evidence;
    return [
      ...Object.entries(fields).map(([field, value]) => ({ category, check: `${id}.${field}`, pass: response?.[field] === value })),
      // No extra citations: citing a superseded rule as current does not count.
      { category, check: `${id}.evidence`, pass: Array.isArray(evidence) && evidence.length === expected.length && expected.every((ref) => evidence.includes(ref)) },
    ];
  });
  const subtotal = emptyScore();
  for (const { category, pass } of checks) {
    const check = { passed: Number(pass), total: 1 };
    add(subtotal, check);
    add(subtotal.categories[category], check);
  }
  return { validJSON, ...subtotal, checks };
}

export function sum(scores: readonly Score[]): Score {
  const total = emptyScore();
  for (const score of scores) {
    add(total, score);
    for (const category of Object.keys(total.categories) as Category[]) add(total.categories[category], score.categories[category]);
  }
  return total;
}
