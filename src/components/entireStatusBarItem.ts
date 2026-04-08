import * as vscode from "vscode";
import { EntireStatusState, EntireWorkspaceState } from "../workspaceProbe";

interface StatusBarInfo {
  iconName: string;
  title: string;
  description: string;
  backgroundColor?: vscode.ThemeColor;
}

const WARNING_BACKGROUND = new vscode.ThemeColor("statusBarItem.warningBackground");

const statusInfoMap: Record<EntireStatusState, StatusBarInfo> = {
  [EntireStatusState.ENABLED]: {
    iconName: "git-compare",
    title: "Enabled",
    description: "Entire is enabled for this repository.",
  },
  [EntireStatusState.CLI_MISSING]: {
    iconName: "warning",
    title: "Not Found",
    description: "The Entire CLI is not available in the extension host environment.",
    backgroundColor: WARNING_BACKGROUND,
  },
  [EntireStatusState.NOT_GIT_REPO]: {
    iconName: "repo",
    title: "Not a git repo",
    description: "Open a Git repository to use Entire features.",
  },
  [EntireStatusState.DISABLED]: {
    iconName: "circle-slash",
    title: "Not Enabled",
    description: "Entire is not enabled for this repository.",
  },
};

function getStatusBarInfo(workspaceState: EntireWorkspaceState): StatusBarInfo {
	if (workspaceState.state !== EntireStatusState.ENABLED) {
		return statusInfoMap[workspaceState.state];
	}

	const sessionCount = workspaceState.activeSessions.length;
	if (sessionCount > 1) {
		const activeCount = workspaceState.activeSessions.filter((session) => session.status === "ACTIVE").length;
		return {
			iconName: "layers",
			title: `${sessionCount} Sessions`,
			description: activeCount > 0
				? `Multiple Entire sessions are live in this workspace (${activeCount} active).`
				: "Multiple Entire sessions are live in this workspace.",
		};
	}

	if (sessionCount === 1) {
		const session = workspaceState.activeSessions[0];
		const agent = formatAgentName(session.agent);
		const stateLabel = session.status === "ACTIVE" ? "Active" : "Idle";

		return {
			iconName: session.status === "ACTIVE" ? "pulse" : "clock",
			title: agent ? `${stateLabel} · ${agent}` : stateLabel,
			description: session.status === "ACTIVE"
				? "Entire is actively tracking a session in this workspace."
				: "Entire is tracking an idle live session in this workspace.",
		};
	}

  return statusInfoMap[EntireStatusState.ENABLED];
}

function buildTooltip(statusInfo: StatusBarInfo, workspaceState: EntireWorkspaceState): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.supportThemeIcons = true;

  tooltip.appendMarkdown(`**Entire**\n\n`);
  tooltip.appendMarkdown("**Status:** ");
  tooltip.appendText(statusInfo.title);
  tooltip.appendText("\n");
  tooltip.appendText(statusInfo.description);

  if (workspaceState.binary?.cliVersion) {
    tooltip.appendMarkdown("\n**CLI Version:** ");
    tooltip.appendText(workspaceState.binary.cliVersion);
  }

  const sessionCount = workspaceState.activeSessions.length;
  tooltip.appendMarkdown("\n\n**Sessions:** ");
  tooltip.appendText(String(sessionCount));

  if (sessionCount > 0) {
    for (const session of workspaceState.activeSessions.slice(0, 3)) {
      tooltip.appendMarkdown("\n- ");
      tooltip.appendText(describeSession(session));
    }

    if (sessionCount > 3) {
      tooltip.appendMarkdown("\n- ");
      tooltip.appendText(`${sessionCount - 3} more session(s)`);
    }
  }

  if (workspaceState.settings?.settingsPaths.length) {
    tooltip.appendMarkdown("\n\n**Settings Files:** ");
    tooltip.appendText(String(workspaceState.settings.settingsPaths.length));
  }

  if (workspaceState.warnings.length > 0) {
    tooltip.appendMarkdown("\n\n**Warnings**");
    for (const warning of workspaceState.warnings) {
      tooltip.appendMarkdown("\n- ");
      tooltip.appendText(warning);
    }
  }

  tooltip.appendMarkdown("\n\n_Click to show Entire status._");

  return tooltip;
}

function describeSession(session: EntireWorkspaceState["activeSessions"][number]): string {
	const parts: string[] = [];
	const agent = formatAgentName(session.agent);

	if (agent) {
		parts.push(agent);
	}
	if (session.model) {
		parts.push(session.model);
	}
	if (session.status) {
		parts.push(session.status);
	}
	if (session.sessionId) {
		parts.push(`#${session.sessionId.slice(0, 8)}`);
	}

  return parts.join(" · ");
}

function formatAgentName(agentType?: string): string | undefined {
  if (!agentType) {
    return undefined;
  }

  return agentType
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function createStatusBarItem(command: string, workspaceState: EntireWorkspaceState): vscode.StatusBarItem {
  const statusBarItem = vscode.window.createStatusBarItem(
    "session.bridge.entire.status",
    vscode.StatusBarAlignment.Left,
    100,
  );
  updateStatusBarItem(statusBarItem, command, workspaceState);

  return statusBarItem;
}

export function updateStatusBarItem(
  statusBarItem: vscode.StatusBarItem,
  command: string,
  workspaceState: EntireWorkspaceState,
): void {
  const statusInfo = getStatusBarInfo(workspaceState);
  const label = `Session Bridge (Entire): ${statusInfo.title}`;

  statusBarItem.name = "Session Bridge Status";
  statusBarItem.text = `$(${statusInfo.iconName}) ${label}`;
  statusBarItem.tooltip = buildTooltip(statusInfo, workspaceState);
  statusBarItem.command = command;
  statusBarItem.backgroundColor = statusInfo.backgroundColor;
  statusBarItem.accessibilityInformation = {
    label,
    role: "button",
  };
}
