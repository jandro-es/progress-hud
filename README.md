# progress-hud

A Claude Code mod that keeps a live progress pane beside the chat, in the terminal and in the desktop app.

- **Subagents**: each running agent with a spinner, elapsed time, a time-based progress bar, time left and an estimated cost. Finished agents are listed with how long they took and what they cost.
- **Tasks**: `TaskCreate`/`TaskUpdate` tasks and `TodoWrite` to-dos, with done/total, average time and cost per task, and the remaining work.
- **Shells**: every Bash command and Monitor, from the main thread and from subagents. A foreground command shows elapsed time against its timeout, and an ETA once that command has run before. A background shell shows how it got there (asked for, ctrl+b, or past its timeout), the size and line count of its output, lines per second and its last line, read from its output file every two seconds. Finished commands show their exit code, line count and whether they wrote to stderr; `TaskStop` marks them stopped.
- **Totals**: overall progress, ETA, spend so far (the session's real cost), projected cost at finish, burn rate, a spend sparkline, context-window fill and rate-limit windows.
- **Status line**: a one-line summary under the prompt while work is under way.

The time estimates learn from history: how long agents of each type took, and how long tasks took, are kept across sessions. Per-agent cost is priced from its tokens at list prices, then calibrated against the session's real spend.

`/progress` shows or hides the pane; `/progress clear` drops finished agents and tasks. `/progress demo` walks four sample tasks through the pane in about 30 seconds, for a session without the task tools; their timings are not learnt from.

## Install

At the prompt of a terminal session:

```
/plugin install progress-hud --marketplace jandro-es/progress-hud
```

Answer `y` to add the marketplace, then pick a scope (the user scope, first, makes it load in every session).

From a shell:

```
claude plugin install progress-hud --marketplace jandro-es/progress-hud
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jandro-es/progress-hud`, then Add plugin.
