import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface BackupResult {
  backupPath?: string;
}

/**
 * Reads a file as UTF-8, returning null if it doesn't exist.
 */
export async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Writes `content` to `file`, creating parent dirs and backing up any
 * existing file as `<file>.bak-<timestamp>`. No backup is written if the
 * existing content already matches.
 */
export async function writeWithBackup(file: string, content: string): Promise<BackupResult> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = await readFileOrNull(file);
  if (existing === content) return {};
  let backupPath: string | undefined;
  if (existing != null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${file}.bak-${stamp}`;
    await fs.writeFile(backupPath, existing, "utf8");
  }
  await fs.writeFile(file, content, "utf8");
  return { backupPath };
}

export function homeExpand(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
