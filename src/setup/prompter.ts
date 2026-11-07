/**
 * How `dispatch setup` talks to the person running it. Two implementations: the numbered
 * readline {@link linePrompter} below (no terminal tricks: pipes, tests, `install` in scripts)
 * and the `@clack/prompts` one in `src/cli/prompter.ts`, used when stdin and stdout are TTYs.
 */
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** One option of a {@link Prompter.select}. */
export interface Choice<T extends string> {
  value: T;
  label: string;
}

/** A running progress indicator. */
export interface PromptSpinner {
  start(message: string): void;
  stop(message: string): void;
}

/** The questions and messages of the setup flow. */
export interface Prompter {
  /** True for the full-screen terminal prompter (clack). */
  readonly rich: boolean;
  /** Opening banner. */
  intro(title: string): void;
  /** A plain message line. */
  info(text: string): void;
  /** A prominent warning (e.g. the Antigravity terms). */
  warn(text: string): void;
  /** A titled block of lines. */
  note(title: string, body: string): void;
  /** One choice out of `options`; Enter takes `def`. */
  select<T extends string>(title: string, options: readonly Choice<T>[], def: T): Promise<T>;
  /** A yes/no question; the default is no. */
  confirm(question: string): Promise<boolean>;
  /** Free text (used for typed confirmations). */
  text(question: string): Promise<string>;
  spinner(): PromptSpinner;
  /** Closing message. */
  outro(text: string): void;
}

const MAX_TRIES = 3;

/**
 * The numbered readline prompter: questions go through `ask` (one answer line each), messages
 * through `io.out`. Plain text only.
 */
export function linePrompter(
  io: { out(text: string): void },
  ask: (question: string) => Promise<string>,
): Prompter {
  return {
    rich: false,
    intro: (title) => io.out(`${title}\n`),
    info: (text) => io.out(`${text}\n`),
    warn: (text) => io.out(`\n${text}\n`),
    note: (title, body) => io.out(`${title}\n${body}\n`),
    async select(title, options, def) {
      const defIndex = Math.max(
        0,
        options.findIndex((o) => o.value === def),
      );
      const lines = options.map(
        (o, i) =>
          `  ${i + 1}) ${o.value.padEnd(12)} ${o.label}${i === defIndex ? " (default)" : ""}`,
      );
      io.out(`\n${title}\n${lines.join("\n")}\n`);
      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        const raw = (await ask(`Choice [${defIndex + 1}]: `)).trim().toLowerCase();
        if (raw === "") return options[defIndex]?.value ?? def;
        const byNumber = /^\d+$/.test(raw) ? options[Number(raw) - 1] : undefined;
        const hit = byNumber ?? options.find((o) => o.value.toLowerCase() === raw);
        if (hit) return hit.value;
        io.out(`Please answer with a number from 1 to ${options.length} or a name.\n`);
      }
      throw new DispatchError(
        `no valid answer to "${title.replace(/^Step \d+\/\d+ · /, "")}"; run \`dispatch setup\` again or pass the answer as a flag`,
        ExitCode.USAGE,
        "setup.bad_answer",
      );
    },
    confirm: async (question) => /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim()),
    text: (question) => ask(question),
    spinner: () => ({ start: () => {}, stop: () => {} }),
    outro: (text) => io.out(`${text}\n`),
  };
}
