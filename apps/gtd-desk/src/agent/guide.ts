import { CELL_ROLES, CLI_ENGINES, runnerSelectionProperties } from "@ng/protocol";
import { IMAGE_TYPES, MAX_IMAGE_EDGE, MAX_SAVED_IMAGE_BYTES } from "../shared/capture-assets";

// docs/05 principle 1 — the second entrance. An external "main agent" (Claude Code, Codex CLI, Antigravity… whatever
// the owner chats with) drives the workbench through these tools with the owner's rights (proposal 07); its own
// `agent:local` identity only records the entrance. The server instructions and every tool's description and input
// schema are written as carefully as a prompt. Some clients repeat the server instructions next to every tool, so
// they hold only what must be true even without the ng-desk skill; how to work with the workbench lives in the skill
// (main-agent/ng-desk/skills/ng-desk/SKILL.md).

export interface AgentToolDoc {
  name: string;
  description: string;
  /** JSON Schema (type "object") of the arguments. */
  inputSchema: Record<string, unknown>;
}

export const AGENT_SERVER_NAME = "ng-desk";

export const AGENT_INSTRUCTIONS = `The owner's ng-agents GTD workbench (a resident desk, projects, background workers), driven with the owner's rights. Load the ng-desk skill first: it says how, and names each tool — look tools up by name, do not dump the whole list.
1. You relay; the owner decides: put the workbench's questions to them, never answer, approve, restart or choose for them.
2. \`text\` is only what the owner said; your own additions go in \`context\`.
3. Work is asynchronous: hand it over, say who has it, do not poll or do it yourself.`;

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const num = (description: string) => ({ type: "number", description });
const oneOf = (values: readonly string[], description: string) => ({ type: "string", enum: values, description });
const EFFORT = oneOf(["15m", "45m", "low_energy"], "the kind of time it takes: 15m (a spare moment), 45m (a stretch of focus), low_energy (a chore)");

/** The owner's words and what the agent adds, kept apart on every tool that passes words on (audit E02). */
const OWNER_TEXT = (what: string) =>
  str(`${what}: only what the owner said or wrote, verbatim or faithfully quoted — never your own addition`);
const CONTEXT = str(
  "what you add yourself, if anything: background you looked up, your reading of the situation. The receiver sees it separately, marked as not the owner's words",
);
const CONVERSATION = str("this conversation with the owner (default: the id the ng-desk MCP server gives this session, else your agent id); omit it");

export const AGENT_TOOLS: readonly AgentToolDoc[] = [
  {
    name: "workbench_overview",
    description:
      "The whole workbench at a glance: its address, what waits on the owner (to-dos, cards, questions the desk or a cell is asking them), reminders not yet due, active and parked projects with who has the ball (or who parked it, when, in what words), hubs and the desk's own workers with their latest results, work trees in use, what was filed away today. Call it first when the owner asks about their work, and before creating anything.",
    inputSchema: obj({ includeFinished: { type: "boolean", description: "also list recently completed/cancelled projects (default false)" } }),
  },
  {
    name: "chat_with_desk",
    description:
      "Talk to the desk, the workbench's resident assistant: something new or vague, a question about where something stands, or the owner's answer to a question the desk asked (replyToId). The desk checks what already exists, asks what is missing and puts the work in the right place. It answers in the background: waitSeconds waits a little for its reply to this message; `since` reads its replies after a cursor. A reply marked as a question is for the owner.",
    inputSchema: obj({
      text: OWNER_TEXT("the owner's words (omit to only read the desk's replies)"),
      context: CONTEXT,
      since: { type: "number", description: "read the desk's replies after this cursor (the `cursor` an earlier call returned)" },
      waitSeconds: { type: "number", description: "with text: wait up to this many seconds (at most 30, default 0) for the desk's reply to it" },
      replyToId: str("the id of the desk's question the owner's words answer"),
      conversationId: CONVERSATION,
    }),
  },
  {
    name: "capture",
    description:
      "Drop something into the workbench as 随手记 does (a note, a link, a reminder, an idea) for silent triage, without a conversation — or onto a topic (threads) that a hub or source watches: the owner's \"记到 ui:reviews：…\". Prefer chat_with_desk when the owner expects an answer or the desk may need to ask something.",
    inputSchema: obj({
      text: str("the owner's words, unedited. May be omitted when attachments say it all"),
      attachments: { type: "array", items: obj({ label: str("what to call it"), uri: str("the link or path") }, ["label", "uri"]), description: "links or files that go with it" },
      voice: { type: "boolean", description: "the text is a voice transcript (it may contain mis-heard words)" },
      threads: { type: "array", items: { type: "string" }, description: "the topic(s) it is for, e.g. [\"ui:reviews\"] (workbench_overview shows which each hub watches). Omit for the desk's own inbox" },
      clientId: str("optional stable id for a retried capture"),
    }),
  },
  {
    name: "save_capture_image",
    description:
      "Save one already converted capture image in the workbench's own asset store. PNG/JPEG/WebP/GIF only, at most 180 KiB and 2048 pixels per edge. Use the returned label/uri in capture.attachments; do not embed the image bytes in the note. This stores an attachment and does not inject image input into the desk or a worker.",
    inputSchema: obj({
      dataBase64: str("strict base64 of the converted image bytes", { maxLength: Math.ceil(MAX_SAVED_IMAGE_BYTES / 3) * 4 }),
      contentType: oneOf(IMAGE_TYPES, "the actual encoded image format"),
      width: { type: "number", multipleOf: 1, minimum: 1, maximum: MAX_IMAGE_EDGE, description: "actual encoded integer width" },
      height: { type: "number", multipleOf: 1, minimum: 1, maximum: MAX_IMAGE_EDGE, description: "actual encoded integer height" },
      label: str("original filename or a short label, without path separators", { minLength: 1, maxLength: 160 }),
    }, ["dataBase64", "contentType", "width", "height", "label"]),
  },
  {
    name: "read_capture_image",
    description:
      "Read one saved capture image as bounded base64 and its format, dimensions and byte count. assetId is the final hash segment of a capture attachment URI; arbitrary paths are rejected. The returned text data is not automatically delivered as image input to the desk or a worker.",
    inputSchema: obj({
      assetId: str("64 lowercase hexadecimal characters from the saved image URI", { minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
    }, ["assetId"]),
  },
  {
    name: "create_project",
    description:
      "Start a background project for one outcome. It begins immediately: a coordinator plans the work and hands it to background workers in the given directory, and keeps going after this conversation ends. Before calling: check that no project on the same subject exists (search / workbench_overview), and have everything the work needs from the owner — for code, the absolute path of the repository on this machine (ask; never guess).",
    inputSchema: obj(
      {
        title: str("short name the owner will recognise, in their language"),
        outcome: str("what done looks like, concretely"),
        brief: str(
          "what the owner asked for, in their own words (「…」), plus the facts the work needs (links, paths, follow-up steps they named). Nothing of your own in here: the project reads it as the request",
        ),
        context: CONTEXT,
        cwd: str("absolute path of the directory/repository the work happens in (must exist). Omit only for work that needs no local files"),
        mode: { type: "string", enum: ["now", "research_then_park"], description: 'now (default): do it. research_then_park: an idea for later — research it, save a report, then park as "someday"' },
        phases: { type: "array", items: { type: "string" }, description: "only when the owner wants to look at each stage before the next one starts: the stages in order. Omit otherwise" },
        ...runnerSelectionProperties,
      },
      ["title", "outcome", "brief"],
    ),
  },
  {
    name: "get_project",
    description:
      "One project in detail: state and summary, directory, every action (who has the ball, next step), all its cells with what they are doing, what its workers did or were told that the project has not taken in yet (the owner's direct words included), its notes, running commands, the notices it sent the owner lately, reports (artifact ids), pending cards, and whether it is stalled.",
    inputSchema: obj({ id: str("project id from workbench_overview / create_project") }, ["id"]),
  },
  {
    name: "message_project",
    description:
      'Pass the owner\'s words to a running (or parked) project: a follow-up step ("用 /ship-mr 提 MR"), an addition, a correction, a change of direction. It reads them at its next turn. Only for that project\'s own deliverable — another feature or document is something new (chat_with_desk), also in the same repository. A finished project is continued with reopen_project.',
    inputSchema: obj(
      {
        id: str("project id"),
        text: OWNER_TEXT("the owner's instruction"),
        context: CONTEXT,
        urgent: { type: "boolean", description: "interrupt what it is doing (only when it is going the wrong way)" },
        waitSeconds: { type: "number", description: "wait up to this many seconds (at most 30, default 0) for the project's turn on these words and bring back its answer" },
        conversationId: CONVERSATION,
      },
      ["id", "text"],
    ),
  },
  {
    name: "set_project_state",
    description:
      "Change a project's state on the owner's word. pause / resume: stop and continue background work. someday: park it (everything kept, nothing runs). activate: bring a parked project back and start it (not resume) — only when the owner, after it was parked, said to start it now (get_project shows who parked it, when and in what words; a new mention of the idea is not that go-ahead). complete: the owner says it is done. cancel: the owner no longer wants it (workers stopped; files and branches stay).",
    inputSchema: obj(
      {
        id: str("project id"),
        state: { type: "string", enum: ["pause", "resume", "someday", "activate", "complete", "cancel"] },
        note: str("the owner's own words that came with it (why they park it, their go-ahead), verbatim; kept with the project and shown to it. Not your summary"),
      },
      ["id", "state"],
    ),
  },
  {
    name: "add_action",
    description:
      'Add an open item to a project: something the owner said they will do themselves ("human" — it goes on their to-do list) or something to wait for ("waiting"). Write it as the owner put it; do not add conditions they did not give.',
    inputSchema: obj(
      { projectId: str("project id"), title: str("what it is"), owner: { type: "string", enum: ["human", "waiting"] }, nextStep: str("the concrete next physical step — give one for human, so the owner knows what to do"), effort: EFFORT },
      ["projectId", "title", "owner"],
    ),
  },
  {
    name: "list_human_items",
    description:
      "Everything waiting on the owner in 待我处理: open human actions (their to-dos) and pending cards, with their options, itemRevision, artifactVersion, the plan of a project confirmation card (proposal), resumeTarget and closeTargets. Cards currently being revised by the background are reported separately under `revising` (not in `items`). Snoozed items are left out unless includeSnoozed.",
    inputSchema: obj({ includeSnoozed: { type: "boolean", description: "also list items put off until later (default false)" } }),
  },
  {
    name: "decide_human_item",
    description:
      "Submit the owner's choice on an item from list_human_items, with its exact option id and versions. This is where the owner's words go when they answer, accept or refuse an open item (\"报告行了\" → the review item's \"done\"). Every option is available, project confirmation included (system.execute starts the project, system.someday parks it). Submit only what the owner chose: a draft or plan with passages marked for the owner to decide needs their answer to each first. What they say with their choice goes in note; it reaches the cell that asked, so do not also send it with message_project or message_cell.",
    inputSchema: obj({
      id: str("human item id from list_human_items"),
      optionId: str('chosen option id from item.options (e.g. "done" to tick off a human action)'),
      seenItemRevision: { type: "number", description: "exact itemRevision from list_human_items" },
      seenArtifactVersion: { type: "number", description: "required when item.artifactVersion is non-null: the exact draft version the owner saw" },
      until: { type: "number", description: 'for "defer" options: Unix ms to resurface the item (default: +24h)' },
      note: str('the owner\'s words that go with the choice (a reply, a condition, revision instructions), verbatim, as far as the item does not already say them; required when option.input.mode is "required". Not your own additions, nor what they told you about how to proceed ("改完就确认")'),
      resumeProjectId: str("required when the item carries resumeTarget: pass resumeTarget.id to confirm resuming it"),
      confirmedTargets: { type: "array", items: { type: "string" }, description: 'required when the option has terminateMode "cancel_task": [targetCellId] matching option.targetCellIds' },
      confirmedClosure: { type: "array", items: { type: "string" }, description: "required when item.closeTargets[optionId] is non-empty: all its ids in the order shown" },
    }, ["id", "optionId", "seenItemRevision"]),
  },
  {
    name: "reopen_project",
    description:
      "Reopen a completed or cancelled project on its previous record (its dormant workers and cancelled actions come back). Leave text out only when the owner's words are for one particular worker of it: reopen, then message_cell that worker.",
    inputSchema: obj({ projectId: str("project id"), text: str("what the owner wants done now, in their words, without their instruction to you to reopen it (\"重开 X，把上限改回 5\" → \"把上限改回 5\")"), context: CONTEXT }, ["projectId"]),
  },
  {
    name: "undo_human_decision",
    description: "Undo a recent reversible decision by its activityId (restores the item if unread, or sends a correction to the background cell if already claimed).",
    inputSchema: obj({ activityId: str("activity id returned by decide_human_item") }, ["activityId"]),
  },
  {
    name: "read_artifact",
    description:
      "Read a report, draft or plan (artifact id from get_project or search): the current version or an older one, its version history, the passages marked for the owner to decide, and background additions kept aside (parked). Long ones come a page at a time.",
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
      "Read stored text a page at a time: res://… (a long output in a cell's record, from get_cell / inspect_cell), or reference://<name> / working_note://<name> — a cell's notes, such as a source's 观察笔记 (give that cell's id).",
    inputSchema: obj(
      {
        uri: str("res://…, reference://<name> or working_note://<name>"),
        cellId: str("for reference:// and working_note://: the cell whose note it is (list_sources and get_cell show ids)"),
        offset: { type: "number", description: "first character (default 0)" },
        limit: { type: "number", description: "characters to return (default 8000, at most 64000)" },
      },
      ["uri"],
    ),
  },
  {
    name: "search",
    description:
      "Full-text search (Chinese and English) over everything the workbench has: projects' records and reports, what its agents said and did (long outputs included), notes and preferences. Use it to find whether something was looked into before and where a past result is. An excerpt that starts with @N begins at character N of the full text: read on with read_resource / read_artifact and offset N.",
    inputSchema: obj({ query: str("words to look for"), limit: { type: "number", description: "max hits (default 12)" } }, ["query"]),
  },
  {
    name: "save_preference",
    description:
      'Record how the owner wants a kind of thing done, so every background agent follows it from now on ("改完代码后直接用 /ship-mr 提 MR"). Same name replaces the earlier text. A rule for one repository or one kind of agent names that directory (cwdPrefix) and/or roles.',
    inputSchema: obj(
      {
        name: str("short slug, e.g. code-change-followup"),
        text: str("when it applies and what to do"),
        cwdPrefix: str("only agents working in this directory or below see it (absolute path). Saving again without it lifts the limit"),
        roles: {
          type: "array",
          items: { type: "string" },
          description: 'only agents of these roles see it: "worker", "project", "checker", "desk", "hub", "sensor". Saving again without it lifts the limit',
        },
      },
      ["name", "text"],
    ),
  },
  {
    name: "list_preferences",
    description: "The owner's saved preferences and the playbooks (skills) the workbench's agents follow. Check it before saving a preference — refine an existing one under its name.",
    inputSchema: obj({}),
  },
  {
    name: "list_workspaces",
    description: "Which work trees cells are active in right now, and who is in each (nothing is locked). Check it before you touch a repository yourself.",
    inputSchema: obj({}),
  },
  {
    name: "get_cell",
    description:
      "Low-level: one background cell (project, worker, checker, sensor, hub or the desk) — its state, directory and branch, what it waits for, its notes, running commands, a question it is asking the owner, and the tail of what it did. inspect_cell reads a longer stretch.",
    inputSchema: obj({ id: str("cell id"), tail: { type: "number", description: "how many recent records to include (default 12)" } }, ["id"]),
  },
  {
    name: "message_cell",
    description:
      'Pass the owner\'s words for one cell straight to it — a worker, a project, a hub. Send what the owner wants that cell to hear, not their instruction to you ("跟改重试的那个分身说：把上限改成 3" → text "把上限改成 3"). Something for a topic a hub collects goes through capture with threads, not here. A dormant worker is woken on its record; a worker\'s project gets a copy.',
    inputSchema: obj(
      {
        id: str("cell id (from get_project, workbench_overview or get_cell)"),
        text: OWNER_TEXT("the owner's words for this cell"),
        context: CONTEXT,
        mode: { type: "string", enum: ["enqueue", "steer"], description: "enqueue (default): taken when its current step ends, or wakes it. steer: interrupt it now (only when it is running and going the wrong way; the answer says whether anything was interrupted)" },
        notifyParent: { type: "string", enum: ["silent", "wakeup"], description: "leave it out: the project reads its copy when the worker's turn ends. wakeup wakes it at once — only when the owner wants the project to step in now" },
        replyToId: str("the id of the cell's question the owner's words answer"),
        conversationId: CONVERSATION,
      },
      ["id", "text"],
    ),
  },
  {
    name: "inspect_cell",
    description:
      "What one cell was told and did, step by step, from a point on: messages it received (the owner's direct words marked), what it said, files changed, commands run, reports touched. Reading it changes nobody's progress.",
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
      'Low-level: start a background cell directly. Prefer chat_with_desk or create_project — a bare worker has nobody keeping its results. Useful for a one-off look you will fetch yourself: a "worker" does the job, then stays dormant (inspect_cell reads it; message_cell asks more). A hub needs routing rules: ask the desk for one.',
    inputSchema: obj(
      {
        preset: { type: "string", description: 'a registered preset: "worker", "checker" (checks one outside condition), "project", "hub", "sensor"' },
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
    description: "Low-level: pause, resume or cancel one background cell (cancel stops it and everything below it; files and branches stay), or trigger a script probe's check now. message / steer work as message_cell. A source is deleted with manage_source.",
    inputSchema: obj(
      {
        id: str("cell id"),
        action: { type: "string", enum: ["message", "steer", "pause", "resume", "cancel", "trigger"] },
        text: str("message / steer: only the owner's words for this cell. pause: the owner's words about why, if they gave any"),
        context: CONTEXT,
      },
      ["id", "action"],
    ),
  },

  // ---------- documents and plans ----------
  {
    name: "save_artifact",
    description:
      "Save a new version of a report or draft on the owner's instruction. If it has moved on from the version you read, nothing is written and the answer holds the current text to merge into. What you save counts as the owner's edit — a background write on the older version is kept aside instead of overwriting it.",
    inputSchema: obj(
      {
        id: str("artifact id"),
        expectedVersion: num("the version you read (read_artifact currentVersion) and changed"),
        body: str("the complete new text, not a diff", { minLength: 0 }),
        title: str("a new title (default: keep it)"),
        format: oneOf(["text", "markdown", "json"], "default: keep it"),
        data: { type: "object", description: "for a json document: its value as an object (default: parsed from body)" },
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
      "Change the plan on a pending project confirmation card before it is approved. Pass the complete list of steps (it replaces the old one); omitted fields keep what the plan says. If the plan moved on, nothing is written and the answer holds the current one. Approve afterwards with decide_human_item on the new itemRevision and artifactVersion.",
    inputSchema: obj(
      {
        id: str("id of the project confirmation card, from list_human_items"),
        expectedVersion: num("item.artifactVersion as you read it"),
        title: str("project title (default: keep it)"),
        outcome: str("what done looks like, concretely"),
        background: str("the plan's background as it reads after the change (default: keep it): complete in itself — on approval it is the brief, without the earlier draft beside it. Start from the card's text and change only what the owner asked: keep the original request and what was to be preserved, write the change as what the work now is (not \"改成…\"), and keep passages marked > [!DECISION] unless the owner answered them. Never what they told you about how to proceed", { minLength: 0 }),
        context: str("your own note for the project, if any (a fact you looked up), shown to it as not the owner's words; not what the owner told you to do with the card. \"\" removes it (default: keep it)", { minLength: 0 }),
        phases: { type: "array", items: { type: "string" }, description: "the stages in order, replacing the old ones; [] = not staged (one go). Stages only when the owner wants to look at each before the next" },
        cwd: { type: ["string", "null"], description: "absolute path of the directory the work happens in (must exist); null: none" },
        repos: {
          type: ["array", "null"],
          items: obj({ name: str("short name"), cwd: str("absolute path (must exist)"), defaultBranch: str("e.g. main") }, ["name", "cwd"]),
          description: "repositories the work spans, replacing the old list; null: none",
        },
        runnerOverride: {
          type: ["object", "null"],
          properties: { engine: oneOf(CLI_ENGINES, "runner"), model: str("model id from get_models (required with effort)"), effort: str("reasoning effort the model offers") },
          required: ["engine"],
          additionalProperties: false,
          description: "run this project on a specific runner. null: back to the workbench's default",
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
      "The workbench's sources — checks that run on a schedule and report what they find: how often and how each checks, whether hits reach the inbox (active) or only its observation notes (observe), run and hit counts, its last error, and its latest hits.",
    inputSchema: obj({}),
  },
  {
    name: "create_source",
    description:
      "Add a scheduled check: when it runs (cron, or everyMinutes) and how it checks — a script on this machine (no model cost; best for a fixed check), a registered check by name, or instructions a model follows each time.",
    inputSchema: obj(
      {
        title: str("short name the owner will recognise"),
        description: str("what it is for"),
        cron: str("5-field cron expression, e.g. \"0 9 * * 1\" (this or everyMinutes)"),
        tz: str("time zone of the cron expression, e.g. Asia/Shanghai (default: the workbench's)"),
        everyMinutes: num("interval in minutes: under 60, or whole hours up to a day (this or cron)"),
        checkKind: oneOf(["script", "code", "llm"], "script: run scriptPath. code: a registered check, codeEntry. llm: a model follows instruction"),
        scriptPath: str("for script: path of the script (it need not be executable: do not change the file or its mode)"),
        codeEntry: str("for code: name of the registered check"),
        instruction: str("for llm: what to check and what counts as a hit"),
        mode: oneOf(["active", "observe"], "active (default): hits are posted to the inbox. observe: only notes are kept"),
      },
      ["title", "checkKind"],
    ),
  },
  {
    name: "manage_source",
    description: "Pause, resume or delete a source, or switch whether its hits go to the inbox (active) or only into notes (observe). Delete only when the owner asked for it.",
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
    description: "The weekly review: what was finished, overdue waits, drafts the owner edited before approving, playbooks suggested for saving, and sources that could run as a script instead of a model.",
    inputSchema: obj({}),
  },
  {
    name: "resolve_review_suggestion",
    description: "Act on a weekly-review suggestion: save a suggested playbook (accept_skill), drop it (dismiss_skill), or make a source run a script or registered check instead of a model (sensor_to_code).",
    inputSchema: obj(
      {
        action: { type: "string", enum: ["accept_skill", "dismiss_skill", "sensor_to_code"] },
        name: str("for accept_skill / dismiss_skill: the suggestion's name"),
        sensorId: str("for sensor_to_code: source id"),
        entry: str('for sensor_to_code: "script:<path>" or a registered check (default: the one the review prepared)'),
      },
      ["action"],
    ),
  },
  // ---------- what was filed away ----------
  {
    name: "list_activity",
    description: "What the workbench did by itself or closed recently — archived notifications, saved notes, reminders, withdrawn cards, completed things — newest first, with counts and which can be taken back.",
    inputSchema: obj({ kind: oneOf(["notification_archived", "note_saved", "reminder_set", "card_withdrawn", "action_completed"], "only this kind") }),
  },
  {
    name: "restore_activity",
    description: "Hand something the workbench filed away back to the desk to triage again (the owner says it should not have been archived). A decision is taken back with undo_human_decision; list_activity says which applies.",
    inputSchema: obj({ cellId: str("cellId of the entry"), activityId: str("id of the entry") }, ["cellId", "activityId"]),
  },
  // ---------- runners and models ----------
  {
    name: "get_models",
    description: "Which agent CLIs (runners) are enabled, their models and reasoning efforts, what is selected for the strong and fast tiers and each role, and what the next run of each really uses.",
    inputSchema: obj({ refresh: { type: "boolean", description: "ask the CLIs again instead of using the remembered lists (slower; default false)" } }),
  },
  {
    name: "configure_models",
    description:
      "Change what background agents run on, when the owner asks. target runner: the default runner. target tier: the default runner's model for the strong tier (desk, projects, workers, hubs) or the fast one (checkers, sources) — auto follows the CLI, fixed pins model and effort. target role: one role's runner and model — inherit or custom. Takes effect from the next run; ids come from get_models.",
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
    description: "How the background agents are connected: every cell with its role, state, parent, directory, runner and model, who waits for whom, shared work trees, and what each project has not taken in from its workers yet.",
    inputSchema: obj({ includeArchived: { type: "boolean", description: "also list closed cells (default false)" }, projectId: str("only this project's part") }),
  },
];
