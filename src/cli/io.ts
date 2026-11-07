/** Output sinks of the CLI, injectable for tests. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** The real process streams. */
export const processIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};
