import { runCommandAsync } from "./runCommand";

export type EntireBinary = {
  command: string;
  cliVersion?: string;
  goVersion?: string;
  osArch?: string;
  raw: string;
};

export type EntireResolveError = {
  message: string;
  reason: string;
};

function parseVersion(version: string): EntireBinary {
  const parts = version.trim().split("\n");
  const eb: EntireBinary = { command: "entire", raw: version.trim() };

  if (parts.length < 3) {
    return eb;
  }

  const ev = parts[0].split(" ")[2];
  if (typeof ev === "string") {
    eb.cliVersion = ev.trim();
  }

  const gv = parts[1].split(":")[1];
  if (typeof gv === "string") {
    eb.goVersion = gv.trim();
  }

  const os = parts[2].split(":")[1];
  if (typeof os === "string") {
    eb.osArch = os.trim();
  }

  return eb;
}

export async function resolveEntireBinary(): Promise<EntireBinary | EntireResolveError> {
  const { stdout, stderr, exitCode } = await runCommandAsync("entire", ["version"]);

  if (exitCode === 0 && stdout.length > 0) {
    return parseVersion(stdout);
  }

  return {
    message: stderr.length > 0
      ? "Make sure entire cli is installed and available"
      : "Error detecting entire cli. Try again.",
    reason: stderr.length > 0
      ? stderr.trim()
      : `Command exited with code: ${exitCode}`,
  };
}

export function isEntireBinary(obj: unknown): obj is EntireBinary {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "command" in obj &&
    typeof (obj as EntireBinary).command === "string" &&
    "raw" in obj &&
    typeof (obj as EntireBinary).raw === "string"
  );
}

export function isEntireResolveError(obj: unknown): obj is EntireResolveError {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "message" in obj &&
    typeof (obj as EntireResolveError).message === "string" &&
    "reason" in obj &&
    typeof (obj as EntireResolveError).reason === "string"
  );
}