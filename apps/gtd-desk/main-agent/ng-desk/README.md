# ng-desk (Antigravity and Codex plugin)

Wires Antigravity (`agy`) or Codex (`codex`) as the external main agent for a local `ng-agents` GTD workbench (`http://127.0.0.1:8790`). Both use the same skill and the same MCP server; only the manifests differ.

## Contents

- `skills/ng-desk/SKILL.md` — Main-agent triage, `/todo`, card handling, plan and document editing, sources, weekly review, model settings, and manual-server boundary instructions.
- Antigravity: `plugin.json`, `mcp_config.json`.
- Codex: `.codex-plugin/plugin.json`, `codex-mcp.json`. The marketplace entry is `.agents/plugins/marketplace.json` at the repository root.

The MCP server is `apps/gtd-desk/bin/ng-mcp.mjs` (`ng-desk-mcp` on the PATH). No credentials are needed. Set `NG_DESK_URL` if the workbench listens elsewhere; `NG_MCP_TIMEOUT_MS` changes the per-call timeout. Antigravity reads them from `mcp_config.json`, Codex passes them through from its own environment. Each run of the server names its session with its own conversation id, so the desk can tell two terminals apart.

## Install / Update

```bash
pnpm --dir apps/gtd-desk link --global
command -v ng-desk-mcp
```

Antigravity:

```bash
agy plugin validate apps/gtd-desk/main-agent/ng-desk --strict
agy plugin install apps/gtd-desk/main-agent/ng-desk
```

Codex (run in the repository root):

```bash
codex plugin marketplace add "$PWD"
codex plugin add ng-desk@ng-agents
codex mcp list   # shows ng-desk
```

Codex installs a copy under `$CODEX_HOME/plugins/cache`; after changing the kit, run `codex plugin remove ng-desk@ng-agents` and add it again (removing also drops the override below; put it back).

Interactive Codex asks before each workbench call. `codex exec` cannot ask and refuses them ("MCP tool call requires approval, but approval policy is never"). To let it call the workbench without asking, add this to `$CODEX_HOME/config.toml` (these tools act with the owner's rights, so this is the owner's choice and the plugin does not preset it):

```toml
[plugins."ng-desk@ng-agents".mcp_servers.ng-desk]
default_tools_approval_mode = "approve"
```

## Inside the workbench's own cells

The workbench's background cells run the same CLIs on the same home directory, so they may load this plugin too. They must not get the owner's control plane ([2026-11-23 audit](../../../../docs/03-bugs/audits/2026-11-23-codex-e2e-workflows.md), E01). The workbench starts every background CLI with `NG_WORKBENCH_CELL_ID=<cellId>`; when the MCP server sees it, it offers no workbench tool and makes no HTTP call: `initialize` and `tools/list` answer normally, with one inert tool, `not_available_in_workbench_cell`, whose text says the owner's control plane is not available inside a workbench cell and that the ng-desk skill does not apply there. Calling it returns the same text as an error.

The variable has to reach the server process:

- Codex gives MCP servers only a few variables of its own environment (`HOME`, `PATH`, `USER`, …) plus those listed in `env_vars`; `codex-mcp.json` lists `NG_WORKBENCH_CELL_ID` for this.
- Antigravity (`agy`) and Claude Code pass their whole environment to stdio MCP servers; `mcp_config.json` needs nothing extra.

The workbench also turns the plugin off on the Codex command line it starts its cells with; the check in the server covers any client that does not.
