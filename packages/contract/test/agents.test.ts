import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSubAgentName, SUB_AGENT_NAME } from "../src/index.ts";

describe("a sub-agent's name", () => {
  it("is lower-case letters, digits and '-', starting with a letter or a digit", () => {
    for (const name of ["a", "0", "review-pr-22", "x1-y2", "9lives", "a-", "a--b", "a".repeat(63)]) {
      assert.equal(isSubAgentName(name), true, name);
      assert.equal(SUB_AGENT_NAME.test(name), true, name);
    }
  });

  it("is not main, nor anything else", () => {
    for (const name of ["main", "", "-a", "A", "Review", "a_b", "a.b", "a/b", "../a", "a b", "é", "a".repeat(64), "main\n"]) {
      assert.equal(isSubAgentName(name), false, JSON.stringify(name));
    }
  });

  it("is a string", () => {
    for (const value of [undefined, null, 1, ["a"], { agent: "a" }]) assert.equal(isSubAgentName(value), false, String(value));
  });
});
