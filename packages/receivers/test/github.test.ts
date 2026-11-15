import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import type { WebhookOutcome, WebhookRequest } from "../src/plugin.ts";
import { SettingsError } from "../src/plugin.ts";
import { github } from "../src/plugins/github.ts";

const SECRET = "example-webhook-secret-0001";
const SECRET_FILE = "/run/secrets/github-webhook-secret";
const RECEIVED = new Date("2026-11-15T10:05:00.000Z");
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

const SETTINGS = { secret_file: SECRET_FILE, authors: ["renovate[bot]", "example-bot[bot]"], reviewers: ["example-operator"] };

function handler(settings: Record<string, unknown> = SETTINGS) {
  return github.create(settings, {
    readFile: (path) => {
      if (path === SECRET_FILE) return `  ${SECRET}\n`;
      throw new Error(`ENOENT: ${path}`);
    },
  });
}

const sign = (bytes: Uint8Array, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;

type Headers = { event?: string | null; delivery?: string | null; signature?: string | null };

/** A delivery as GitHub sends it: the event and its ID in headers, the body signed with the secret. */
function request(body: unknown, headers: Headers = {}): WebhookRequest {
  const bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const all: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "GitHub-Hookshot/044aadd",
    "x-github-hook-id": "292430182",
    "x-github-hook-installation-target-id": "79929171",
    "x-github-hook-installation-target-type": "integration",
  };
  const event = headers.event === undefined ? "pull_request" : headers.event;
  const delivery = headers.delivery === undefined ? DELIVERY : headers.delivery;
  const signature = headers.signature === undefined ? sign(bytes) : headers.signature;
  if (event !== null) all["x-github-event"] = event;
  if (delivery !== null) all["x-github-delivery"] = delivery;
  if (signature !== null) all["x-hub-signature-256"] = signature;
  return { headers: all, body: bytes, receivedAt: RECEIVED };
}

function accepted(outcome: WebhookOutcome) {
  assert.equal(outcome.kind, "accept", JSON.stringify(outcome));
  return outcome as Extract<WebhookOutcome, { kind: "accept" }>;
}

function badRequest(outcome: WebhookOutcome): string {
  assert.equal(outcome.kind, "refuse", JSON.stringify(outcome));
  assert.equal((outcome as { status: number }).status, 400, JSON.stringify(outcome));
  return (outcome as { reason: string }).reason;
}

const none = (outcome: WebhookOutcome, dropped: number) => {
  const taken = accepted(outcome);
  assert.deepEqual([taken.events, taken.dropped, taken.notes], [[], dropped, []]);
};

const user = (login: string, id: number, type = "User") => ({
  login,
  id,
  node_id: "MDQ6VXNlcjE=",
  avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  html_url: `https://github.com/${login}`,
  type,
  site_admin: false,
});

const repository = {
  id: 186853002,
  node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
  name: "natsumi",
  full_name: "yuanying/natsumi",
  private: false,
  owner: user("yuanying", 21031883),
  html_url: "https://github.com/yuanying/natsumi",
  default_branch: "main",
};

/** A pull request as the two events carry it, opened by Renovate. */
const pullRequest = {
  url: "https://api.github.com/repos/yuanying/natsumi/pulls/12",
  id: 279147437,
  node_id: "MDExOlB1bGxSZXF1ZXN0Mjc5MTQ3NDM3",
  html_url: "https://github.com/yuanying/natsumi/pull/12",
  diff_url: "https://github.com/yuanying/natsumi/pull/12.diff",
  number: 12,
  state: "open",
  locked: false,
  title: "Update dependency example to v1.2.3",
  user: user("renovate[bot]", 29139614, "Bot"),
  body: "This PR contains the following updates: ...",
  created_at: "2026-11-15T09:00:00Z",
  updated_at: "2026-11-15T10:00:00Z",
  requested_reviewers: [user("example-operator", 4242)],
  requested_teams: [],
  head: { label: "yuanying:renovate/example-1.x", ref: "renovate/example-1.x", sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821", user: user("yuanying", 21031883), repo: repository },
  base: { label: "yuanying:main", ref: "main", sha: "f95f852bd8fca8fcc58a9a2d6c842781e32a215e", user: user("yuanying", 21031883), repo: repository },
  draft: false,
  merged: false,
};

const reviewRequested = {
  action: "review_requested",
  number: 12,
  pull_request: pullRequest,
  requested_reviewer: user("example-operator", 4242),
  repository,
  sender: user("renovate[bot]", 29139614, "Bot"),
  installation: { id: 2311213, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uMjMxMTIxMw==" },
};

const dismissed = {
  action: "dismissed",
  review: {
    id: 237895671,
    node_id: "MDE3OlB1bGxSZXF1ZXN0UmV2aWV3MjM3ODk1Njcx",
    user: user("example-operator", 4242),
    body: "Looks good.",
    commit_id: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
    submitted_at: "2026-11-15T09:30:00Z",
    state: "dismissed",
    html_url: "https://github.com/yuanying/natsumi/pull/12#pullrequestreview-237895671",
    author_association: "OWNER",
  },
  pull_request: pullRequest,
  repository,
  sender: user("yuanying", 21031883),
  installation: { id: 2311213, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uMjMxMTIxMw==" },
};

const asDismissal = (body: unknown, headers: Headers = {}) => request(body, { event: "pull_request_review", ...headers });

/** `body` with the field at `path` replaced by `value`, or removed when `value` is undefined. */
function withField(body: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(body);
  const keys = path.split(".");
  let at: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  const last = keys.at(-1)!;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

describe("the GitHub plugin's settings", () => {
  test("is a webhook plugin named github", () => {
    assert.equal(github.name, "github");
    assert.equal(github.kind, "webhook");
  });

  const refused = (settings: Record<string, unknown>, field: RegExp, readFile: (path: string) => string = () => SECRET) => {
    assert.throws(() => github.create(settings, { readFile }), (error: unknown) => {
      assert.ok(error instanceof SettingsError, String(error));
      assert.match(error.message, field);
      assert.equal(error.message.includes(SECRET), false, "the secret is not written");
      return true;
    });
  };

  test("needs secret_file, and a secret in it", () => {
    const { secret_file: _, ...noSecret } = SETTINGS;
    refused(noSecret, /^secret_file: /);
    refused({ ...SETTINGS, secret_file: "" }, /^secret_file: /);
    refused(SETTINGS, /^secret_file: /, () => {
      throw new Error("ENOENT");
    });
    refused(SETTINGS, /^secret_file: /, () => " \n");
  });

  test("needs authors and reviewers, each a list of one or more logins", () => {
    for (const field of ["authors", "reviewers"] as const) {
      const { [field]: _, ...without } = SETTINGS;
      refused(without, new RegExp(`^${field}: `));
      refused({ ...SETTINGS, [field]: [] }, new RegExp(`^${field}: `));
      refused({ ...SETTINGS, [field]: "example-operator" }, new RegExp(`^${field}: `));
    }
  });

  test("refuses a login that is not a non-empty string", () => {
    refused({ ...SETTINGS, authors: ["renovate[bot]", ""] }, /^authors\[1\]: /);
    refused({ ...SETTINGS, reviewers: [42] }, /^reviewers\[0\]: /);
  });

  test("refuses the same login twice, even when only the case differs", () => {
    refused({ ...SETTINGS, reviewers: ["example-operator", "Example-Operator"] }, /^reviewers\[1\]: /);
    refused({ ...SETTINGS, authors: ["renovate[bot]", "renovate[bot]"] }, /^authors\[1\]: /);
  });

  test("refuses fields it does not know", () => {
    refused({ ...SETTINGS, secret: SECRET }, /^secret: /);
  });
});

describe("the GitHub plugin's check of the signature", () => {
  test("refuses with 401 a missing signature, one of another shape and a wrong one, the same way", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(reviewRequested));
    const right = sign(bytes);
    for (const signature of [
      null,
      "",
      right.slice("sha256=".length),
      `sha1=${right.slice("sha256=".length)}`,
      right.slice(0, -1),
      `${right}0`,
      `sha256=${"z".repeat(64)}`,
      sign(bytes, "another-secret"),
      ` ${right}`,
    ]) {
      assert.deepEqual(handler()(request(reviewRequested, { signature })), { kind: "refuse", status: 401 }, String(signature));
    }
  });

  test("does not take the SHA-1 signature in place of the SHA-256 one", () => {
    const sent = request(reviewRequested, { signature: null });
    const sha1 = `sha1=${createHmac("sha1", SECRET).update(sent.body).digest("hex")}`;
    assert.deepEqual(handler()({ ...sent, headers: { ...sent.headers, "x-hub-signature": sha1 } }), { kind: "refuse", status: 401 });
  });

  test("takes the hex in either case", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(reviewRequested));
    const upper = `sha256=${sign(bytes).slice("sha256=".length).toUpperCase()}`;
    assert.equal(accepted(handler()(request(reviewRequested, { signature: upper }))).events.length, 1);
  });

  test("checks the signature before the headers and the body", () => {
    for (const [body, headers] of [
      ["not json", {}],
      [reviewRequested, { event: null }],
      [reviewRequested, { event: "ping" }],
      [reviewRequested, { delivery: null }],
    ] as const) {
      assert.deepEqual(handler()(request(body, { ...headers, signature: "sha256=" + "0".repeat(64) })), { kind: "refuse", status: 401 });
    }
  });
});

describe("the GitHub plugin's order of reading a delivery", () => {
  test("refuses with 400 a delivery without X-GitHub-Event", () => {
    assert.match(badRequest(handler()(request(reviewRequested, { event: null }))), /X-GitHub-Event/);
    assert.match(badRequest(handler()(request(reviewRequested, { event: "" }))), /X-GitHub-Event/);
  });

  test("takes a ping, and makes no event of it", () => {
    const ping = { zen: "Keep it logically awesome.", hook_id: 292430182, hook: { type: "App", id: 292430182, events: ["pull_request", "pull_request_review"] } };
    none(handler()(request(ping, { event: "ping" })), 0);
  });

  test("takes an event it does not read without reading the body", () => {
    none(handler()(request("not json", { event: "check_suite" })), 0);
    none(handler()(request(reviewRequested, { event: "issues", delivery: null })), 0);
  });

  test("refuses with 400 a body that is not a JSON object with a string action", () => {
    for (const body of ["{", "[]", "\"review_requested\"", { number: 12 }, { action: 1 }]) {
      assert.match(badRequest(handler()(request(body))), /body|action/, JSON.stringify(body));
      assert.match(badRequest(handler()(asDismissal(body))), /body|action/, JSON.stringify(body));
    }
    const invalid = new Uint8Array([0x7b, 0xff, 0x7d]);
    const outcome = handler()({ headers: { "x-github-event": "pull_request", "x-github-delivery": DELIVERY, "x-hub-signature-256": sign(invalid) }, body: invalid, receivedAt: RECEIVED });
    badRequest(outcome);
  });

  test("takes the other actions of the two events without checking the rest of the body", () => {
    for (const action of ["opened", "synchronize", "closed", "review_request_removed"]) {
      none(handler()(request({ action }, { delivery: null })), 0);
    }
    none(handler()(request({ ...reviewRequested, action: "dismissed" })), 0);
    for (const action of ["submitted", "edited"]) {
      none(handler()(asDismissal({ action }, { delivery: null })), 0);
    }
    none(handler()(asDismissal({ ...dismissed, action: "review_requested" })), 0);
  });

  test("refuses with 400 a delivery of an action it reads without X-GitHub-Delivery", () => {
    assert.match(badRequest(handler()(request(reviewRequested, { delivery: null }))), /X-GitHub-Delivery/);
    assert.match(badRequest(handler()(request(reviewRequested, { delivery: "" }))), /X-GitHub-Delivery/);
    assert.match(badRequest(handler()(asDismissal(dismissed, { delivery: null }))), /X-GitHub-Delivery/);
  });

  test("refuses with 400 a body that lacks a field it reads, naming the field", () => {
    const cases: [string, unknown][] = [
      ["pull_request", undefined],
      ["pull_request", "12"],
      ["pull_request.number", undefined],
      ["pull_request.number", 0],
      ["pull_request.number", 1.5],
      ["pull_request.number", "12"],
      ["pull_request.title", undefined],
      ["pull_request.title", 1],
      ["pull_request.html_url", undefined],
      ["pull_request.user", null],
      ["pull_request.user.login", ""],
      ["pull_request.head.sha", ""],
      ["pull_request.head.sha", undefined],
      ["pull_request.head.ref", undefined],
      ["pull_request.base.ref", 1],
      ["pull_request.base.repo", undefined],
      ["pull_request.base.repo.full_name", "natsumi"],
      ["pull_request.base.repo.full_name", "yuanying/natsumi/x"],
      ["pull_request.base.repo.full_name", "/natsumi"],
      ["pull_request.base.repo.full_name", undefined],
    ];
    for (const [path, value] of cases) {
      for (const outcome of [handler()(request(withField(reviewRequested, path, value))), handler()(asDismissal(withField(dismissed, path, value)))]) {
        const named = badRequest(outcome).split(": ")[0]!;
        assert.ok(named === path || named.startsWith(`${path}.`), `${path}=${JSON.stringify(value)} is named in ${named}`);
      }
    }
  });

  test("refuses with 400 a request to a person without a login, and a dismissal without its reviewer", () => {
    assert.match(badRequest(handler()(request(withField(reviewRequested, "requested_reviewer.login", "")))), /^requested_reviewer\.login: /);
    assert.match(badRequest(handler()(request(withField(reviewRequested, "requested_reviewer", "example-operator")))), /^requested_reviewer: /);
    assert.match(badRequest(handler()(asDismissal(withField(dismissed, "review", undefined)))), /^review: /);
    assert.match(badRequest(handler()(asDismissal(withField(dismissed, "review.user", null)))), /^review\.user: /);
    assert.match(badRequest(handler()(asDismissal(withField(dismissed, "review.user.login", 4242)))), /^review\.user\.login: /);
  });

  test("does not write the body's content in the reason", () => {
    const reason = badRequest(handler()(request(withField(reviewRequested, "pull_request.base.repo.full_name", "secret-looking-value"))));
    assert.equal(reason.includes("secret-looking-value"), false, reason);
  });

  test("drops a request to a team, which it does not match against the reviewers", () => {
    const { requested_reviewer: _, ...toTeam } = reviewRequested;
    const team = { ...toTeam, requested_team: { name: "example-operator", id: 3253328, slug: "example-operator", privacy: "closed" } };
    none(handler()(request(team)), 1);
    none(handler()(request({ ...team, requested_reviewer: null })), 1);
  });

  test("drops a request to someone not in the reviewers, and a dismissal of their review", () => {
    none(handler()(request(withField(reviewRequested, "requested_reviewer.login", "someone-else"))), 1);
    none(handler()(asDismissal(withField(dismissed, "review.user.login", "someone-else"))), 1);
  });

  test("drops a pull request by someone not in the authors", () => {
    none(handler()(request(withField(reviewRequested, "pull_request.user.login", "dependabot[bot]"))), 1);
    none(handler()(asDismissal(withField(dismissed, "pull_request.user.login", "dependabot[bot]"))), 1);
  });

  test("matches logins in any case", () => {
    const settings = { ...SETTINGS, authors: ["Renovate[bot]"], reviewers: ["EXAMPLE-operator"] };
    assert.equal(accepted(handler(settings)(request(withField(reviewRequested, "requested_reviewer.login", "Example-Operator")))).events.length, 1);
    assert.equal(accepted(handler(settings)(asDismissal(withField(dismissed, "pull_request.user.login", "RENOVATE[BOT]")))).events.length, 1);
  });
});

describe("the GitHub plugin's events", () => {
  test("makes one batch event of a request for a review, from the fields it reads", () => {
    const taken = accepted(handler()(request(reviewRequested)));
    assert.deepEqual([taken.dropped, taken.notes], [0, []]);
    assert.deepEqual(taken.events, [
      {
        id: DELIVERY,
        occurred_at: "2026-11-15T10:05:00.000Z",
        summary: "[review requested] yuanying/natsumi#12: Update dependency example to v1.2.3",
        stream: "yuanying.natsumi",
        delivery: "batch",
        payload: {
          event: "pull_request",
          action: "review_requested",
          delivery: DELIVERY,
          repository: "yuanying/natsumi",
          number: 12,
          title: "Update dependency example to v1.2.3",
          url: "https://github.com/yuanying/natsumi/pull/12",
          author: "renovate[bot]",
          head_sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
          head_ref: "renovate/example-1.x",
          base_ref: "main",
          reviewer: "example-operator",
        },
      },
    ]);
  });

  test("makes one batch event of a dismissed review", () => {
    const taken = accepted(handler()(asDismissal(dismissed)));
    assert.deepEqual(taken.events, [
      {
        id: DELIVERY,
        occurred_at: "2026-11-15T10:05:00.000Z",
        summary: "[review dismissed] yuanying/natsumi#12: Update dependency example to v1.2.3",
        stream: "yuanying.natsumi",
        delivery: "batch",
        payload: {
          event: "pull_request_review",
          action: "dismissed",
          delivery: DELIVERY,
          repository: "yuanying/natsumi",
          number: 12,
          title: "Update dependency example to v1.2.3",
          url: "https://github.com/yuanying/natsumi/pull/12",
          author: "renovate[bot]",
          head_sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
          head_ref: "renovate/example-1.x",
          base_ref: "main",
          reviewer: "example-operator",
        },
      },
    ]);
  });

  test("keeps the logins and the repository as they came", () => {
    const body = withField(withField(reviewRequested, "requested_reviewer.login", "Example-Operator"), "pull_request.base.repo.full_name", "Example-Org/My.Repo");
    const [event] = accepted(handler()(request(body))).events;
    assert.deepEqual([event!.stream, (event!.payload as Record<string, unknown>).repository, (event!.payload as Record<string, unknown>).reviewer], ["example-org.my.repo", "Example-Org/My.Repo", "Example-Operator"]);
    assert.equal(event!.summary, "[review requested] Example-Org/My.Repo#12: Update dependency example to v1.2.3");
  });

  test("maps the repository to a stream as Alertmanager's alertname is mapped", () => {
    const streamOf = (fullName: string) => accepted(handler()(request(withField(reviewRequested, "pull_request.base.repo.full_name", fullName)))).events[0]!.stream;
    assert.equal(streamOf("yuanying/natsumi"), "yuanying.natsumi");
    assert.equal(streamOf("Owner/Repo Name"), "owner.repo_name");
    assert.equal(streamOf(".github/.github"), "_github..github");
    assert.equal(streamOf(`o/${"R".repeat(150)}`), `o.${"r".repeat(98)}`);
  });

  test("makes the summary one line of up to 200 code points", () => {
    const summaryOf = (title: string) => accepted(handler()(request(withField(reviewRequested, "pull_request.title", title)))).events[0]!.summary;
    assert.equal(summaryOf("one\r\ntwo\tthree\u0007"), "[review requested] yuanying/natsumi#12: one two three ");
    assert.equal(summaryOf(""), "[review requested] yuanying/natsumi#12: ");
    const long = summaryOf("😀".repeat(300));
    assert.equal([...long].length, 200);
    assert.ok(long.startsWith("[review requested] yuanying/natsumi#12: 😀"));
  });

  test("leaves the body, the comments and the other fields out of the payload", () => {
    const [event] = accepted(handler()(asDismissal(dismissed))).events;
    const text = JSON.stringify(event);
    assert.equal(text.includes("This PR contains"), false);
    assert.equal(text.includes("Looks good."), false);
    assert.equal(text.includes("installation"), false);
  });
});
