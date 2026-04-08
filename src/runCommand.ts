import * as cp from "child_process";

export interface CommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  /** Optional environment overrides passed directly to `child_process.spawn`. */
  env?: NodeJS.ProcessEnv;
  onSuccess: (data: string) => void;
  onError: (error: string) => void;
  onExit: (code: number | null) => void;
  onSpawnError?: (error: Error) => void;
}


/**
 * Utility to execute commands and return their results through callbacks.
 * 
 * @param {CommandInput} param0 - The inputs and callbacks
 * 
 * @returns {cp.ChildProcessWithoutNullStreams} - The spawn child process
 */
export const runCommand = ({ command, args = [], cwd, env, onSuccess, onError, onExit, onSpawnError }: CommandInput): cp.ChildProcessWithoutNullStreams => {
  const child = cp.spawn(command, args, { cwd, env });

  child.stdout.on('data', (data: Buffer) => {
    onSuccess(data.toString());
  });

  child.stderr.on('data', (data: Buffer) => {
    onError(data.toString());
  });

  child.on('close', (code) => {
    onExit(code);
  });

  child.on('error', (error) => {
    onSpawnError?.(error);
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
 * @param cwd - Optional working directory for the command
 * @param env - Optional environment overrides for the command
 *
 * @returns The accumulated stdout, stderr, and exit code
 */
export async function runCommandAsync(
  command: string,
  args: string[] = [],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ stdout, stderr, exitCode });
    };

    runCommand({
      command,
      args,
      cwd,
      env,
      onSuccess(data) {
        stdout += data;
      },
      onError(data) {
        stderr += data;
      },
      onExit(code) {
        finish(code);
      },
      onSpawnError(error) {
        stderr += error.message;
        finish(-1);
      },
    });
  });
}
