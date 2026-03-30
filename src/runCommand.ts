import * as cp from "child_process";

export interface CommandInput {
  command: string;
  args?: string[];
  onSuccess: (data: string) => void;
  onError: (error: string) => void;
  onExit: (code: number | null) => void;
}


/**
 * Utility to execute commands and return their results through callbacks.
 * 
 * @param {CommandInput} param0 - The inputs and callbacks
 * 
 * @returns {cp.ChildProcessWithoutNullStreams} - The spawn child process
 */
export const runCommand = ({ command, args = [], onSuccess, onError, onExit }: CommandInput): cp.ChildProcessWithoutNullStreams => {
  const child = cp.spawn(command, args);

  child.stdout.on('data', (data: Buffer) => {
    onSuccess(data.toString());
  });

  child.stderr.on('data', (data: Buffer) => {
    onError(data.toString());
  });

  child.on('close', (code) => {
    onExit(code);
  });

  return child;
};

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Promise-based wrapper around runCommand. Accumulates stdout/stderr
 * and resolves with the full result when the process closes.
 *
 * @param command - The command to execute
 * @param args - Optional arguments to pass to the command
 *
 * @returns The accumulated stdout, stderr, and exit code
 */
export async function runCommandAsync(command: string, args: string[] = []): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    runCommand({
      command,
      args,
      onSuccess(data) {
        stdout += data;
      },
      onError(data) {
        stderr += data;
      },
      onExit(code) {
        resolve({ stdout, stderr, exitCode: code });
      },
    });
  });
}

