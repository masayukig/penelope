---
name: agents
description: Other agents to ask over A2A.
hosts:
  - helper.agents.example.com
a2a:
  - name: helper
    label: Helper
    url: https://helper.agents.example.com/
    token: HELPER_AGENT_TOKEN
---

| Agent | URL | Token |
| --- | --- | --- |
| helper | `https://helper.agents.example.com/` | `HELPER_AGENT_TOKEN` |

Use `ask-agent helper` in `job_start`. If using `a2a` directly, pass the URL from the table to `-a` as written. It is the agent's host root; `a2a send` uses the endpoint advertised in its Agent Card.

The token is a surrogate; the Sentinel replaces it with her ServiceAccount's token.
