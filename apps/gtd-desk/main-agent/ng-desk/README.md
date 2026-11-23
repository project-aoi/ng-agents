# ng-desk (Antigravity Plugin)

Antigravity (`agy`) native plugin that wires Antigravity as the external main agent for a local `ng-agents` GTD workbench (`http://127.0.0.1:8790`).

## Contents

- `mcp_config.json` — Stdio MCP server pointing to `apps/gtd-desk/bin/ng-mcp.mjs`. Set `NG_DESK_URL` there if the workbench listens elsewhere (`NG_MCP_TIMEOUT_MS` changes the per-call timeout); no credentials are needed.
- `skills/ng-desk/SKILL.md` — Main-agent triage, `/todo`, card handling, plan and document editing, sources, weekly review, model settings, and manual-server boundary instructions.

## Install / Update

```bash
pnpm --dir apps/gtd-desk link --global
command -v ng-desk-mcp
agy plugin validate apps/gtd-desk/main-agent/ng-desk --strict
agy plugin install apps/gtd-desk/main-agent/ng-desk
```
