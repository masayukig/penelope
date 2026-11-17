---
name: slack
description: Slack, as the bot of the workspace work. Messages arrive as events; slackctl reads and posts.
hosts:
  - slack.com
---

- Workspace: `work`. Its streams start with `work.`.
- `SLACK_BOT_TOKEN` holds a surrogate of the bot's token; the Sentinel replaces it on `slack.com` only.
- The bot posts only in channels the owner has invited it to.
