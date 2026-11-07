/**
 * The `@clack/prompts` {@link Prompter} of `dispatch setup`, used only when stdin and stdout are
 * both terminals. Cancelling any prompt (Ctrl-C / Esc) stops setup before anything is written:
 * it prints "nothing was changed" and exits with the usage code.
 */
import type * as Clack from "@clack/prompts";
import { ExitCode } from "../core/contracts.js";
import type { Prompter } from "../setup/prompter.js";
import { ExitRequest } from "./exit.js";

/** The part of `@clack/prompts` the prompter uses; tests pass a fake. */
export type ClackApi = Pick<
  typeof Clack,
  | "intro"
  | "outro"
  | "cancel"
  | "note"
  | "select"
  | "confirm"
  | "text"
  | "spinner"
  | "isCancel"
  | "log"
>;

/** Loads the real `@clack/prompts` (lazily: other commands never pay for it). */
export const loadClack = async (): Promise<ClackApi> => import("@clack/prompts");

/** Message shown when a prompt is cancelled. */
export const CANCELLED = "Setup cancelled: nothing was changed.";

/** A {@link Prompter} over `clack`. */
export function clackPrompter(clack: ClackApi): Prompter {
  const answer = <T>(value: T | symbol): T => {
    if (clack.isCancel(value) || typeof value === "symbol") {
      clack.cancel(CANCELLED);
      throw new ExitRequest(ExitCode.USAGE);
    }
    return value as T;
  };
  return {
    rich: true,
    intro: (title) => clack.intro(title),
    info: (text) => clack.log.info(text),
    warn: (text) => clack.log.warn(text),
    note: (title, body) => clack.note(body, title),
    async select(title, options, def) {
      const picked: unknown = await clack.select<string>({
        message: title,
        options: options.map((o) => ({
          value: o.value as string,
          label: o.value,
          ...(o.label ? { hint: o.label } : {}),
        })),
        initialValue: def,
      });
      return answer(picked as typeof def | symbol);
    },
    confirm: async (question) =>
      answer<boolean>(await clack.confirm({ message: question, initialValue: false })),
    text: async (question) =>
      answer<string>(await clack.text({ message: question.replace(/:\s*$/, "") })),
    spinner() {
      const s = clack.spinner();
      return { start: (m) => s.start(m), stop: (m) => s.stop(m) };
    },
    outro: (text) => clack.outro(text),
  };
}
