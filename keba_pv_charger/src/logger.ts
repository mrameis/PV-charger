type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const current = (process.env.LOG_LEVEL as Level) || "info";

function log(level: Level, ...args: unknown[]) {
  if (order[level] < order[current]) return;
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](`[${ts}] [${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug: (...a: unknown[]) => log("debug", ...a),
  info: (...a: unknown[]) => log("info", ...a),
  warn: (...a: unknown[]) => log("warn", ...a),
  error: (...a: unknown[]) => log("error", ...a),
};
