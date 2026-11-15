// What she is doing now: her state, and the turn under way block by block
// as each closes (docs/design/README.md, 5 "今の様子").
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useState } from "react";

import type { Activity } from "@penelope/contract";

import { argumentsText, type FlowItem, type Status } from "../model/store.ts";
import { useAgent } from "./agent.tsx";
import { Dots } from "./Timeline.tsx";
import { statusWord, timeOf, words } from "./words.ts";

const DOT = { offline: "warning", waiting: "neutral", thinking: "accent", tool: "accent" } as const;

/** The state as a dot and its word: never the color alone. */
export function StatusLabel({ status, large = false }: { status: Status; large?: boolean }) {
  const word = statusWord(status);
  return (
    <span className={large ? "status status-large" : "status"} data-status={status.kind}>
      <StatusDot variant={DOT[status.kind]} label={word} isPulsing={status.kind === "thinking" || status.kind === "tool"} />
      <span>{word}</span>
    </span>
  );
}

export function Now({ status, flow }: { status: Status; flow: FlowItem[] }) {
  const agent = useAgent();
  const working = status.kind === "thinking" || status.kind === "tool";
  return (
    <section className="now" aria-label={`${agent.name}（${words.main}）`}>
      <div className="now-head">
        <StatusLabel status={status} large />
        <span className="now-agent">
          {agent.name}（{words.main}）
        </span>
      </div>
      {!working ? (
        <p className="muted">{words.idle}</p>
      ) : (
        <ol className="flow">
          {flow.map((item, index) => (
            <FlowLine key={index} item={item} all={flow} />
          ))}
          <li className="flow-block">
            <span className="flow-label">{words.writing}</span>
            <Dots label={words.writingDots} />
          </li>
        </ol>
      )}
    </section>
  );
}

/** One block of a turn. A tool's result is shown under its call, so it takes the whole flow. */
export function FlowLine({ item, all }: { item: FlowItem; all: readonly FlowItem[] }) {
  switch (item.kind) {
    case "turn_start":
      return (
        <li className="flow-divider">
          <span>
            {words.turnStart} {timeOf(item.at)}
          </span>
        </li>
      );
    case "thinking":
      return (
        <li className="flow-block">
          <span className="flow-label">{words.thought}</span>
          <Folded text={item.text} />
        </li>
      );
    case "message":
      return (
        <li className="flow-block">
          <span className="flow-label">{words.message}</span>
          <Folded text={item.text} />
        </li>
      );
    case "tool_call": {
      const result = all.find((other): other is Extract<Activity, { kind: "tool_result" }> => other.kind === "tool_result" && other.call_id === item.call_id);
      return (
        <li className="flow-block">
          <span className="flow-tool">
            <span className="flow-label">{words.tool}</span>
            <Code>
              <strong>{item.name}</strong>: {argumentsText(item.arguments)}
            </Code>
          </span>
          {result ? (
            <Collapsible defaultIsOpen={false} chevronPosition="start" trigger={<span className="flow-label">{result.is_error ? words.resultError : words.result}</span>}>
              <CodeBlock code={result.output} maxHeight={220} width="100%" isWrapped size="sm" hasLanguageLabel={false} />
            </Collapsible>
          ) : null}
        </li>
      );
    }
    case "interrupt":
      return (
        <li className="flow-interrupt">
          <span className="flow-label">
            {words.interrupt} {timeOf(item.at)} ・ {words.ownerMessage}
          </span>
          <span>{item.text}</span>
        </li>
      );
    case "tool_result":
    case "turn_end":
      // A result is shown under its call; the end closes the turn.
      return null;
  }
}

/** A long text folded to two lines until it is opened. */
function Folded({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className={open ? "folded open" : "folded"}>{text}</p>
      <Button label={open ? words.thoughtClose : words.thoughtOpen} variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} />
    </>
  );
}
