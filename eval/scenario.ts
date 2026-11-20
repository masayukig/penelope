// Every person, place, document and terminal record in this replay is fictional.
export const days = [
  {
    date: "2031-05-06",
    id: "NOTICE-14",
    summary: "Initial crate pickup rule",
    text: "NOTICE-14 (May 6): Sample crates go to WEST and close at 16:00 local time.",
    file: "pickup-original.md",
    note: "NOTICE-14 (May 6): crates go to WEST by 16:00 local time.",
  },
  {
    date: "2031-05-07",
    id: "NOTICE-19",
    summary: "Revised crate pickup rule",
    text: "NOTICE-19 (May 7), effective immediately, supersedes NOTICE-14: send sample crates to EAST by 14:00 local time. Crates carrying the HOLD flag instead go to REVIEW, with the same cutoff.",
    file: "pickup-update.md",
    note: "NOTICE-19 (May 7): crates now go to EAST by 16:00 local time. HOLD crates go to REVIEW.",
  },
  {
    date: "2031-05-08",
    id: "MANIFEST-63",
    summary: "Crate manifest ready for pickup",
    text: "MANIFEST-63 (May 8): crate LARK has the HOLD flag. Crate SEDGE has no flag. Final seal on LARK is available only in the terminal receipt.",
    receipt: "RECEIPT-57 (May 8): crate LARK, final seal R7-KITE.",
    file: "pickup-manifest.md",
    note: "MANIFEST-63 (May 8): LARK has HOLD, SEDGE has no flag. Terminal receipt checked; no seal recorded.",
  },
] as const;

// The text for the model and the scoring key are deliberately separate.
export const questions = [
  { id: "routing", ask: "Where should LARK and SEDGE go for the next pickup, and by what local time? Cite the current rule and the manifest." },
  { id: "seal", ask: "What final seal should be checked on the crate routed to REVIEW? Cite the current rule, the manifest and the terminal receipt." },
] as const;

// One point per check. The expected answers must never be part of the model input.
export const rubric = {
  routing: { fields: { lark: "REVIEW", sedge: "EAST", cutoff: "14:00" }, evidence: ["NOTICE-19", "MANIFEST-63"] },
  seal: { fields: { crate: "LARK", seal: "R7-KITE" }, evidence: ["NOTICE-19", "MANIFEST-63", "RECEIPT-57"] },
} as const;
