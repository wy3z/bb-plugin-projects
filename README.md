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
- **Composer pill and side-panel tab**: in any thread of a BB project linked to
  a tracker project, a pill with the project's name, working count and "N for
  review" opens a compact list in the side panel.

## CLI

```sh
bb projects status PIXEL          # counts per column, work in flight, focus
bb projects focus PIXEL "text"    # set; --clear to remove; no text to show
bb projects lead PIXEL            # make the current thread the lead; --thread, --show
```

## Requirements

BB 0.48.1+, plugin SDK 0.6.104+, the built-in Tasks plugin enabled, and Agent
Pills for Apply locally and Create PR.

## Develop

```sh
npm install
npm run typecheck
npm run build
bb plugin install path:$PWD --yes
bb plugin reload projects
```
