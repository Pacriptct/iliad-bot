// Minimal timestamped console logger.
const stamp = () => new Date().toISOString();

export const log = {
  info: (...args: unknown[]) => console.log(stamp(), "[info]", ...args),
  warn: (...args: unknown[]) => console.warn(stamp(), "[warn]", ...args),
  error: (...args: unknown[]) => console.error(stamp(), "[error]", ...args),
};
