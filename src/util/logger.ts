type Level = "silent" | "info" | "debug";

let current: Level = "info";

export function setLogLevel(level: Level) {
  current = level;
}

function ts() {
  return new Date().toISOString();
}

export const log = {
  info: (...args: unknown[]) => {
    if (current === "silent") return;
    console.log(`[${ts()}] [info]`, ...args);
  },
  debug: (...args: unknown[]) => {
    if (current !== "debug") return;
    console.log(`[${ts()}] [debug]`, ...args);
  },
  warn: (...args: unknown[]) => {
    if (current === "silent") return;
    console.warn(`[${ts()}] [warn]`, ...args);
  },
  error: (...args: unknown[]) => {
    console.error(`[${ts()}] [error]`, ...args);
  },
};
