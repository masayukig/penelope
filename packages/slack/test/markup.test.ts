import assert from "node:assert/strict";
import { test } from "node:test";

import { plainText } from "../src/markup.ts";

test("names stand in for the IDs of people and channels", () => {
  assert.equal(plainText("hi <@U0BOB> and <@U0X>, see <#C0DEV> or <#C0OPS|ops>", { U0BOB: "bob", C0DEV: "dev" }), "hi @bob and @U0X, see #dev or #ops");
});

test("special mentions, groups and dates read as text", () => {
  assert.equal(plainText("<!here> <!channel> <!subteam^S0ONE|@oncall> <!date^1794819600^{date}|Nov 16>", {}), "@here @channel @oncall Nov 16");
});

test("links keep their address, and the escaped characters come back", () => {
  assert.equal(
    plainText("<https://example.com/a|the doc> and <https://example.com/b> <mailto:a@example.com|a@example.com> 1 &lt; 2 &amp;&amp; 3 &gt; 2", {}),
    "the doc (https://example.com/a) and https://example.com/b a@example.com 1 < 2 && 3 > 2",
  );
});
