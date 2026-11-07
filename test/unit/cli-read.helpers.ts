/** Harness for the read-command tests: a CLI wired to a temp HOME and repo, with captured output. */
import { buildProgram, runCli } from "../../src/cli/program.js";
import { QuotaReaderRegistry } from "../../src/quota/reader.js";
import { FakeClock } from "../stubs/index.js";
import { sandbox } from "./config/helpers.js";

export const NOW = "2026-11-07T10:00:00.000Z";

export type Sandbox = ReturnType<typeof sandbox>;

export interface Run {
  code: number;
  out: string;
  err: string;
}

export interface Harness {
  sb: Sandbox;
  clock: FakeClock;
  /** Runs `dispatch <args>` in `cwd` (default: the sandbox root) with `env` over the temp HOME. */
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<Run>;
}

/** A fresh sandbox (temp HOME, fake clock, fixed task ids) and a runner for it. */
export function harness(): Harness {
  const sb = sandbox();
  const clock = new FakeClock(NOW);
  return {
    sb,
    clock,
    async run(args, opts = {}) {
      const env = { ...sb.env, ...opts.env };
      let out = "";
      let err = "";
      const io = {
        out: (t: string) => {
          out += t;
        },
        err: (t: string) => {
          err += t;
        },
      };
      const program = buildProgram(
        io,
        {},
        {},
        {
          cwd: opts.cwd ?? sb.root,
          env,
          clock,
          newId: () => "task-1",
          quotaReaders: new QuotaReaderRegistry(),
        },
      );
      const code = await runCli(args, io, program, { platform: process.platform, env });
      return { code, out, err };
    },
  };
}

/** Masks the input hash, which changes whenever a shipped asset does. */
export const maskHash = (text: string): string =>
  text.replace(/sha256 [0-9a-f]{16}/, "sha256 <hash>");

/** A global config with a pin on `db/migrations/**` (UC5). */
export const PIN_CONFIG = `version: 1
pins:
  - id: migrations
    match: { paths: ["db/migrations/**"] }
    action: { type: host }
`;
