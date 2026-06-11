// Resolves the package version from package.json at runtime so the CLI's
// --version (and the startup banner) stays in sync with `npm version`
// bumps without needing a code edit.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/util/version.js → ../../package.json
    const pkgPath = resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
