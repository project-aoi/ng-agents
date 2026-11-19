# ng-desk (Antigravity Plugin)

Antigravity (`agy`) native plugin that wires Antigravity as the external main agent for a local `ng-agents` GTD workbench (`http://127.0.0.1:8790`).

## Contents

- `mcp_config.json` — Stdio MCP server pointing to `apps/gtd-desk/bin/ng-mcp.mjs`.
- `skills/ng-desk/SKILL.md` — Main-agent triage, `/todo`, card handling, and manual-server boundary instructions.

## Install / Update

```bash
agy plugin validate apps/gtd-desk/main-agent/ng-desk --strict
agy plugin install apps/gtd-desk/main-agent/ng-desk
```
