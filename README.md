# pi-branch-session

Store pi sessions per git branch by using the `session_directory` extension hook.

## What it does

On startup, the extension:

1. Detects the git repository root for the current working directory.
2. Detects the current branch.
3. Returns a branch-aware session directory via `session_directory`.

Resulting session path layout:

```text
~/.pi/agent/sessions/--<repo-root>--/branches/<branch-name>/
```

Examples:

- `feature/login` -> `feature-login`
- detached HEAD at `a1b2c3d` -> `detached-a1b2c3d`

If the directory is not a git repository, the extension does nothing and pi uses its normal default session directory.

## Branch change detection while pi is running

The extension polls the current git branch. When it detects a branch change, it asks:

"Do you want to switch history to branch \"<branch>\"?"

- OK: switches to that branch session and triggers a runtime reload so the experience matches a fresh launch with that session loaded
- Cancel: keeps the current session history

Important: because of current extension command invocation limits in pi, auto switch needs one command-context initialization per session. Run `/branch-session-auto on` once after startup.

Commands:

- `/branch-session-sync` - manually switch to current branch session
- `/branch-session-auto on|off|status` - control automatic branch change detection

## Install

### From local path

```bash
pi install /absolute/path/to/pi-branch-session
```

or from inside the repo:

```bash
pi install .
```

### One-off run

```bash
pi -e ./extensions/pi-branch-session.ts
```

## Notes

- `--session-dir` bypasses this hook by design.
- The hook runs on CLI startup only (not on `/new` or `/resume`).
- If multiple extensions return `sessionDir`, the last one wins.
