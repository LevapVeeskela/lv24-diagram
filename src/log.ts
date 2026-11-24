const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const configured = (process.env.LV24_DIAGRAM_LOG ?? "info").toLowerCase();
const threshold = LEVELS[configured as Level] ?? LEVELS.info;

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] > threshold) return;
  // stdout is reserved for the MCP protocol; every log line goes to stderr.
  console.error(`[lv24-diagram:${level}]`, ...args);
}

export const log = {
  error: (...args: unknown[]) => emit("error", args),
  warn: (...args: unknown[]) => emit("warn", args),
  info: (...args: unknown[]) => emit("info", args),
  debug: (...args: unknown[]) => emit("debug", args),
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
