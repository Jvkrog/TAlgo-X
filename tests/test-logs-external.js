// logs.js must tail processes that have no coloured sidecar (external PM2 processes), not drop them.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "logs-")), logs = path.join(root, "logs"), bin = path.join(root, "bin");
fs.mkdirSync(logs); fs.mkdirSync(bin);
fs.writeFileSync(path.join(logs, "zlong-out.log"), "plain external line 1\nplain external line 2\n");
fs.writeFileSync(path.join(logs, "eng-out.log"), "plain engine\n"); fs.writeFileSync(path.join(logs, "eng-out-color.log"), "\x1b[32mcolour engine\x1b[0m\n");
const jl = [{ pm2_env: { pm_out_log_path: path.join(logs, "zlong-out.log"), pm2_env: {} } }, { pm2_env: { pm_out_log_path: path.join(logs, "eng-out.log") } }];
fs.writeFileSync(path.join(bin, "pm2"), `#!/bin/sh\necho '${JSON.stringify(jl)}'\n`, { mode: 0o755 });
const run = args => cp.execFileSync("node", [path.join(__dirname, "..", "logs.js"), "--no-follow", ...args], { encoding: "utf8", env: { ...process.env, PM2_HOME: root, PATH: bin + ":" + process.env.PATH } });
const all = run([]);
assert.ok(/plain external line 2/.test(all), "external process log shown");
assert.ok(/colour engine/.test(all) && !/plain engine/.test(all), "our engine uses its coloured sidecar");
assert.ok(/plain external line 1/.test(run(["zlong"])) && !/colour engine/.test(run(["zlong"])), "name filter works");
console.log("all passed");
