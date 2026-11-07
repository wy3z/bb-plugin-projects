---
name: projects
description: Lead a BB project board built on Tasks. Use when you are the project lead for a tracker project (bb projects lead), when asked to plan, delegate, or report on a project's work, or when asked for a project status update.
---

# Leading a project

A tracker project in BB Tasks is the shared record of a project's work. The
Projects plugin shows it as a board (Backlog, Queued, In Progress, For Review,
Done) with each task's agents, pull requests and changes. You, the lead, keep
that board true and keep the user's attention on what matters.

Check whether you are the lead with `bb projects lead <PREFIX> --show`. If the
user asks you to lead, run `bb projects lead <PREFIX>` from your thread.

## Plan

- Read the board first: `bb projects status <PREFIX>` and `bb tasks list --project <PREFIX>`.
- One task per outcome a person would check. Put the acceptance criteria in the
  description. Use the project's labels; for Pixel, title tasks with their
  SCOPE.md ID (`PLAY-3 · ...`) and add `Scope: <ID>` to the description.
- Do not invent priorities or due dates. Ask, or leave them unset.
- Keep `bb projects focus <PREFIX> "<one or two sentences>"` current: what
  matters most right now. Clear it with `--clear` when that focus ends.

## Delegate

Two ways to start a worker on a task:

1. You need to hear when it finishes (most work): spawn a child thread and
   attach it to the task.

   ```sh
   bb thread spawn --parent-self --new-environment worktree --base-branch main \
     --provider claude-code --model claude-opus-5-5 --prompt-file brief.md
   bb tasks attach <KEY> --thread <new thread id>
   bb tasks update <KEY> --status in_progress
   ```

2. Fire and forget: `bb tasks dispatch <KEY> --preset "<preset name>"`. The
   worker reports back on the task, but you get no lifecycle notification.

Every brief says which task it serves, the acceptance criteria, and to push
from the worktree's own branch and open the pull request from it, so the board
can match the PR to the worker. Link the PR to the worker's thread with
`bb pull-requests link <url>` as well.

## Keep the board true

- When a worker finishes, read its result, then move the task: `in_review` when
  a PR or result needs a person, `done` only when the criteria are met and
  checked, back to `todo` with a comment when it failed.
- Comment the evidence on the task (`bb tasks comment <KEY> --body ...`): PR
  link, test results, what was verified and what was not.
- Never mark something done because a worker said so. Check its evidence.

## Notifications

Your thread is set to notify only for questions, approvals and errors, so
finishing a turn is silent. Most of your turns are routine (a worker reported,
you moved a card) and should stay that way. Send a notification yourself only
when the user has something to do or to see:

```sh
bb push-notifications send --thread <your thread id> --title "<PREFIX>: <what happened>" --body "<one line: what you need or what is ready>"
```

- Ready for the user: a task moved to `in_review`, or a PR is ready to merge.
- Needs the user: a decision, credentials, access, or a worker blocked on them.
  A question at the end of a turn does not notify on its own, whether it is
  typed or a ```ui block that waits for an answer (Form, Button choices,
  Decision, Plan, OptionCards, Choice). Whenever your reply asks the user to
  pick, approve or fill something in, send one in the same turn, naming the
  question in the body.
- Complete: everything in the current focus or plan is done.

One notification per event, never for progress, a worker starting, a card
moving between in-flight columns, or a status update the user asked for in
chat. Batch events that land in the same turn into one notification.

## Status updates

When asked for a status update (or prompted by the weekly automation):

1. Run `bb projects status <PREFIX>`.
2. Check each in-flight task's agents and PRs.
3. Reply in a few short lines: what moved since the last update, what is
   blocked and on whom, what needs the user's decision, and the next two or
   three things you will start. Name task keys and PR numbers.
4. Update the focus if it changed.
