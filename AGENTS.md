# AGENTS.md

Guidance for agents and people working on this repository.

## Design decisions

Design decisions are recorded as ADRs in [docs/adr/](docs/adr/). The index is [docs/adr/README.md](docs/adr/README.md).
ADRs are written in Japanese. Read the related ADRs before changing a design, and record a new decision as a new ADR.

## Design principles

- Keep the implementation and the design simple. Anything specific to one service or one source is a plugin.
- When porting code from natsumi, design the architecture first and port what fits it cleanly. Do not copy natsumi's
  structure as it is.

## Prompts (system prompt, tool descriptions, turn inputs)

- State facts and the environment; leave the how to the agent. Do not pile up instructions and prohibitions.
- The system prompt carries only: who she is (name, role, owner), where she is (the sandbox, egress through the
  Sentinel, the internal CA), how events arrive and how to answer, and the shape of `/memory`.
- Writing rules, procedures and per-event handling do not go in the prompt. What is needed goes in the owner's
  `always.md` or a skill.
- A line that must hold is enforced by the system (the Sentinel, the read-only `.git` of `/memory`), not by a sentence.
- Prompts are written in English. The language she speaks with the owner is left to `personality.md`.
- Personality, always-memory and the handoff are appended as they are (Japanese memory stays Japanese).

## Public repository

- This repository is public. Do not write key or token values, inside domain names, IP addresses in the home network
  or the cluster, or private host names.
- Refer to hosts by their role (the model API, GitHub, the VM API, the cluster API server). Use made-up values (such
  as `example.com`) in examples.
- Those values live only in the deployment repository.
