// The login: her face and name, and the way to GitHub (ADR-0010).
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";

import { AgentAvatar, useAgent } from "./agent.tsx";
import { words } from "./words.ts";

export function Login() {
  const agent = useAgent();
  return (
    <Center minHeight="100dvh" padding={6}>
      <div className="login">
        <AgentAvatar size={96} />
        <h1>{agent.name}</h1>
        <Button label={words.login} variant="primary" size="lg" href="/auth/github/start" />
        <p className="muted">{words.loginNote}</p>
      </div>
    </Center>
  );
}
