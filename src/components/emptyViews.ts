import * as path from "path";
import * as vscode from "vscode";
import { EntireStatusState, EntireWorkspaceState } from "../workspaceProbe";

export type EmptyViewKind = "workspace" | "activeSessions" | "checkpoints" | "recovery";

export interface EmptyViewCommands {
  readonly refresh: string;
  readonly showStatus: string;
  readonly runDoctor?: string;
  readonly resumeBranch?: string;
  readonly clean?: string;
  readonly reset?: string;
  readonly showTrace?: string;
}

interface EmptyViewAction {
  readonly label: string;
  readonly description?: string;
  readonly command?: string;
  readonly icon?: string;
}

interface EmptyViewLine {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: string;
}

class EmptyViewItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options: {
      description?: string;
      tooltip?: string;
      icon?: string;
      command?: string;
      contextValue?: string;
    } = {},
  ) {
    super(label, collapsibleState);
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.iconPath = options.icon ? new vscode.ThemeIcon(options.icon) : undefined;
    this.command = options.command ? { command: options.command, title: label } : undefined;
    this.contextValue = options.contextValue ?? "session-bridge-empty-view";
  }
}

export class EmptyViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly kind: EmptyViewKind,
    private workspaceState: EntireWorkspaceState,
    private readonly commands: EmptyViewCommands,
  ) { }

  setWorkspaceState(workspaceState: EntireWorkspaceState): void {
    this.workspaceState = workspaceState;
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.workspaceState.state === EntireStatusState.NOT_GIT_REPO) {
      return [];
    }

    const content = buildViewContent(this.kind, this.workspaceState, this.commands);
    return [
      ...content.lines.map(
        (line) =>
          new EmptyViewItem(line.label, vscode.TreeItemCollapsibleState.None, {
            description: line.description,
            tooltip: line.tooltip,
            icon: line.icon,
            contextValue: `session-bridge-empty-line-${this.kind}`,
          }),
      ),
      ...content.actions.map(
        (action) =>
          new EmptyViewItem(action.label, vscode.TreeItemCollapsibleState.None, {
            description: action.description,
            icon: action.icon,
            command: action.command,
            contextValue: `session-bridge-empty-action-${this.kind}`,
          }),
      ),
    ];
  }
}

function buildViewContent(
  kind: EmptyViewKind,
  workspaceState: EntireWorkspaceState,
  commands: EmptyViewCommands,
): { lines: EmptyViewLine[]; actions: EmptyViewAction[] } {
  switch (kind) {
    case "workspace":
      return buildWorkspaceContent(workspaceState, commands);
    case "activeSessions":
      return {
        lines: [
          {
            label: "No active sessions",
            tooltip: "Current branch session activity will appear here.",
            icon: "play-circle",
          },
        ],
        actions: [
          {
            label: "Refresh session state",
            command: commands.refresh,
            icon: "refresh",
          },
        ],
      };
    case "checkpoints":
      return {
        lines: [
          {
            label: "No checkpoints on this branch",
            tooltip: "Committed checkpoints and rewind-only points will appear here.",
            icon: "history",
          },
        ],
        actions: [
          {
            label: "Refresh checkpoint state",
            command: commands.refresh,
            icon: "refresh",
          },
        ],
      };
    case "recovery":
      return {
        lines: [
          {
            label: "Recovery actions",
            tooltip: "Diagnosis and cleanup stay explicit in this view.",
            icon: "tools",
          },
        ],
        actions: buildRecoveryActions(commands),
      };
  }
}

function buildWorkspaceContent(
  workspaceState: EntireWorkspaceState,
  commands: EmptyViewCommands,
): { lines: EmptyViewLine[]; actions: EmptyViewAction[] } {
  const lines: EmptyViewLine[] = [
    {
      label: getWorkspaceStateLabel(workspaceState.state),
      description: "Repository health and Entire configuration appear here.",
      tooltip: getWorkspaceStateTooltip(workspaceState.state),
      icon: getWorkspaceStateIcon(workspaceState.state),
    },
  ];

  if (workspaceState.binary?.cliVersion) {
    lines.push({
      label: "CLI",
      description: workspaceState.binary.cliVersion,
      icon: "versions",
    });
  }

  const settingsPath = getPrimarySettingsPath(workspaceState);
  if (settingsPath) {
    lines.push({
      label: "Settings",
      description: settingsPath,
      tooltip: settingsPath,
      icon: "gear",
    });
  }

  for (const warning of workspaceState.warnings) {
    lines.push({
      label: warning,
      icon: "warning",
    });
  }

  return {
    lines,
    actions: [
      {
        label: "Refresh workspace state",
        description: "Re-run repository and Entire detection.",
        command: commands.refresh,
        icon: "refresh",
      },
      {
        label: "Show raw CLI status",
        description: "Open the raw Entire status output.",
        command: commands.showStatus,
        icon: "output",
      },
    ],
  };
}

function buildRecoveryActions(commands: EmptyViewCommands): EmptyViewAction[] {
  return [
    {
      label: "Run Doctor",
      description: "Diagnose stuck sessions and disconnected metadata.",
      command: commands.runDoctor,
      icon: "search",
    },
    {
      label: "Resume Branch Session",
      description: "Restore the latest checkpointed branch session metadata.",
      command: commands.resumeBranch,
      icon: "play",
    },
    {
      label: "Clean Entire State",
      description: "Remove orphaned Entire state without a full reset.",
      command: commands.clean,
      icon: "trash",
    },
    {
      label: "Reset Entire Session Data",
      description: "Clear current session data with an explicit action.",
      command: commands.reset,
      icon: "warning",
    },
    {
      label: "Show Trace",
      description: "Open raw trace output for troubleshooting.",
      command: commands.showTrace,
      icon: "output",
    },
  ].filter((action) => action.command !== undefined);
}

function getWorkspaceStateLabel(state: EntireStatusState): string {
  switch (state) {
    case EntireStatusState.ENABLED:
      return "Entire enabled";
    case EntireStatusState.CLI_MISSING:
      return "Entire CLI not found";
    case EntireStatusState.DISABLED:
    default:
      return "Entire not enabled";
  }
}

function getWorkspaceStateTooltip(state: EntireStatusState): string {
  switch (state) {
    case EntireStatusState.ENABLED:
      return "Entire is enabled for this Git repository.";
    case EntireStatusState.CLI_MISSING:
      return "The Entire CLI is unavailable in the extension host environment.";
    case EntireStatusState.DISABLED:
    default:
      return "Entire is available, but it is not enabled for this Git repository.";
  }
}

function getWorkspaceStateIcon(state: EntireStatusState): string {
  switch (state) {
    case EntireStatusState.ENABLED:
      return "check";
    case EntireStatusState.CLI_MISSING:
      return "warning";
    case EntireStatusState.DISABLED:
    default:
      return "circle-slash";
  }
}

function getPrimarySettingsPath(workspaceState: EntireWorkspaceState): string | undefined {
  const settingsPath = workspaceState.settings?.settingsPaths.at(-1);
  if (!settingsPath) {
    return undefined;
  }

  const normalized = settingsPath.replaceAll(path.sep, "/");
  const marker = normalized.indexOf("/.entire/");
  if (marker >= 0) {
    return normalized.slice(marker + 1);
  }

  return path.basename(settingsPath);
}
