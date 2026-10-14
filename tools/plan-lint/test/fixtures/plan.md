# plan-lint test fixture

A small plan for `tools/plan-lint/test/plan-lint.test.mjs` (task X-035). It is not a real plan: plan-lint reads it only when a test passes its path. Three tasks in one chain, X-901 → X-902 → X-903: the first two are done (` ✅` and `done (PR #n)`), the third is open. The tests derive the other cases from this text.

## M0

### X-901 · Lay the first fixture stone ✅
- **Status:** done (PR #1)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** —
- **Size:** S
- **Read first:** tools/plan-lint/README.md
- **Files:** `tools/plan-lint/test/fixtures/plan.md`
- **Steps:**
  1. Lay the stone.
  2. Check that it is level.
- **Acceptance:**
  - The stone is level.
- **Verify:** `node --version`

## M1

### X-902 · Build the second fixture wall ✅
- **Status:** done (PR #2)
- **Component:** foundation
- **Milestone:** M1
- **Depends on:** X-901
- **Size:** M
- **Read first:** tools/plan-lint/README.md
- **Files:** `tools/plan-lint/test/fixtures/plan.md`
- **Steps:**
  1. Build the wall on the stone.
  2. Check that it stands.
- **Acceptance:**
  - The wall stands.
- **Verify:** `node --version`

### X-903 · Put the third fixture roof on
- **Status:** todo
- **Component:** foundation
- **Milestone:** M1
- **Depends on:** X-902
- **Size:** L
- **Read first:** tools/plan-lint/README.md
- **Files:** `tools/plan-lint/test/fixtures/plan.md`
- **Steps:**
  1. Put the roof on the wall.
  2. Check that it keeps the rain out.
- **Acceptance:**
  - The roof keeps the rain out.
- **Verify:** `node --version`
