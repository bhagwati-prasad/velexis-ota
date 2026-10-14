// Entry point of `node --test tools/plan-lint/test/` (the Verify command of task X-035). Since Node 21 the test runner
// no longer searches a folder given on the command line: it runs it as one module, which Node resolves to this file.
// It loads every *.test.mjs file next to it, so that the command runs all the tests, and fails when there is none.
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const files = readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();
if (files.length === 0) {
  throw new Error(`no *.test.mjs files in ${__dirname}`);
}
for (const name of files) {
  import(pathToFileURL(join(__dirname, name)).href).catch((error) => {
    process.exitCode = 1;
    throw error;
  });
}
