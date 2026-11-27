# `tools/plan-lint`: the plan linter and progress report

`plan-lint.mjs` validates the three agent task plans of the Velexis MVP and reports how much of them is done. It is one plain Node script with no dependencies and no `package.json`: it is not a workspace package, needs no `pnpm install`, and Turborepo does not run it. CI runs it in the `plan-lint` job before anything is installed ([`tools/ci/README.md`](../ci/README.md)). The task format comes from [ADR-0020](../../docs/mvp/adr/0020-ai-agent-development-workflow.md); the done markers and the progress report come from [ADR-0025](../../docs/mvp/adr/0025-roadmap-scheduling-and-tracking.md) item 6 and task X-035 of [`foundation-tasks.md`](../../docs/mvp/plans/foundation-tasks.md).

| File | What it does |
|---|---|
| `plan-lint.mjs` | The linter and the progress report |
| `test/plan-lint.test.mjs` | Its tests, for the Node test runner; they run the script as a child process |
| `test/fixtures/plan.md` | A three-task fixture plan: X-901 → X-902 → X-903, the first two done |
| `test/index.js` | Makes `node --test tools/plan-lint/test/` run every `*.test.mjs` file of the folder (below) |

## Run it

```bash
node tools/plan-lint/plan-lint.mjs                # or pnpm plan:lint: check the three plans, print both summary blocks
node tools/plan-lint/plan-lint.mjs --remaining    # the ready tasks of the lowest open milestone, critical path first, then M7's
node tools/plan-lint/plan-lint.mjs --graph        # also print the dependency graph as a Mermaid flowchart
node tools/plan-lint/plan-lint.mjs path/plan.md   # check other files instead of the three plans
node --test tools/plan-lint/test/                 # the tests
```

Without file arguments it reads `docs/mvp/plans/foundation-tasks.md`, `platform/docs/plans/agent-tasks.md` and `ota/docs/plans/agent-tasks.md`. Paths are relative to the repository root (the folder two levels above the script), whatever the current directory. Exit codes: `0` no errors, `1` errors (listed under `ERRORS:`), `2` an unknown option.

## What it checks

A task block starts with `### <ID> · <Title>` and has the fields **Component**, **Milestone**, **Depends on**, **Size**, **Read first**, **Files**, **Steps**, **Acceptance** and **Verify** (the format of [`docs/mvp/plans/README.md`](../../docs/mvp/plans/README.md) §4). Other fields, such as **Status** or **Gate**, are allowed. plan-lint reports:

- a heading that starts like a task id but does not read `### PBE-012 · Title`, an unknown id prefix, a duplicate id;
- a missing or empty field, a component that does not match the id prefix (`X` foundation, `PBE`, `PFE`, `PAD`, `OBE`, `OFE`, `OAD`, `SDK`), a size other than S, M or L, a milestone that does not look like `M1`;
- fewer than 2 numbered steps, no acceptance criterion, a Verify without a command in backticks, Files without backticked paths or with a path outside the allowed top-level folders;
- a dependency on an unknown task or on itself, and dependency cycles;
- the **done marker** rules below.

### Done marker and status

A task is done when its heading ends with ` ✅` (a space, then the emoji, then the end of the line): `### X-012 · Add the baseline migrations ✅`. plan-lint strips the marker from the title. This is the one status rule of all three task files ([ADR-0025](../../docs/mvp/adr/0025-roadmap-scheduling-and-tracking.md) item 6, [`AGENTS.md`](../../AGENTS.md) §4): the task's PR adds `- **Status:** in progress (PR #n)`, and its last commit sets `done (PR #n)` and appends ` ✅`, so both hold on `main` from the merge on.

When a task has a **Status** line, these are errors:

- the heading ends with ` ✅`, but the status is not a done status (for example `in progress (PR #12)`, `todo`, or a bare `done`);
- the status starts with `done`, but the heading does not end with ` ✅`;
- and, with or without a Status line, a ` ✅` anywhere else in the heading.

A done status is `done (PR #n)`. `done (branch <name>)` is accepted as well, for work integrated on a branch without one PR per task. A task without a Status line (most platform and OTA tasks) is done exactly when its heading ends with ` ✅`.

## Output

The first block covers the whole plan, done or not; the second block reports progress by the done markers. Done tasks count 0 h in the remaining work, and the remaining critical path is the longest dependency chain of the tasks without ` ✅` (in plan-lint hours: S 2, M 4, L 8). On the fixture:

```text
tasks: 3  estimated hours: 14
by component: {"foundation":3}
by milestone: {"M0":1,"M1":2}
critical path: 14h over 3 tasks: X-901 -> X-902 -> X-903

done tasks: 2/3  done hours: 6/14  remaining tasks: 1  remaining hours: 8
done by milestone (tasks, hours): M0 1/1 2/2h, M1 1/2 4/12h
done by file (tasks, hours): tools/plan-lint/test/fixtures/plan.md 2/3 6/14h
remaining critical path: 8h over 1 tasks: X-903
ERRORS: 0
```

`done by milestone` and `done by file` read `<done>/<total> tasks <done>/<total> hours`. They replace the old `grep -c '^### .* ✅$'` progress count of the roadmap ([`roadmap.md`](../../docs/mvp/plans/roadmap.md) §4.3).

### `--remaining`: what to pick next

`--remaining` prints, instead of the two summary blocks, the list that [`AGENTS.md`](../../AGENTS.md) §3 asks agents to pick from, in one or two blocks.

The first block holds the open tasks of the **lowest milestone that still has open tasks** whose dependencies are **all done**. The tasks on the remaining critical path come first (marked `*`), then the tasks that start the longest chain of open work (`chain`: the task's own hours plus the longest chain of open tasks that depend on it), then the larger tasks; ties keep the plan order. Tasks whose status says `in progress` are marked `[in progress]`: they are claimed, and so are tasks with an open PR or a `task/<ID>-*` branch, which plan-lint cannot see. The open tasks that wait for a dependency are listed last with what they wait for. The errors follow the last block, as in the normal run.

```text
lowest open milestone: M1 (1 of 2 tasks open, 1 ready)
ready tasks (every dependency done), critical path first; * = on the remaining critical path, chain = hours of the longest open chain the task starts:
* X-903  L 8h  chain 8h  Put the third fixture roof on  (tools/plan-lint/test/fixtures/plan.md)
ERRORS: 0
```

The second block lists the open tasks of **M7** (task X-053). M7 is built before the launch, while the open tasks of M0 to M6 wait on the owner's steps, a nightly run or the launch ([ADR-0025](../../docs/mvp/adr/0025-roadmap-scheduling-and-tracking.md) item 3, revision of 2026-11-25; [ADR-0030](../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 19). So when M7 has open tasks and is not the lowest open milestone, a blank line and a second block follow the first, in the same form: a heading with M7's open, total and ready counts, its ready tasks in the same order, then its waiting tasks with what they wait for. A task is ready by the same rule in both blocks: every dependency is done, whatever its milestone. The constant `BUILT_BEFORE_LAUNCH` of the script names the milestone. The second block never lists M8, which starts after the launch. On a variant of the fixture with three M7 tasks and two M8 tasks (the test `[X-053 AC3]`, saved as `plan.md`):

```text
lowest open milestone: M1 (1 of 2 tasks open, 1 ready)
ready tasks (every dependency done), critical path first; * = on the remaining critical path, chain = hours of the longest open chain the task starts:
* X-903  L 8h  chain 14h  Put the third fixture roof on  (plan.md)

also open, built before the launch: M7 (3 of 3 tasks open, 1 ready)
ready tasks (every dependency done), critical path first; * = on the remaining critical path, chain = hours of the longest open chain the task starts:
  X-904  S 2h  chain 6h  Draw the fourth fixture plan  (plan.md)
waiting for dependencies:
  X-905 waits for X-903
  X-906 waits for X-905
ERRORS: 0
```

X-904 is ready because its one dependency, X-901 (M0), is done. X-905 waits for X-903 (M1), and X-906 for X-905. As in the first block, the `*` and `chain` count the open tasks of all the plans, whatever their milestone: X-903's `*` and chain of 14 h follow X-903 -> X-905 -> X-906, the remaining critical path, and X-904's chain of 6 h ends with X-908, an M8 task that no block lists. When M7 is the lowest open milestone, has no open task or is not in the plans, `--remaining` prints the first block alone, byte for byte as before X-053.

When every task is done, it prints `remaining: none, every task is done`.

## Tests

```bash
node --test tools/plan-lint/test/
```

The tests use only `node:test` and `node:assert`, and write only to the system temporary folder. They lint the fixture and variants of it (markers removed or misplaced, a dependency reopened, statuses that disagree with the marker, extra tasks that make each `--remaining` sort key decide, a dependency in a later milestone, open M7 and M8 tasks beside a lower open milestone, an M7 task on the remaining critical path, M7 as the lowest open milestone, an M7 task that is done, an M7 block larger than a pipe read late), check that the real plans give `ERRORS: 0`, a second summary block that adds up to the first and a `--remaining` that names M7 while it has open tasks, and run a copy of the script from an empty folder to prove that it needs nothing but Node. Test names start with `[X-035 AC<n>]` (`[X-035]` for `--help` and `--graph`, which no criterion names) or, for the M7 block of `--remaining`, `[X-053 AC<n>]`.

Since Node 21, `node --test <folder>` no longer searches the folder: it runs the folder as one module, and Node resolves that to `test/index.js`, which imports every `*.test.mjs` file next to it. `node --test tools/plan-lint/test/*.test.mjs` runs the same tests.

The script keeps its own compact style, and Prettier skips this folder (`.prettierignore`). ESLint accepts it: `pnpm exec eslint tools/plan-lint`.
