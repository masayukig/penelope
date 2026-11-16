// slackctl post and faces against a Slack and a backend of the test's own.
// The answers have the shapes of Slack's Web API reference; every value is
// made up.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { run, type Online } from "../src/cli.ts";

type Seen = { url: string; method: string; authorization: string | undefined; form: Record<string, string>; body: Uint8Array };

const PUBLIC = "https://penelope.example.com";
const AGENT = { name: "Iris", icons: { neutral: "/api/agent/icons/neutral.png", happy: "/api/agent/icons/happy.png" } };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** Slack and the backend's public way, with what each was sent. */
function world(answers: Record<string, unknown> = {}) {
  const seen: Seen[] = [];
  let uploads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw === undefined || raw === null ? "" : String(raw));
    const form = headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body))) : {};
    seen.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization") ?? undefined, form, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === `${PUBLIC}/api/agent`) return json(answers.agent ?? AGENT);
    if (url.startsWith("https://files.slack.com/upload/v1/")) {
      const status = (answers.upload as number | undefined) ?? 200;
      return new Response(status === 200 ? `OK - ${body.length}` : "no", { status });
    }
    const method = url.replace("https://slack.com/api/", "");
    if (answers[method] !== undefined) return json(answers[method]);
    switch (method) {
      case "chat.postMessage":
        return json({ ok: true, channel: form.channel, ts: "1794821220.000100", message: { type: "message", text: form.text, ts: "1794821220.000100" } });
      case "chat.getPermalink":
        return json({ ok: true, channel: form.channel, permalink: `https://example.slack.com/archives/${form.channel}/p${form.message_ts?.replace(".", "")}` });
      case "users.conversations":
        return form.cursor === "page-2"
          ? json({ ok: true, channels: [{ id: "C0DEV", name: "dev", is_channel: true }], response_metadata: { next_cursor: "" } })
          : json({ ok: true, channels: [{ id: "C0GEN", name: "general", is_channel: true }], response_metadata: { next_cursor: "page-2" } });
      case "files.getUploadURLExternal":
        uploads++;
        return json({ ok: true, upload_url: `https://files.slack.com/upload/v1/U${uploads}`, file_id: `F0IMG${uploads}` });
      case "files.completeUploadExternal":
        return json({ ok: true, files: (JSON.parse(form.files ?? "[]") as { id: string; title: string }[]).map(({ id, title }) => ({ id, title })) });
      default:
        return json({ ok: false, error: "unknown_method" });
    }
  };
  return { seen, fetcher, calls: () => seen.map((item) => item.url.replace("https://slack.com/api/", "")) };
}

const ENV = { SLACK_BOT_TOKEN: "surrogate-work", PENELOPE_PUBLIC_URL: PUBLIC };

function online(fetcher: typeof fetch, stdin = "", files: Record<string, Uint8Array> = {}): Online {
  return {
    fetch: fetcher,
    stdin: async () => stdin,
    readFile: async (file) => {
      const body = files[file];
      if (body === undefined) throw Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: "ENOENT" });
      return body;
    },
  };
}

describe("slackctl post", () => {
  test("posts the text of stdin as it is, with the bot's token, and says where it went", async () => {
    const { seen, fetcher, calls } = world();
    const result = await run(["post", "--channel", "C0DEV"], ENV, online(fetcher, "おはよう。\n今日は晴れ。\n\n"));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls(), ["chat.postMessage", "chat.getPermalink"]);
    const [post, permalink] = seen;
    assert.equal(post!.method, "POST");
    assert.equal(post!.authorization, "Bearer surrogate-work");
    assert.deepEqual(post!.form, { channel: "C0DEV", text: "おはよう。\n今日は晴れ。" });
    assert.deepEqual(permalink!.form, { channel: "C0DEV", message_ts: "1794821220.000100" });
    assert.equal(result.stdout, "message\tC0DEV\t1794821220.000100\thttps://example.slack.com/archives/C0DEV/p1794821220000100\n");
  });

  test("answers in a thread", async () => {
    const { seen, fetcher } = world();
    const result = await run(["post", "--channel", "C0DEV", "--thread", "1794821000.000200"], ENV, online(fetcher, "はい"));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(seen[0]!.form.thread_ts, "1794821000.000200");
  });

  test("finds a channel by its name among those the bot is in", async () => {
    const { seen, fetcher, calls } = world();
    const result = await run(["post", "--channel", "#dev"], ENV, online(fetcher, "hi"));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls(), ["users.conversations", "users.conversations", "chat.postMessage", "chat.getPermalink"]);
    assert.equal(seen[1]!.form.cursor, "page-2");
    assert.equal(seen[2]!.form.channel, "C0DEV");
  });

  test("posts nothing to a channel it cannot find", async () => {
    const { fetcher, calls } = world();
    const result = await run(["post", "--channel", "ops"], ENV, online(fetcher, "hi"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no channel ops/);
    assert.ok(!calls().includes("chat.postMessage"));
  });

  test("takes another workspace's token from a variable named after it", async () => {
    const { seen, fetcher } = world();
    const env = { ...ENV, SLACK_BOT_TOKEN_HOME_TWO: "surrogate-home" };
    const result = await run(["post", "--workspace", "home-two", "--channel", "C0GEN"], env, online(fetcher, "hi"));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(seen[0]!.authorization, "Bearer surrogate-home");

    const missing = await run(["post", "--workspace", "home", "--channel", "C0GEN"], ENV, online(fetcher, "hi"));
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /SLACK_BOT_TOKEN_HOME/);
    assert.equal((await run(["post", "--workspace", "Home!", "--channel", "C0GEN"], ENV, online(fetcher, "hi"))).code, 2);
    assert.equal((await run(["post", "--channel", "C0GEN"], {}, online(fetcher, "hi"))).code, 1);
  });

  test("puts the face of the avatar the backend gives as the icon", async () => {
    const { seen, fetcher, calls } = world();
    const result = await run(["post", "--channel", "C0DEV", "--face", "happy"], ENV, online(fetcher, "やった"));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls(), [`${PUBLIC}/api/agent`, "chat.postMessage", "chat.getPermalink"]);
    assert.equal(seen[0]!.authorization, undefined, "the backend's way for the faces needs no token");
    assert.equal(seen[1]!.form.icon_url, `${PUBLIC}/api/agent/icons/happy.png`);
  });

  test("posts nothing with a face the avatar does not have, or without the public URL", async () => {
    const { fetcher, calls } = world();
    const odd = await run(["post", "--channel", "C0DEV", "--face", "smug"], ENV, online(fetcher, "hi"));
    assert.equal(odd.code, 1);
    assert.match(odd.stderr, /no face smug \(faces: happy, neutral\)/);
    const nowhere = await run(["post", "--channel", "C0DEV", "--face", "happy"], { SLACK_BOT_TOKEN: "surrogate-work" }, online(fetcher, "hi"));
    assert.equal(nowhere.code, 1);
    assert.match(nowhere.stderr, /PENELOPE_PUBLIC_URL/);
    assert.ok(!calls().includes("chat.postMessage"));
  });

  test("uploads images in Slack's three steps, sending no token to where they go up", async () => {
    const { seen, fetcher, calls } = world();
    const files = { "/home/agent/a.png": PNG, "out/b.png": new Uint8Array([1, 2]) };
    const args = ["post", "--channel", "C0DEV", "--thread", "1794821000.000200", "--image", "/home/agent/a.png", "--image", "out/b.png"];
    const result = await run(args, ENV, online(fetcher, "描いた", files));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls(), [
      "chat.postMessage",
      "chat.getPermalink",
      "files.getUploadURLExternal",
      "https://files.slack.com/upload/v1/U1",
      "files.getUploadURLExternal",
      "https://files.slack.com/upload/v1/U2",
      "files.completeUploadExternal",
    ]);
    assert.deepEqual(seen[2]!.form, { filename: "a.png", length: String(PNG.length) });
    assert.equal(seen[2]!.authorization, "Bearer surrogate-work");
    assert.equal(seen[3]!.method, "POST");
    assert.equal(seen[3]!.authorization, undefined);
    assert.deepEqual([...seen[3]!.body], [...PNG]);
    const complete = seen[6]!;
    assert.equal(complete.authorization, "Bearer surrogate-work");
    assert.deepEqual(JSON.parse(complete.form.files!), [
      { id: "F0IMG1", title: "a.png" },
      { id: "F0IMG2", title: "b.png" },
    ]);
    assert.equal(complete.form.channel_id, "C0DEV");
    assert.equal(complete.form.thread_ts, "1794821000.000200");
    assert.equal(result.stdout.split("\n").slice(1).join("\n"), "file\tF0IMG1\ta.png\nfile\tF0IMG2\tb.png\n");
  });

  test("shares the images with the same face as the text", async () => {
    const { seen, fetcher } = world();
    const result = await run(["post", "--channel", "C0DEV", "--face", "happy", "--image", "a.png"], ENV, online(fetcher, "", { "a.png": PNG }));
    assert.equal(result.code, 0, result.stderr);
    const complete = seen.find((item) => item.url.endsWith("files.completeUploadExternal"));
    assert.equal(complete!.form.icon_url, `${PUBLIC}/api/agent/icons/happy.png`);
    assert.equal(complete!.form.thread_ts, undefined);
  });

  test("posts only the images when stdin is empty", async () => {
    const { fetcher, calls } = world();
    const result = await run(["post", "--channel", "C0DEV", "--image", "a.png"], ENV, online(fetcher, "\n", { "a.png": PNG }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls().filter((call) => call.startsWith("chat.")), []);
    assert.equal(result.stdout, "file\tF0IMG1\ta.png\n");
  });

  test("posts nothing when an image cannot be read", async () => {
    const { seen, fetcher } = world();
    const result = await run(["post", "--channel", "C0DEV", "--image", "gone.png"], ENV, online(fetcher, "hi"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot read gone\.png/);
    assert.equal(seen.length, 0);
  });

  test("says what Slack refused, and what it had posted before", async () => {
    const refused = world({ "chat.postMessage": { ok: false, error: "not_in_channel" } });
    const result = await run(["post", "--channel", "C0DEV"], ENV, online(refused.fetcher, "hi"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /chat\.postMessage: not_in_channel/);

    const stuck = world({ upload: 500 });
    const half = await run(["post", "--channel", "C0DEV", "--image", "a.png"], ENV, online(stuck.fetcher, "hi", { "a.png": PNG }));
    assert.equal(half.code, 1);
    assert.match(half.stdout, /^message\tC0DEV\t1794821220\.000100/);
    assert.match(half.stderr, /cannot upload a\.png \(500\)/);
    assert.ok(!stuck.calls().includes("files.completeUploadExternal"));
  });

  test("still says where it went when the permalink cannot be had", async () => {
    const { fetcher } = world({ "chat.getPermalink": { ok: false, error: "message_not_found" } });
    const result = await run(["post", "--channel", "C0DEV"], ENV, online(fetcher, "hi"));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "message\tC0DEV\t1794821220.000100\n");
  });

  test("is told what and where to post", async () => {
    const { fetcher, seen } = world();
    for (const args of [["post"], ["post", "--channel", "C0DEV", "--colour", "red"], ["post", "--channel", "C0DEV", "--thread", "yesterday"], ["post", "--channel", "C0DEV", "extra"]]) {
      const result = await run(args, ENV, online(fetcher, "hi"));
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.stderr, /usage: slackctl/);
    }
    assert.equal((await run(["post", "--channel", "C0DEV"], ENV, online(fetcher, " \n"))).code, 2, "nothing to post");
    assert.equal(seen.length, 0);
  });
});

describe("slackctl faces", () => {
  test("lists the faces with the URLs Slack is given", async () => {
    const { fetcher } = world();
    const result = await run(["faces"], ENV, online(fetcher));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `happy\t${PUBLIC}/api/agent/icons/happy.png\nneutral\t${PUBLIC}/api/agent/icons/neutral.png\n`);
  });

  test("says when the avatar has no faces", async () => {
    const { fetcher } = world({ agent: { name: "Iris" } });
    const result = await run(["faces"], ENV, online(fetcher));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no faces/);
  });
});
