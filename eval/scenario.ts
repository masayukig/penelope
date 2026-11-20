// Every person, place, document and terminal record in this replay is fictional.
type ScriptedEvent = { source: string; id: string; summary: string; text: string; file: string; note: string; receipt?: string };

export const days: readonly { date: string; records: readonly ScriptedEvent[] }[] = [
  {
    date: "2031-05-06",
    records: [
      {
        source: "bulletin", id: "NOTICE-14", summary: "Initial crate pickup rule",
        text: "NOTICE-14 (May 6): Sample crates go to WEST and close at 16:00 local time.",
        file: "pickup-original.md", note: "NOTICE-14 (May 6): crates go to WEST by 16:00 local time.",
      },
      {
        source: "handling", id: "HANDLING-03", summary: "Standing wrapping instructions",
        text: "HANDLING-03 (May 6): Wrap sample crates in dry felt. This handling instruction is independent of the current pickup route.",
        file: "wrapping.md", note: "HANDLING-03 (May 6): wrap sample crates in DRY FELT regardless of pickup route.",
      },
      {
        source: "signoff", id: "SIGNOFF-11", summary: "Initial pickup sign-off rule",
        text: "SIGNOFF-11 (May 6): Before handover, the RED desk must sign the pickup sheet for every crate at every dock.",
        file: "signoff-original.md", note: "SIGNOFF-11 (May 6): all pickup sheets need a signature from the RED desk.",
      },
    ],
  },
  {
    date: "2031-05-07",
    records: [
      {
        source: "bulletin", id: "NOTICE-19", summary: "Revised crate pickup rule",
        text: "NOTICE-19 (May 7), effective immediately, supersedes NOTICE-14: send sample crates to EAST by 14:00 local time. Crates carrying the HOLD flag instead go to REVIEW, with the same cutoff.",
        file: "pickup-update.md", note: "NOTICE-19 (May 7): crates now go to EAST by 16:00 local time. HOLD crates go to REVIEW.",
      },
      {
        source: "inventory", id: "COUNT-CHECK", summary: "Counting slip issued for SEDGE",
        text: "COUNT-CHECK (May 7): The terminal counting slip is the signed count for crate SEDGE. The shipping tally has not changed since this count.",
        receipt: "COUNT-52 (May 7): signed count for SEDGE = 12 inserts.",
        file: "sedge-count.md", note: "COUNT-52 (May 7): SEDGE has 21 inserts according to the signed count.",
      },
    ],
  },
  {
    date: "2031-05-08",
    records: [
      {
        source: "inventory", id: "MANIFEST-63", summary: "Crate manifest ready for pickup",
        text: "MANIFEST-63 (May 8): crate LARK has the HOLD flag. Crate SEDGE has no flag. The final seal on LARK is available in the terminal receipt.",
        receipt: "SEAL-57 (May 8): crate LARK, final seal R7-KITE.",
        file: "pickup-manifest.md", note: "MANIFEST-63 (May 8): LARK has HOLD, SEDGE has no flag. Terminal receipt checked; no seal recorded.",
      },
      {
        source: "inspection", id: "SLEEVE-CHECK", summary: "Sleeve inspection receipt issued for LARK",
        text: "SLEEVE-CHECK (May 8): The depot has not scheduled any follow-up test for the sleeve on LARK. The terminal receipt records what was tested.",
        receipt: "INSPECT-41 (May 8): LARK's sleeve looks glossy. No water-resistance test was run; the test result is unknown.",
        file: "lark-sleeve.md", note: "INSPECT-41 (May 8): LARK's glossy sleeve is confirmed waterproof.",
      },
    ],
  },
  {
    date: "2031-05-09",
    records: [
      {
        source: "bulletin", id: "NOTICE-28", summary: "Second revision to crate pickup",
        text: "NOTICE-28 (May 9) replaces NOTICE-19 immediately. Use NORTH by 13:30 local time, but HOLD crates still go to REVIEW by that same cutoff. Handling instructions stay the same.",
        file: "pickup-current.md", note: "NOTICE-28 (May 9): NORTH by 13:30 local time. HOLD exceptions still use REVIEW.",
      },
      {
        source: "inventory", id: "SHELF-CHECK", summary: "LARK's assigned shelf confirmed",
        text: "SHELF-CHECK (May 9): The terminal allocation slip gives LARK's assigned pre-pickup shelf. It is separate from the pickup dock.",
        receipt: "SHELF-71 (May 9): assigned shelf for LARK = B-04; confirmed by the depot.",
        file: "lark-shelf.md", note: "SHELF-71 (May 9): LARK is assigned to B-40 before pickup.",
      },
    ],
  },
  {
    date: "2031-05-10",
    records: [
      {
        source: "inspection", id: "LOCKER-CHECK", summary: "Final checks receipt issued for SEDGE",
        text: "LOCKER-CHECK (May 10): The final checks receipt records SEDGE's locker and vibration-test status. This is the latest check before pickup.",
        receipt: "CHECK-88 (May 10): SEDGE is in locker MOTH-26. The foam is intact, but the vibration test was skipped; no pass or fail was recorded.",
        file: "sedge-checks.md", note: "CHECK-88 (May 10): SEDGE passed the vibration test; the foam is intact.",
      },
      {
        source: "handling", id: "RETURNS-09", summary: "Standing empty sleeve returns rule",
        text: "RETURNS-09 (May 10): Put empty orange sleeves in the LINEN CABINET so they can be reused. This is not a crate pickup destination.",
        file: "sleeve-returns.md", note: "RETURNS-09 (May 10): empty orange sleeves go to the LINEN CABINET for reuse.",
      },
      {
        source: "signoff", id: "SIGNOFF-36", summary: "Pickup sign-off moves to a new desk",
        text: "SIGNOFF-36 (May 10) replaces SIGNOFF-11: before handover, the BLUE desk now signs the pickup sheet for every crate, including HOLD crates.",
        file: "signoff-current.md", note: "SIGNOFF-36 (May 10): the BLUE desk signs all pickup sheets, including for HOLD crates.",
      },
    ],
  },
];

// The questions and rubric are fixed before the first run. The answer session
// receives only the question text and empty field names, never the rubric values.
export const questions = [
  {
    id: "routing", category: "rule_changes",
    ask: "Where should LARK and SEDGE go at the next pickup, by what local time, and which desk signs their pickup sheets? Cite the current routing and sign-off rules and the manifest.",
    fields: { lark: "REVIEW", sedge: "NORTH", cutoff: "13:30", desk: "BLUE" }, evidence: ["NOTICE-28", "MANIFEST-63", "SIGNOFF-36"],
  },
  {
    id: "history", category: "rule_changes",
    ask: "Where did ordinary crates go on May 6, and where and by what local time did they go on May 7? Cite the two applicable notices.",
    fields: { may6Dock: "WEST", may7Dock: "EAST", may7Cutoff: "14:00" }, evidence: ["NOTICE-14", "NOTICE-19"],
  },
  {
    id: "inventory", category: "corrections",
    ask: "What is LARK's pre-pickup shelf, and how many inserts are in SEDGE according to the signed count? Cite the two terminal records. Give the count as a number.",
    fields: { shelf: "B-04", count: 12 }, evidence: ["SHELF-71", "COUNT-52"],
  },
  {
    id: "certainty", category: "uncertainty",
    ask: "Has LARK's sleeve been verified waterproof? Has SEDGE been verified to pass the vibration test? For each, answer VERIFIED or UNVERIFIED, and cite the two terminal records.",
    fields: { waterproof: "UNVERIFIED", vibration: "UNVERIFIED" }, evidence: ["INSPECT-41", "CHECK-88"],
  },
  {
    id: "details", category: "added_details",
    ask: "What exact final seal should be checked on LARK, and in which locker is SEDGE? Cite the two terminal records.",
    fields: { seal: "R7-KITE", locker: "MOTH-26" }, evidence: ["SEAL-57", "CHECK-88"],
  },
  {
    id: "handling", category: "preservation",
    ask: "Despite the changes to pickup, what material wraps sample crates, and where do empty orange sleeves go? Cite the two handling instructions.",
    fields: { wrap: "DRY FELT", returns: "LINEN CABINET" }, evidence: ["HANDLING-03", "RETURNS-09"],
  },
] as const;
