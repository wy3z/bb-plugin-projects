# Projects

Cursor-style project boards for BB, built on BB's own Tasks plugin. Tasks owns
the data (tasks, statuses, labels, delegation); this plugin is the board, the
live cards, and a project lead workflow.

## What you get

- **Projects page** (sidebar navigation): Board and List views of a tracker
  project. Columns follow Cursor: Backlog, Queued, In Progress, For Review,
  Done, with Canceled behind the eye toggle. Drag cards between and within
  columns. Filter by title or key.
- **Live cards**: key, labels, priority, the title (inline `code` rendered),
  the attached agent's state (a flat blue dot and "Working · preset · 12m",
  "Needs input", "Worked · 2 agents"), the agent worktree's changes (+A −D,
  click to open the agent in a split), and its pull requests with status icons.
- **Card menu**: delegate to any Tasks preset, Apply locally (the worker's
  worktree into the project checkout), Create PR, Open in Tasks. Apply and
  Create PR call the Agent Pills plugin's git actions, so that plugin must be
  installed.
- **Focus card**: one or two sentences on what matters now, editable on the
  board or with `bb projects focus`.
- **Project lead**: a thread recorded as the lead (`bb projects lead`), linked
  from the board. The `projects` skill teaches it to plan, delegate as child
  threads attached to tasks, keep the board true and write status updates.
- **Loop card**: the lead's triggers and memory under the focus card. A
  scheduled board sweep (off, 1h to 8h, weekdays 08:00-19:00 by default),
  following every PR the lead's workers link, the project's memory notes, and
  the last messages from the outer loop.
- **Composer pill and side-panel tab**: in any thread of a BB project linked to
  a tracker project, a pill with the project's name, working count and "N for
  review" opens a compact list in the side panel.

## CLI

```sh
bb projects status PIXEL          # counts per column, work in flight, focus
bb projects focus PIXEL "text"    # set; --clear to remove; no text to show
bb projects lead PIXEL            # make the current thread the lead; --thread, --show
bb projects send PIXEL "text"     # hand the lead context or work; --source, --ref
bb projects notes PIXEL           # project memory; --append "line", --set "all"
bb projects loop PIXEL            # triggers; --sweep 2h|off, --any-hours, --follow-prs on|off
```

## Outer loop and inner loop

The lead is the inner loop: it turns intent into checked work. The outer loop
gathers context and decides what deserves attention. Lauren Tan (poteto) runs
Grok Bot routines as her outer loop, watching Slack, X, email and Linear and
handing work to Cursor projects. Here the hand-off is `bb projects send`.

To use Grok Bot as the outer loop:

1. Turn on bb's MCP server (`bb plugin enable bb--mcp`) and run
   `bb mcp status` for the remote address, `https://<your bb connect
   address>/mcp`.
2. In Grok Bot, add that address as a custom MCP connector and approve access
   on the bb account page. The approval is all or nothing: the bot can run any
   `bb` command, start agents and change files. Revoke it with
   `bb mcp revoke`.
3. Give the routine a stable instruction, for example: "Every weekday at 09:00
   and when someone reports a bug in #pixel-feedback, summarise what is new and
   run `bb projects send PIXEL "<summary>" --source grok-bot --ref <link>`
   through the bb connector. Read `bb projects status PIXEL --json` first and
   don't resend what the lead already has."

The lead triages each message onto the board, delegates, and notifies you
only when something needs you or completes. `bb projects status --json`
includes `needsYou` and the loop settings, so a routine can also report back.

## Requirements

BB 0.49+, plugin SDK 0.6.132+, the built-in Tasks plugin enabled, and Agent
Pills for Apply locally and Create PR.

## Develop

```sh
npm install
npm run typecheck
npm run build
bb plugin install path:$PWD --yes
bb plugin reload projects
```
