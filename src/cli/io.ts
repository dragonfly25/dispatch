import { decorationEnabled } from "./ui.js";

/** Output sinks of the CLI, injectable for tests. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /**
   * Whether each stream may carry colors, symbols and spinners (see {@link decorationEnabled}).
   * Absent means plain text: tests and other embedders get undecorated output.
   */
  decorate?: { out: boolean; err: boolean };
}

/** The real process streams. */
export const processIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  decorate: {
    out: decorationEnabled(process.stdout, process.env),
    err: decorationEnabled(process.stderr, process.env),
  },
};
