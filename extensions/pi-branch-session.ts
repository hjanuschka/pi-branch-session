import {
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const AUTO_SYNC_COMMAND = "/branch-session-sync --auto";
const BRANCH_POLL_MS = 1500;
const RELOAD_AFTER_SWITCH = true;

type GitResult = {
  ok: boolean;
  stdout: string;
};

type RuntimeState = {
  timer: ReturnType<typeof setInterval> | undefined;
  gitRoot: string | undefined;
  lastSeenBranch: string | undefined;
  autoEnabled: boolean;
  autoSwitchQueued: boolean;
  agentBusy: boolean;
};

const state: RuntimeState = {
  timer: undefined,
  gitRoot: undefined,
  lastSeenBranch: undefined,
  autoEnabled: true,
  autoSwitchQueued: false,
  agentBusy: false,
};

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return { ok: false, stdout: "" };
  }

  return { ok: true, stdout: (result.stdout ?? "").trim() };
}

function toSafeProjectPath(path: string): string {
  return `--${path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function toSafeBranchName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned.length > 0 ? cleaned : "unknown";
}

function getGitRoot(cwd: string): string | undefined {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok || !result.stdout) return undefined;
  return result.stdout;
}

function getGitBranch(cwd: string): string | undefined {
  const branch = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.ok && branch.stdout) return branch.stdout;

  const detachedCommit = runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  if (detachedCommit.ok && detachedCommit.stdout) {
    return `detached-${detachedCommit.stdout}`;
  }

  return undefined;
}

function getBranchSessionDir(gitRoot: string, branch: string): string {
  const projectDir = toSafeProjectPath(gitRoot);
  const branchDir = toSafeBranchName(branch);
  return join(getAgentDir(), "sessions", projectDir, "branches", branchDir);
}

function getTargetSessionFile(cwd: string, gitRoot: string, branch: string): string {
  const sessionDir = getBranchSessionDir(gitRoot, branch);
  mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.continueRecent(cwd, sessionDir);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) {
    throw new Error(`No session file could be created for ${branch}`);
  }
  return sessionFile;
}

async function syncToCurrentBranch(
  ctx: ExtensionCommandContext,
  options: { auto: boolean },
): Promise<{ switched: boolean }> {
  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) {
    state.autoSwitchQueued = false;
    if (!options.auto && ctx.hasUI) {
      ctx.ui.notify("Not inside a git repository.", "warning");
    }
    return { switched: false };
  }

  const branch = getGitBranch(gitRoot);
  if (!branch) {
    state.autoSwitchQueued = false;
    if (!options.auto && ctx.hasUI) {
      ctx.ui.notify("Could not resolve current git branch.", "warning");
    }
    return { switched: false };
  }

  state.gitRoot = gitRoot;
  state.lastSeenBranch = branch;

  const targetSessionFile = getTargetSessionFile(ctx.cwd, gitRoot, branch);
  const currentSessionFile = ctx.sessionManager.getSessionFile();

  if (currentSessionFile && resolve(currentSessionFile) === resolve(targetSessionFile)) {
    state.autoSwitchQueued = false;
    if (!options.auto && ctx.hasUI) {
      ctx.ui.notify(`Already using branch session for ${branch}.`, "info");
    }
    return { switched: false };
  }

  if (options.auto && ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      "Branch changed",
      `Do you want to switch history to branch "${branch}"?`,
    );

    if (!confirmed) {
      state.autoSwitchQueued = false;
      ctx.ui.notify(`Keeping current session history (branch is now ${branch}).`, "info");
      return { switched: false };
    }
  }

  const result = await ctx.switchSession(targetSessionFile);
  state.autoSwitchQueued = false;

  if (!result.cancelled && ctx.hasUI) {
    ctx.ui.notify(`Loaded branch session: ${branch}`, "info");
  }

  return { switched: !result.cancelled };
}

function queueAutoSync(pi: ExtensionAPI): void {
  if (state.autoSwitchQueued) return;
  state.autoSwitchQueued = true;

  try {
    if (state.agentBusy) {
      pi.sendUserMessage(AUTO_SYNC_COMMAND, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(AUTO_SYNC_COMMAND);
    }
  } catch {
    try {
      pi.sendUserMessage(AUTO_SYNC_COMMAND, { deliverAs: "followUp" });
    } catch {
      state.autoSwitchQueued = false;
    }
  }
}

function stopMonitor(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}

function startMonitor(pi: ExtensionAPI, cwd: string): void {
  stopMonitor();

  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) {
    state.gitRoot = undefined;
    state.lastSeenBranch = undefined;
    return;
  }

  state.gitRoot = gitRoot;
  state.lastSeenBranch = getGitBranch(gitRoot);

  state.timer = setInterval(() => {
    if (!state.autoEnabled || !state.gitRoot || state.autoSwitchQueued) {
      return;
    }

    const branch = getGitBranch(state.gitRoot);
    if (!branch) return;

    if (!state.lastSeenBranch) {
      state.lastSeenBranch = branch;
      return;
    }

    if (branch === state.lastSeenBranch) {
      return;
    }

    state.lastSeenBranch = branch;
    queueAutoSync(pi);
  }, BRANCH_POLL_MS);
}

export default function branchSessionExtension(pi: ExtensionAPI) {
  pi.on("session_directory", (event) => {
    const gitRoot = getGitRoot(event.cwd);
    if (!gitRoot) return;

    const branch = getGitBranch(gitRoot);
    if (!branch) return;

    const sessionDir = getBranchSessionDir(gitRoot, branch);
    mkdirSync(sessionDir, { recursive: true });

    return { sessionDir };
  });

  pi.on("session_start", (_event, ctx) => {
    startMonitor(pi, ctx.cwd);
  });

  pi.on("session_switch", (_event, ctx) => {
    startMonitor(pi, ctx.cwd);
  });

  pi.on("agent_start", () => {
    state.agentBusy = true;
  });

  pi.on("agent_end", () => {
    state.agentBusy = false;
  });

  pi.on("session_shutdown", () => {
    stopMonitor();
  });

  pi.registerCommand("branch-session-sync", {
    description: "Switch to the session for the currently checked out git branch",
    handler: async (args, ctx) => {
      const auto = args.includes("--auto");
      const { switched } = await syncToCurrentBranch(ctx, { auto });

      if (switched && RELOAD_AFTER_SWITCH) {
        await ctx.reload();
        return;
      }

      startMonitor(pi, ctx.cwd);
    },
  });

  pi.registerCommand("branch-session-auto", {
    description: "Enable or disable automatic branch-session switching (usage: /branch-session-auto [on|off|status])",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();

      if (value === "off") {
        state.autoEnabled = false;
        state.autoSwitchQueued = false;
        if (ctx.hasUI) ctx.ui.notify("Branch session auto-switch disabled.", "info");
        return;
      }

      if (value === "status") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Branch session auto-switch is ${state.autoEnabled ? "on" : "off"}.`,
            "info",
          );
        }
        return;
      }

      state.autoEnabled = true;
      if (ctx.hasUI) ctx.ui.notify("Branch session auto-switch enabled.", "info");

      const { switched } = await syncToCurrentBranch(ctx, { auto: false });
      if (switched && RELOAD_AFTER_SWITCH) {
        await ctx.reload();
        return;
      }

      startMonitor(pi, ctx.cwd);
    },
  });
}
