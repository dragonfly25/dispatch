// fs-trace preload for the AC7 suite: `node --require fs-trace.cjs dist/cli.mjs ...`.
// Records every path the Dispatch process opens, reads, copies or probes through `node:fs`
// (callback, sync and promise APIs; ESM named imports are re-synced) and writes them, one JSON
// record per line, to $FS_TRACE_OUT when the process exits. Child processes are not traced: the
// preload is a CLI flag, not inherited, and the child env is allow-listed anyway.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const { fileURLToPath } = require("node:url");

const out = process.env.FS_TRACE_OUT;
if (out) {
  const records = [];
  const { appendFileSync } = fs;
  const norm = (p) => {
    if (typeof p === "number") return null; // an fd: its path was recorded when it was opened
    try {
      const s = p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : String(p);
      return path.resolve(s);
    } catch {
      return null;
    }
  };
  const note = (op, args) => {
    const p = norm(args[0]);
    if (p) records.push({ op, path: p });
    if (op.startsWith("copyFile") || op.startsWith("cp")) {
      const dest = norm(args[1]);
      if (dest) records.push({ op, path: dest });
    }
  };
  const wrap = (obj, name, op) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function traced(...args) {
      note(op, args);
      return orig.apply(this, args);
    };
  };
  const OPEN = ["open", "openSync", "readFile", "readFileSync", "createReadStream"];
  const COPY = ["copyFile", "copyFileSync", "cp", "cpSync"];
  const PROBE = [
    "existsSync",
    "stat",
    "statSync",
    "lstat",
    "lstatSync",
    "access",
    "accessSync",
    "readdir",
    "readdirSync",
    "realpathSync",
    "readlinkSync",
  ];
  for (const n of [...OPEN, ...COPY, ...PROBE]) wrap(fs, n, n);
  for (const n of ["open", "readFile", "copyFile", "cp", "stat", "lstat", "access", "readdir"]) {
    wrap(fs.promises, n, `promises.${n}`);
  }
  syncBuiltinESMExports();
  process.on("exit", () => {
    try {
      appendFileSync(out, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
    } catch {
      // tracing must never change the traced process
    }
  });
}
