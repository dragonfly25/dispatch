/** Commander options shared by the commands that take a task (`explain`, later `run`). */
import type { Command } from "commander";

/** Adds `--task`, `--task-file`, `--task-type`, `--path`, `--model`, `--tier`, `--effort`, `--autonomy`, `--timeout`. */
export function addTaskOptions(cmd: Command): Command {
  return cmd
    .option("--task <text>", "the task prompt")
    .option("--task-file <path>", "read the task prompt from a file")
    .option("--task-type <type>", "task type used by rules (test, docs, review, ...)")
    .option(
      "--path <path>",
      "repo-relative path the task touches (repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--model <model>", "model the host asked for")
    .option("--tier <tier>", "tier of the task (fast, balanced, max)")
    .option("--effort <effort>", "effort of the task (low, medium, high)")
    .option("--autonomy <level>", "autonomy of the task (read-only, worktree, direct)")
    .option("--timeout <seconds>", "task timeout in seconds");
}
