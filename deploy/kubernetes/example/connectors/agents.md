---
name: agents
description: Other agents to ask over A2A.
hosts:
  - helper.agents.example.com
---

| Agent | URL | Token |
| --- | --- | --- |
| helper | `https://helper.agents.example.com/` | `HELPER_AGENT_TOKEN` |

Pass the URL from the table to `-a` as written. It is the agent's host root; `a2a send` uses the endpoint advertised in its Agent Card.

The token is a surrogate; the Sentinel replaces it with her ServiceAccount's token.
