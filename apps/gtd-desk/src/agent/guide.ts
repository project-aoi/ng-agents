import { CELL_ROLES, CLI_ENGINES, runnerSelectionProperties } from "@ng/protocol";

// docs/05 principle 1 — the second entrance. An external "main agent" (Claude Code, Codex CLI, Antigravity… whatever
// the owner chats with) drives the workbench through these tools with the owner's rights (proposal 07); its own
// `agent:local` identity only records the entrance. This file is the whole of what such an agent is told —
// the server instructions and every tool's description and input schema — so it is written as carefully as a prompt:
// an agent that has never seen this system must be able to act correctly from this text alone.

export interface AgentToolDoc {
  name: string;
  description: string;
  /** JSON Schema (type "object") of the arguments. */
  inputSchema: Record<string, unknown>;
}

export const AGENT_SERVER_NAME = "ng-desk";

export const AGENT_INSTRUCTIONS = `This server is the owner's GTD workbench ("ng-agents"): a background system that keeps their work moving while they do something else. You are one of the owner's two ways in — they talk to you here, and they also talk to the workbench's own resident assistant, the desk, in its web view. Everything the owner can do in the web view you can do here: same rights, same checks. What you do is recorded as done by you (agent:local) on the owner's behalf, so act on what the owner told you — a decision the owner has not made is theirs to make: show it to them and ask.

## Who does what inside (three layers)
- **The desk** — the workbench's resident main assistant. Triage is its job: before anything new starts it looks for an existing project, parked idea or report on the same subject, decides where a thing belongs (a note, a reminder, a decision for the owner, more work for an existing project, a new project), asks what is missing, remembers the owner's standing preferences and coordinates across projects. It keeps one continuous conversation with the owner.
- **A project** answers for one deliverable ("改掉 TUI 表格复制", "Harness 对比报告"): it keeps the goal, the plan, the record of who owes what, its own notes and the shared report, and hands the real work to workers in the directory it was given. For a condition such as an MR merging, it can dispatch a checker that verifies the present state and closes after reporting.
- **A worker** does one piece of work (reading or changing code, tests, research). When its turn is over it stays dormant on its record: a message wakes it with everything it knew. Its project is told each time a turn ends and reads what the worker did.
- **Actions** are the open items of a project, owned by "agent" (a worker is on it), "human" (the owner must do something — their to-do list) or "waiting" (an outside event). **Cards** are decisions waiting for the owner (a plan to approve or a blocked worker). **Parked ("someday")** projects keep their research and cost nothing until activated.

## How to work with it
1. **What is going on?** \`workbench_overview\` first — it is cheap. \`get_project\` for one project, including what its workers did or were told that the project has not taken in yet; \`inspect_cell\` / \`get_cell\` for one cell; \`read_artifact\` and \`read_resource\` page through reports and long outputs. Status questions you answer yourself from these.
2. **The owner's words for work you can place go straight there.** A project you know → \`message_project\`. A particular worker → \`message_cell\`: a dormant one is woken on its record; one at work takes the message when its current step ends (mode "steer" interrupts it — only when it is going the wrong way). Its project gets a copy automatically.
3. **Anything new, vague, or that might duplicate existing work → \`chat_with_desk\`** with the owner's words unedited. The desk finds what exists, asks what is missing (for code: the absolute path of the repository on this machine) and puts the work in the right place. It answers in the background: read its replies with \`chat_with_desk\` and \`since\` when the owner asks or you have a reason — never in a loop. Relay its questions to the owner, and send the owner's answer with \`replyToId\` = the id of the question it answers (so it lands on the right matter even when several are open).
   When the owner has already given you everything (outcome, complete brief, the absolute path) and \`search\` shows nothing on the subject, you may \`create_project\` yourself — never a second project for the same outcome. An idea only to remember: \`create_project\` with mode "research_then_park". Omit \`runner\`, \`model\` and \`effort\` by default so the workbench's role defaults apply; pass them (including \`effort\` alone) when the owner asks for a specific runner, model or reasoning effort, and write any per-stage runner/model preferences into \`brief\` so the project dispatches each stage accordingly.
4. **Work is asynchronous.** Everything returns at once; results arrive minutes later. Tell the owner it is under way and what will happen; do not poll.
5. Read \`list_human_items\` for BOTH open human actions (owner to-dos) and pending decision cards (snoozed items are hidden until they resurface; includeSnoozed shows them). To tick off a human action or submit a card decision, call \`decide_human_item\` with the displayed \`optionId\`, \`seenItemRevision\`, and any conditional fields required by the chosen option (\`seenArtifactVersion\`, \`note\`, \`until\`, \`resumeProjectId\`, \`confirmedTargets\`, \`confirmedClosure\`). Use \`undo_human_decision\` with the activity ID to undo a reversible decision, and \`reopen_project\` to resume a closed project. For a direct question, send the answer with \`message_cell\` or \`chat_with_desk\` and its \`replyToId\`.
6. A project confirmation card is decided like any other: show the owner its plan, then submit their choice — \`system.execute\` starts the project, \`system.someday\` parks it. They want the plan changed first → \`save_plan\`; a report or draft changed → \`save_artifact\` (the whole new text, on the version you read). Every save and decision carries the version you read (\`expectedVersion\`, \`seenItemRevision\`, \`seenArtifactVersion\`); when something moved meanwhile nothing is written and the answer holds the current content: merge, and show the owner what changed before you submit again. Text a background worker wrote against an older version is kept aside with the document ("parked"): work what is still right into the text, then \`dismiss_parked\`.
7. Standing arrangements: scheduled checks → \`list_sources\`, \`create_source\`, \`manage_source\`; the week → \`get_review\` and \`resolve_review_suggestion\`; what the workbench filed away by itself → \`list_activity\`, and \`restore_activity\` when something was filed wrongly; which model runs what → \`get_models\`, \`configure_models\`; who works for whom right now → \`get_topology\`.
8. **Never do the workbench's work around it.** Nothing locks a directory: several cells may work in one repository at once, and \`list_workspaces\` shows which cells are active where right now. Before you change files yourself in such a directory, tell its project (\`message_project\`) or pause it, so nobody's work is overwritten.

## Answering the owner
- "What's on my plate?" → the overview's human actions and cards, most urgent first; then one line per active project (who has the ball).
- "How is X going?" → \`get_project\`: its one-line summary, open actions, what its cells are doing, what is new from its workers, the latest report (\`read_artifact\` for the full text).
- "Did we look into X before?" → \`search\`.
- "How was my week?" → \`get_review\`. "What did you put away today?" → \`list_activity\`.
- "What standing habits have I given you?" → \`list_preferences\`.
Give ids only when the owner needs them; talk about projects by their titles.

## Red lines (the workbench's agents follow them, and so must you when acting through it)
No force-push, no deleting or rewriting protected branches, remote branches, tags or MRs; no \`rm -rf\`, \`git reset --hard\`, \`git clean\`, \`git stash\` over work that is not yours; nothing against databases or production; nothing published or sent in bulk — unless the owner approved that specific operation. Uncommitted changes in a repository are the owner's work in progress.`;

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const num = (description: string) => ({ type: "number", description });
const oneOf = (values: readonly string[], description: string) => ({ type: "string", enum: values, description });
const EFFORT = oneOf(["15m", "45m", "low_energy"], "the kind of time it takes: 15m (a spare moment), 45m (a stretch of focus), low_energy (a chore)");

export const AGENT_TOOLS: readonly AgentToolDoc[] = [
  {
    name: "workbench_overview",
    description:
      "The whole workbench at a glance: what the owner must do themselves (open human actions), cards waiting for their decision, every project that is active or parked with who has the ball and whether it is stalled, what is running right now, which work trees cells are active in, what was filed away today, and the runner and model in use. Call this first when the owner asks about their work, and before creating anything.",
    inputSchema: obj({ includeFinished: { type: "boolean", description: "also list recently completed/cancelled projects (default false)" } }),
  },
  {
    name: "chat_with_desk",
    description:
      "Talk to the desk — the workbench's resident assistant — in the owner's words: something new to do, a vague request, a question about where something stands, or the owner's answer to a question the desk asked. The desk checks what already exists, asks for what is missing and puts the work in the right place. It answers in the background: the result tells you the cursor to read its replies with later (since), and lists the replies it has already given after `since`. Answering one of its questions: pass that question's id as replyToId.",
    inputSchema: obj({
      text: str("the owner's words, unedited (context after them only if needed). Omit to only read the desk's replies since `since`"),
      since: { type: "number", description: "read the desk's replies after this cursor (the `cursor` an earlier call returned)" },
      replyToId: str("the id of the desk's question this answers (shown with each reply)"),
      conversationId: str("a stable id of this conversation with the owner (default: your agent id), so the desk can tell your thread from the web one"),
    }),
  },
  {
    name: "capture",
    description:
      "Drop something into the desk's inbox exactly as 随手记 does (a note, a link, a reminder, or an idea to triage) for silent triage, without a conversation. Prefer chat_with_desk when the owner expects an answer or the desk may need to ask something.",
    inputSchema: obj({
      text: str("the owner's words, unedited; add context after them only if it is needed to understand them. May be omitted when attachments say it all"),
      attachments: { type: "array", items: obj({ label: str("what to call it"), uri: str("the link or path") }, ["label", "uri"]), description: "links or files that go with it" },
      voice: { type: "boolean", description: "the text is a voice transcript (it may contain mis-heard words)" },
      threads: { type: "array", items: { type: "string" }, description: "Workbench topics, e.g. ui:reviews" },
      clientId: str("optional stable id for a retried capture"),
    }),
  },
  {
    name: "create_project",
    description:
      "Start a background project for one outcome. It begins immediately: a coordinator plans the work and hands it to background workers in the given directory, and keeps going after this conversation ends. Before calling: check that no project on the same subject exists (search / workbench_overview), and make sure you have everything the work needs from the owner — for work on code, the absolute path of the repository on this machine (ask; never guess). Returns the project id.",
    inputSchema: obj(
      {
        title: str("short name the owner will recognise, in their language"),
        outcome: str("what done looks like, concretely"),
        brief: str("everything the project needs: the owner's request in their own words, constraints, links, branch conventions, how to verify, what they said about follow-up steps"),
        cwd: str("absolute path of the directory/repository the work happens in (must exist). Omit only for work that needs no local files (pure research)"),
        mode: { type: "string", enum: ["now", "research_then_park"], description: 'now (default): do it. research_then_park: an idea for later — research what it should look like, save a report, then park as "someday"' },
        phases: { type: "array", items: { type: "string" }, description: "for a large job: the stages in order. The project runs one stage at a time and asks the owner before starting the next" },
        ...runnerSelectionProperties,
      },
      ["title", "outcome", "brief"],
    ),
  },
  {
    name: "get_project",
    description:
      "One project in detail: its state and one-line summary, the directory it works in, every action (who has the ball, next step), all its cells — at work, waiting, dormant (wakeable) or archived — with what they are doing, what its workers did or were told that the project has not taken in yet (read live, including the owner's direct words to them), its own notes (the project's whiteboard), the background commands running for it, its reports (artifact ids and titles), pending cards, and whether it is stalled.",
    inputSchema: obj({ id: str("project id from workbench_overview / create_project") }, ["id"]),
  },
  {
    name: "message_project",
    description:
      'Give a running (or parked) project a new instruction from the owner: a follow-up step ("用 /ship-mr 提 MR"), an addition ("补一个录屏"), a correction or a change of direction. The project reads it at its next turn and either wakes the dormant worker that already knows the work or dispatches a new one; with urgent it is interrupted now. If the project has already finished, you are told so — use reopen_project to continue the original project when the owner asks to resume it.',
    inputSchema: obj(
      { id: str("project id"), text: str("the owner's instruction, in their words, with any context needed to act on it"), urgent: { type: "boolean", description: "interrupt what it is doing (only when it is going the wrong way)" } },
      ["id", "text"],
    ),
  },
  {
    name: "set_project_state",
    description:
      'Change a project\'s state on the owner\'s behalf. pause / resume: stop and continue background work. someday: park it (everything is kept, nothing runs). activate: bring a parked project back and start it (a parked project is brought back with activate, not resume). complete: the owner says it is done. cancel: the owner no longer wants it (its workers are stopped; files and branches are left as they are).',
    inputSchema: obj({ id: str("project id"), state: { type: "string", enum: ["pause", "resume", "someday", "activate", "complete", "cancel"] }, note: str("why, in the owner's words (shown to the project when it is activated)") }, ["id", "state"]),
  },
  {
    name: "add_action",
    description: 'Add an open item to a project: something the owner will do themselves ("human" — it appears on their to-do list; give a concrete next step) or something to wait for ("waiting").',
    inputSchema: obj(
      { projectId: str("project id"), title: str("what it is"), owner: { type: "string", enum: ["human", "waiting"] }, nextStep: str("the concrete next physical step — give one for human, so the owner knows what to do"), effort: EFFORT },
      ["projectId", "title", "owner"],
    ),
  },
  {
    name: "list_human_items",
    description:
      'List every active item waiting on the owner in 待我处理 — BOTH open human actions (owner to-dos, completed via decide_human_item using their "done" option) and pending decision cards — together with their options, itemRevision, artifactVersion, the plan of a project confirmation card (proposal), resumeTarget and closeTargets (what each closing option would close, by option id). Snoozed items are omitted until they resurface, unless includeSnoozed.',
    inputSchema: obj({ includeSnoozed: { type: "boolean", description: "also list items put off until later (default false)" } }),
  },
  {
    name: "decide_human_item",
    description:
      "Complete an open human action or submit a decision on a pending card using the exact option and versions returned by list_human_items. Every option shown is available to you, project confirmation included (system.execute starts the project, system.someday parks it as an idea for later): submit the one the owner chose.",
    inputSchema: obj({
      id: str("human item id from list_human_items"),
      optionId: str('chosen option id from item.options (e.g. "done" to tick off a human action)'),
      seenItemRevision: { type: "number", description: "exact itemRevision returned by list_human_items (optimistic concurrency lock)" },
      seenArtifactVersion: { type: "number", description: "required when item.artifactVersion is non-null: the exact draft version reviewed" },
      until: { type: "number", description: 'for effect "defer" options: Unix timestamp in milliseconds to resurface the item (default: +24h)' },
      note: str('reply text, revision instructions, or completion context (required when option.input.mode is "required")'),
      resumeProjectId: str("required when the item carries resumeTarget: pass resumeTarget.id to confirm resuming that paused project or cell"),
      confirmedTargets: { type: "array", items: { type: "string" }, description: 'required when the chosen option has terminateMode "cancel_task": pass [targetCellId] matching option.targetCellIds' },
      confirmedClosure: { type: "array", items: { type: "string" }, description: "required when item.closeTargets[optionId] is non-empty: pass all its ids in the exact order shown" },
    }, ["id", "optionId", "seenItemRevision"]),
  },
  {
    name: "reopen_project",
    description: "Reopen a completed or cancelled project in its original session (restoring its wakeable workers and cancelled actions).",
    inputSchema: obj({ projectId: str("project id") }, ["projectId"]),
  },
  {
    name: "undo_human_decision",
    description: "Undo a recent reversible decision by its activityId (restores the item if unread, or sends a correction to the background cell if already claimed).",
    inputSchema: obj({ activityId: str("activity id returned by decide_human_item") }, ["activityId"]),
  },
  {
    name: "read_artifact",
    description:
      "Read a report, draft or plan saved by the workbench (artifact id from get_project or search): the current version, or an older one, with its version history, the passages marked for the owner to decide, and the background additions kept aside (parked) because someone edited it meanwhile. Long ones come a page at a time — the result says where the next page starts.",
    inputSchema: obj(
      {
        id: str("artifact id"),
        version: { type: "number", description: "an older version (default: the current one)" },
        parkedId: str("read this parked addition in full instead of the document"),
        offset: { type: "number", description: "first character to return (default 0)" },
        limit: { type: "number", description: "characters to return (default 16000, at most 64000)" },
      },
      ["id"],
    ),
  },
  {
    name: "read_resource",
    description:
      "Read a long output the workbench stored separately (a res://… link in a cell's record or in get_cell / inspect_cell output), a page at a time.",
    inputSchema: obj(
      {
        uri: str("the res://… link"),
        offset: { type: "number", description: "first character (default 0)" },
        limit: { type: "number", description: "characters to return (default 8000, at most 64000)" },
      },
      ["uri"],
    ),
  },
  {
    name: "search",
    description:
      "Full-text search (Chinese and English) over everything the workbench has: every project's records and reports, what its agents said and did (including long tool outputs), notes and saved preferences. Use it to find out whether something was already looked into, where a past result is, or how something was done before.",
    inputSchema: obj({ query: str("words to look for"), limit: { type: "number", description: "max hits (default 12)" } }, ["query"]),
  },
  {
    name: "save_preference",
    description:
      'Record how the owner wants a kind of thing done, so every background agent follows it from now on without being told again ("改完代码后直接用 /ship-mr 提 MR", "报告先写结论"). Say when it applies and what to do. Same name replaces the earlier text. A rule that only makes sense in one repository or for one kind of agent (e.g. a Rust repository\'s commit checks) should name that directory (cwdPrefix) and/or roles; leave both out for how the owner wants things done everywhere.',
    inputSchema: obj(
      {
        name: str("short slug, e.g. code-change-followup"),
        text: str("when it applies and what to do"),
        cwdPrefix: str("only agents working in this directory or below it see the rule: its absolute path on this machine. Saving again under the same name without it lifts the limit"),
        roles: {
          type: "array",
          items: { type: "string" },
          description: 'only agents of these roles see the rule: "worker" (does the hands-on work in a repository), "project" (coordinates a project), "checker" (one check), "desk", "hub", "sensor". Saving again under the same name without it lifts the limit',
        },
      },
      ["name", "text"],
    ),
  },
  {
    name: "list_preferences",
    description:
      "Everything the owner has asked to be done a certain way from now on (saved preferences), with the playbooks (skills) the workbench's agents follow. Use it when the owner asks what they have told you before, and before saving a preference — refine an existing one under its name instead of adding a near-duplicate.",
    inputSchema: obj({}),
  },
  {
    name: "list_workspaces",
    description:
      "Which work trees on this machine the workbench's cells are active in right now, and who is in each (nothing is locked: several cells may work in one repository at once). Check it before you touch a repository yourself.",
    inputSchema: obj({}),
  },
  {
    name: "get_cell",
    description:
      "Low-level: one background cell (a project, worker, checker, sensor, hub or the desk) — its state (at work, waiting, dormant and wakeable, paused, archived), directory and branch, what it waits for, its notes, its running commands, a question it has asked the owner, and the tail of what it did. Use it to see why something is stuck when get_project is not enough; inspect_cell reads a longer stretch.",
    inputSchema: obj({ id: str("cell id"), tail: { type: "number", description: "how many recent records to include (default 12)" } }, ["id"]),
  },
  {
    name: "message_cell",
    description:
      "Pass the owner's words to one cell directly — a worker of a project, a project, a hub. A dormant worker is woken on its record (no new cell); one at work takes the message when its current step ends, or with mode \"steer\" is interrupted with it now (only when it is going the wrong way). A worker's project is given a copy of what was said (in the background, or woken with notifyParent \"wakeup\"). A worker closed under a project that is still open is brought back; one archived with a finished project, and script probes, take no messages — you are told why.",
    inputSchema: obj(
      {
        id: str("cell id (from get_project, workbench_overview or get_cell)"),
        text: str("the owner's words, with any context needed to act on them"),
        mode: { type: "string", enum: ["enqueue", "steer"], description: "enqueue (default): taken when its current step ends, or wakes it. steer: interrupt it now" },
        notifyParent: { type: "string", enum: ["silent", "wakeup"], description: "silent (default): its project reads the copy at its next wake-up. wakeup: wake the project now too" },
        replyToId: str("the id of the cell's question this answers"),
        conversationId: str("a stable id of this conversation with the owner (default: your agent id)"),
      },
      ["id", "text"],
    ),
  },
  {
    name: "inspect_cell",
    description:
      "What one cell was told and did, step by step, from a point on: the messages it received (the owner's direct words marked), what it said, the files it changed and the commands it ran, the reports it touched — the same account whichever engine runs it. Reads nothing into anybody's progress: the cell's project still sees the stretch as new.",
    inputSchema: obj(
      {
        id: str("cell id"),
        afterSeq: { type: "number", description: "start after this record number (default: from the beginning); the result says where it stopped" },
        detail: { type: "string", enum: ["summary", "full"], description: "summary (default): one line per step. full: tool inputs and outputs as recorded" },
      },
      ["id"],
    ),
  },
  {
    name: "spawn_cell",
    description:
      'Low-level: start a background cell directly. Prefer chat_with_desk or create_project — a bare worker has nobody keeping its results. Useful for a one-off look ("read this repository and tell me X") whose result you will fetch yourself: preset "worker" does the job and then stays dormant (inspect_cell / get_cell read what it did; message_cell asks it more). parentId defaults to the desk. (A hub — a router for a stream of direct messages — needs routing rules: ask the desk for one with chat_with_desk instead.)',
    inputSchema: obj(
      {
        preset: { type: "string", description: 'a registered preset: "worker" (one piece of work; stays dormant afterwards, wakes on a message), "checker" (checks one outside condition), "project" (persistent coordinator), "hub", "sensor"' },
        title: str("short name"),
        instruction: str("the complete task: goal, materials, how to verify, what to report"),
        cwd: str("absolute path of the directory it works in"),
        parentId: str("cell to attach it to (default: the desk)"),
        ...runnerSelectionProperties,
      },
      ["preset", "title", "instruction"],
    ),
  },
  {
    name: "control_cell",
    description: "Low-level: pause, resume or cancel one background cell (cancel stops it and everything below it; files and branches stay), or trigger a script probe's check now. message / steer are the same as message_cell. A scheduled source is deleted with manage_source, not cancelled here.",
    inputSchema: obj(
      { id: str("cell id"), action: { type: "string", enum: ["message", "steer", "pause", "resume", "cancel", "trigger"] }, text: str("for message / steer") },
      ["id", "action"],
    ),
  },

  // ---------- documents and plans ----------
  {
    name: "save_artifact",
    description:
      "Save a new version of a report or draft on the owner's instruction (they dictated a change, or asked you to revise it). Pass the complete new text and the version you read it at. If it has moved on since, nothing is written: the answer holds the current text to merge your change into. What you save counts as the owner's edit — a background worker that was still editing the older version has its text kept aside instead of overwriting yours.",
    inputSchema: obj(
      {
        id: str("artifact id"),
        expectedVersion: num("the version you read (read_artifact currentVersion) and changed"),
        body: str("the complete new text, not a diff", { minLength: 0 }),
        title: str("a new title (default: keep it)"),
        format: oneOf(["text", "markdown", "json"], "default: keep it"),
        data: { type: "object", description: "for a json document: its value, when you have it as an object (default: parsed from body)" },
      },
      ["id", "expectedVersion", "body"],
    ),
  },
  {
    name: "dismiss_parked",
    description: "Remove one parked addition of a document (listed by read_artifact) once what is useful in it has been merged, or the owner does not want it.",
    inputSchema: obj({ artifactId: str("artifact id"), parkedId: str("id of the parked addition") }, ["artifactId", "parkedId"]),
  },
  {
    name: "save_plan",
    description:
      "Change the plan on a pending project confirmation card before it is approved: title, goal, background, the steps and who does them, which runner does the work. Pass the complete list of steps (it replaces the old one) and the draft version you read (item.artifactVersion). The directory and stages stay as proposed. If the plan has moved on since, nothing is written and the answer holds the current one. Approve it afterwards with decide_human_item, on the new itemRevision and artifactVersion.",
    inputSchema: obj(
      {
        id: str("id of the project confirmation card, from list_human_items"),
        expectedVersion: num("item.artifactVersion as you read it"),
        title: str("project title (default: keep it)"),
        outcome: str("what done looks like, concretely"),
        background: str("context and constraints (default: keep it)", { minLength: 0 }),
        runnerOverride: {
          type: ["object", "null"],
          properties: { engine: oneOf(CLI_ENGINES, "runner"), model: str("model id from get_models (required with effort)"), effort: str("reasoning effort the model offers") },
          required: ["engine"],
          additionalProperties: false,
          description: "run this project on a specific runner. null: back to the workbench's default. Omit to keep what the plan says",
        },
        actions: {
          type: "array",
          items: obj(
            {
              title: str("the step"),
              owner: oneOf(["human", "agent", "waiting"], "who does it: the owner, a background worker, or an outside event to wait for"),
              effort: EFFORT,
              nextStep: str("the concrete next step"),
            },
            ["title", "owner"],
          ),
          description: "all the steps, in order",
        },
      },
      ["id", "expectedVersion", "outcome", "actions"],
    ),
  },
  // ---------- scheduled sources ----------
  {
    name: "list_sources",
    description:
      "The workbench's sources — the checks that run on a schedule or on a condition and report what they find: how often each runs, how it checks, whether its hits reach the inbox or only become notes, how often it ran and hit, and its last error.",
    inputSchema: obj({}),
  },
  {
    name: "create_source",
    description:
      "Add a scheduled check. Give when it runs (cron, or everyMinutes) and how it checks: a script on this machine (no model cost — best when the check is fixed), a registered check by name, or instructions a model follows each time.",
    inputSchema: obj(
      {
        title: str("short name the owner will recognise"),
        description: str("what it is for"),
        cron: str("5-field cron expression, e.g. \"0 9 * * 1\" (this or everyMinutes)"),
        tz: str("time zone of the cron expression, e.g. Asia/Shanghai (default: the workbench's)"),
        everyMinutes: num("interval in minutes: under 60, or whole hours up to a day (this or cron)"),
        checkKind: oneOf(["script", "code", "llm"], "script: run scriptPath. code: a registered check, codeEntry. llm: a model follows instruction"),
        scriptPath: str("for script: path of the script"),
        codeEntry: str("for code: name of the registered check"),
        instruction: str("for llm: what to check and what counts as a hit"),
        mode: oneOf(["active", "observe"], "active (default): hits are posted to the inbox. observe: only notes are kept"),
      },
      ["title", "checkKind"],
    ),
  },
  {
    name: "manage_source",
    description: "Pause, resume or delete a source, or change whether its hits are posted to the inbox (active) or only kept as notes (observe). Deleting ends it for good: only when the owner asked for it.",
    inputSchema: obj(
      {
        sensorId: str("source id from list_sources"),
        action: { type: "string", enum: ["pause", "resume", "set_mode", "delete"] },
        mode: oneOf(["active", "observe"], "for set_mode"),
      },
      ["sensorId", "action"],
    ),
  },
  // ---------- weekly review ----------
  {
    name: "get_review",
    description:
      "The weekly review: what was finished this week, waits that are overdue, how many drafts the owner edited before approving, playbooks (skills) the workbench suggests saving, and sources that could run as a script instead of a model.",
    inputSchema: obj({}),
  },
  {
    name: "resolve_review_suggestion",
    description:
      "Act on a suggestion of the weekly review: save a suggested playbook so every background agent follows it (accept_skill), drop it (dismiss_skill), or make a source run a script or registered check instead of a model (sensor_to_code).",
    inputSchema: obj(
      {
        action: { type: "string", enum: ["accept_skill", "dismiss_skill", "sensor_to_code"] },
        name: str("for accept_skill / dismiss_skill: the suggestion's name"),
        sensorId: str("for sensor_to_code: source id"),
        entry: str('for sensor_to_code: "script:<path>" or the name of a registered check (default: the one the review prepared, when it has one)'),
      },
      ["action"],
    ),
  },
  // ---------- what was filed away ----------
  {
    name: "list_activity",
    description:
      "What the workbench did by itself or closed recently: notifications it archived, notes it saved, reminders it set, cards that were withdrawn, things that were completed — newest first, with how many there are of each kind and which can be taken back.",
    inputSchema: obj({ kind: oneOf(["notification_archived", "note_saved", "reminder_set", "card_withdrawn", "action_completed"], "only this kind") }),
  },
  {
    name: "restore_activity",
    description: "Hand something the workbench filed away back to the desk, which triages it again (the owner says it should not have been archived). A decision is taken back with undo_human_decision instead; list_activity says which one applies.",
    inputSchema: obj({ cellId: str("cellId of the entry"), activityId: str("id of the entry") }, ["cellId", "activityId"]),
  },
  // ---------- runners and models ----------
  {
    name: "get_models",
    description: "Which agent CLIs (runners) are enabled, the models and reasoning efforts each offers, what is selected for the strong and fast tiers and for each role, and what the next run of each will really use.",
    inputSchema: obj({ refresh: { type: "boolean", description: "ask the CLIs again instead of using the remembered lists (slower; default false)" } }),
  },
  {
    name: "configure_models",
    description:
      "Change what background agents run on, when the owner asks for it. target runner: the default runner. target tier: the default runner's model for the strong tier (desk, projects, workers, hubs) or the fast one (checkers, sources) — mode auto follows the CLI's own choice, fixed pins model and effort. target role: one role's own runner and model — mode inherit follows the defaults, custom pins runner, model and effort. Takes effect from the next run. Model ids and efforts come from get_models.",
    inputSchema: obj(
      {
        target: { type: "string", enum: ["runner", "tier", "role"] },
        runner: oneOf(CLI_ENGINES, "for target runner, and for target role with mode custom"),
        tier: oneOf(["strong", "fast"], "for target tier"),
        engine: oneOf(CLI_ENGINES, "for target tier: the runner you believe is the default; refused if it has changed"),
        role: oneOf(CELL_ROLES, "for target role"),
        mode: oneOf(["auto", "fixed", "inherit", "custom"], "for target tier: auto or fixed. For target role: inherit or custom"),
        model: str("model id (required for fixed)"),
        effort: str("reasoning effort the model offers"),
      },
      ["target"],
    ),
  },
  // ---------- who works for whom ----------
  {
    name: "get_topology",
    description:
      "How the background agents are connected: every cell with its role, state, parent, project, directory, runner and model, who waits for whom, which work trees several cells share, and how many records of each worker its project has not taken in yet.",
    inputSchema: obj({ includeArchived: { type: "boolean", description: "also list closed cells (default false)" }, projectId: str("only this project's part") }),
  },
];
