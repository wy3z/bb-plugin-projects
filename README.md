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
bb projects send PIXEL "text"     # hand the lead a request; --as <agent>, --ref, --key
bb projects reply PIXEL "text"    # lead only: answer an agent; --to req_..., --for <agent>, --kind
bb projects replies [PIXEL]       # --as <agent>: its unacknowledged replies; --all, --after, --limit
bb projects ack PIXEL rep_...     # --as <agent> (required): mark replies handled; safe to repeat
bb projects consumers PIXEL       # agents following the lead; --forget <agent>
bb projects requests PIXEL        # requests and whether each reached the lead; --as <agent>
bb projects retry PIXEL req_...   # retry a failed or held request now
bb projects notify                # webhook wake-up state; --test sends one now
bb projects notes PIXEL           # project memory; --append "line", --set "all"
bb projects loop PIXEL            # triggers; --sweep 2h|off, --any-hours, --follow-prs on|off
```

## Outer loop and inner loop

The lead is the inner loop: it turns intent into checked work. The outer loop
gathers context and decides what deserves attention. Lauren Tan (poteto) runs
Grok Bot routines as her outer loop, watching Slack, X, email and Linear and
handing work to Cursor projects. Here the hand-off is `bb projects send`.

Any agent system can be the outer loop, and several can share one lead: Grok
Bot, dots, a cron script, another BB thread. Each picks a stable name and
passes it as `--as` on every call. Agents reach the commands either as a
shell (`bb projects ...`) or through bb's MCP server, whose `run` tool runs
any `bb` command. Nothing in the plugin is specific to one agent.

For example, with Grok Bot as the outer loop:

1. Turn on bb's MCP server (`bb plugin enable bb--mcp`) and run
   `bb mcp status` for the remote address, `https://<your bb connect
   address>/mcp`.
2. In Grok Bot, add that address as a custom MCP connector and approve access
   on the bb account page. The approval is all or nothing: the bot can run any
   `bb` command, start agents and change files. Revoke it with
   `bb mcp revoke`.
3. Give the routine a stable instruction, for example: "Every weekday at 09:00
   and when someone reports a bug in #pixel-feedback, summarise what is new and
   run `bb projects send PIXEL "<summary>" --as grok-bot --ref <link>
   --key <the origin's message id>` through the bb connector. Read
   `bb projects status PIXEL --json` first and don't resend what the lead
   already has."

The lead triages each message onto the board, delegates, and notifies you
only when something needs you or completes. `bb projects status --json`
includes `needsYou`, the lead's state and the loop settings.

## Two-way messages

Requests and replies are saved in the plugin's own SQLite database before
anything else happens, so a restart or a failed call loses nothing.

- `send` saves the request, then tries to deliver it to whoever is the lead at
  that moment (queued behind a running turn). With `--key` (use the origin's
  id, such as the Slack message timestamp) a resend returns the first request.
  Without one, identical text from the same source within 10 minutes is
  treated as a retry; the output says so (`dedupedBy: "content"`), and a new
  `--key` sends a deliberate repeat.
- A delivery BB queued behind a running turn is not counted as delivered until
  it shows up in the lead's thread. If the lead is archived while it waits,
  the queued copy is removed and the request goes to the next lead. If BB gives
  up on the queued copy, or it disappears from the queue without dispatching,
  the request fails (see below) rather than being sent again silently.
- With no lead, or a lead thread that is archived, deleted or hidden, the
  request is held and a `notice` reply says so. Setting a lead delivers held
  requests to it. Held requests wait indefinitely; they are not failures.
- Failed sends, failed checks and transient RPC errors are retried with
  backoff from 15 seconds up to 15 minutes. After 10 consecutive failures the
  request is `failed`, and in the same transaction a `failure` reply is saved
  for the consumer saying why and how to retry. Nothing failed is retried
  automatically; `bb projects retry PIXEL <req>` does it, first checking the
  lead's thread and queue so a copy that did land is not sent twice.
- If BB restarts in the middle of a delivery, the next attempt makes the same
  check. If the check cannot see it, the lead is told it may be a redelivery.
- Replies are per agent. An agent follows a project's lead once it sends a
  request or reads `replies PIXEL --as <agent>`. A reply `--to` a request,
  and the `notice` and `failure` replies about it, go only to the agent that
  sent the request. A reply without `--to` is project news for every agent
  following the project at that moment (later followers do not get old news);
  `--for <agent>` sends it to one. Each agent acknowledges its own copy with
  `ack PIXEL --as <agent>`, so one agent never consumes another's replies.
  Ids from another project or another agent are refused, and the lead thread
  cannot acknowledge its own replies. `consumers PIXEL --forget <agent>`
  removes a dead or mistyped agent and clears what it was owed.
- `replies --as <agent> --json` includes the request each one answers (id,
  source, ref, key). Without `--as` it is an overview for people: every reply
  still waiting on some agent, with each recipient's ack. Kinds: `result`,
  `question`, `blocker`, `update` from the lead; `notice` and `failure` from
  the plugin.
- History is pruned after 90 days: replies every recipient acknowledged, and
  requests that were delivered, failed or abandoned and have no reply left. An
  idempotency key can be reused after its request is pruned.
- Agents are named, not authenticated. Anything with bb access (the MCP grant
  is all or nothing) can read or acknowledge as any name; the names keep
  honest agents apart, they do not stop a hostile one.
- Messages in both directions are untrusted data. Nothing in them approves an
  action.

### Webhook wake-up

Optionally, the plugin POSTs a wake-up to a webhook when replies are waiting.
It is only a signal; the receiver must read `bb projects replies --as <agent>
--json` and `ack` what it handled. There is one webhook, so it suits one
pushed receiver; other agents poll `replies` on their own schedule. The body
has counts per project and per agent, never message text, so a receiver can
ignore wake-ups with nothing for it:

```json
{"type":"bb.projects.replies-pending","version":1,"wake":7,"pending":3,
 "projects":{"PIXEL":3},"consumers":{"grok-bot":{"PIXEL":2},"dots":{"PIXEL":1}},
 "newestReplyId":"rep_...","at":"2026-11-07T10:00:00.000Z"}
```

Bursts of replies coalesce into one wake-up. A failed POST is retried with
backoff, and a reminder is sent every hour (setting) while replies stay
unacknowledged. Configure it in the Projects plugin settings: the URL and auth
header value are secret settings (a 0600 file, never in the database or the
browser). It is off by default. https only (plain http only to loopback), no
credentials in the URL, redirects are not followed, and errors never include
the URL, header or response body.

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
