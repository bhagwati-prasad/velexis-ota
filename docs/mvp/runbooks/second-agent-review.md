# Second-agent review

This runbook is the procedure for the second-agent review pass: before the developer reviews a pull request, a **fresh AI agent session with read-only access and no secrets** reads the PR diff, the task block, the security checklist and the [prompt file](second-agent-review-prompt.md), and its findings are posted in the PR as **one comment**. It is required for the money and card PRs of M3 and optional elsewhere. It adds a second, independent reader; it never replaces the developer's own review, and "no findings" is not an approval. Task X-036 in [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) wrote it, following the follow-up of [ADR-0020](../adr/0020-ai-agent-development-workflow.md).

Related: [ADR-0020](../adr/0020-ai-agent-development-workflow.md) (Gates and permissions, Follow-ups), [`roadmap.md`](../plans/roadmap.md) (M3, Human review gates; go criterion 5), [`conventions.md` §12](../conventions.md#12-security-checklist-every-pr) (security checklist), [`AGENTS.md`](../../../AGENTS.md) §4, §5 and §8, [`.github/pull_request_template.md`](../../../.github/pull_request_template.md) (the checkbox that records it).

## 1. When it is required and when it is optional

**Required** for the M3 deep-review PRs that the roadmap lists under [M3, Human review gates](../plans/roadmap.md#m3--book--pay-w15w19). The roadmap is the source of truth: if its list changes, this table follows in the same PR.

| Task | What makes it money or card code |
|---|---|
| OBE-031, OBE-033 | Customer tokens, cookies, refresh rotation |
| OBE-036 | Encrypted traveller documents |
| OBE-038, OBE-039, OBE-040 | Stripe gateway, webhooks, voids, capture retries and refunds |
| OBE-042, OBE-043, OBE-044 | Booking orchestrator, timeout recovery and the `504` replay, ticketing retries |
| OBE-049 | Cancellation with the money step |
| OBE-050, OBE-051, OBE-052, OFE-014 | Airline card: gateway and `SensitiveCard`, the completion operation, the PAN-absence proof, the isolated payment page |
| OBE-054 | Signed download URLs |
| OBE-057 | Cookie sessions, CSRF and both caller modes |

**Recommended** (the developer decides per PR):

- the deep-review PRs of the other milestones (the "Deep review" lines of each milestone's human review gates in the roadmap) when review falls behind, as the roadmap's risk table says;
- a later PR that changes the code of a task in the table above (for example a fix in the Stripe gateway or the orchestrator during M4).

**Optional:** any other PR, when the developer wants a second reader. It adds little to PRs that change only plans or prose.

Only the developer starts a review. An agent never reviews its own PR, and the implementing session is never reused as the reviewing session.

## 2. Roles

| Who | Does |
|---|---|
| Developer | Prepares the inputs (§3.1), starts the reviewing session (§3.2), posts its comment (§3.3), decides on every finding (§4), reviews the PR as usual and merges. |
| Reviewing session | Reads the inputs and the repository at the PR head, applies the checks of the [prompt](second-agent-review-prompt.md) and writes one findings comment in the format of the prompt's §6. It never pushes commits and never changes anything on GitHub (prompt §2). |
| Implementing agent | When the developer asks, fixes findings with new commits on the PR branch or writes the answer to a finding, as for any review comment. |

## 3. How it runs

### 3.1 Prepare the inputs (developer)

Run this in bash from your own clone of the repository (the `gh` commands use its remote and your own `gh` login). It makes a separate, push-disabled clone at the PR head and collects the four inputs. The prompt, the task block and the checklist are taken from **`main`**, not from the PR branch, so a PR can neither soften its own review nor rewrite the acceptance criteria it is checked against.

```bash
PR=123                    # the pull request number
TASK=OBE-042              # its task id
REVIEW_DIR="$HOME/velexis-review/pr-$PR"

case "$TASK" in
  X-*)               PLAN=docs/mvp/plans/foundation-tasks.md ;;
  PBE-*|PFE-*|PAD-*) PLAN=platform/docs/plans/agent-tasks.md ;;
  *)                 PLAN=ota/docs/plans/agent-tasks.md ;;
esac

mkdir -p "$REVIEW_DIR"
git clone --quiet "$(git remote get-url origin)" "$REVIEW_DIR/repo"
REPO=(git -C "$REVIEW_DIR/repo")
"${REPO[@]}" remote set-url --push origin no-push-from-review   # any push fails
"${REPO[@]}" fetch --quiet origin "pull/$PR/head"
"${REPO[@]}" checkout --quiet --detach FETCH_HEAD               # the PR head

gh pr diff "$PR" > "$REVIEW_DIR/pr.diff"
gh pr view "$PR" --json number,title,body,headRefOid \
  --jq '"# PR #\(.number): \(.title)\n\nHead: \(.headRefOid)\n\n\(.body)"' > "$REVIEW_DIR/pr.md"
"${REPO[@]}" show origin/main:docs/mvp/runbooks/second-agent-review-prompt.md > "$REVIEW_DIR/prompt.md"
"${REPO[@]}" show "origin/main:$PLAN" \
  | awk -v id="$TASK" 'index($0, "### " id " · ") == 1 { p = 1; print; next } p && /^##/ { exit } p' \
  > "$REVIEW_DIR/task.md"
"${REPO[@]}" show origin/main:docs/mvp/conventions.md \
  | awk '/^## 12\./ { p = 1; print; next } p && /^## / { exit } p' > "$REVIEW_DIR/checklist.md"
"${REPO[@]}" log -1 --format=%h origin/main -- docs/mvp/runbooks/second-agent-review-prompt.md \
  > "$REVIEW_DIR/prompt-version.txt"
```

Check that `task.md` holds the whole task block, `checklist.md` the checklist, `pr.diff` is not empty, and `"${REPO[@]}" rev-parse HEAD` prints the `Head:` of `pr.md` (if the PR got a new commit in between, delete `$REVIEW_DIR` and run §3.1 again). If `gh pr diff` refuses a very large diff, write it from the clone instead: `"${REPO[@]}" diff origin/main...HEAD > "$REVIEW_DIR/pr.diff"`. For a merged PR (the dry run of §5), the same commands work: GitHub keeps `pull/<n>/head` and `gh pr diff` after the merge.

If the diff changes an agent instruction file, read that change yourself before you start the session, because the session may see it while it reads the clone (§3.2). This prints those files, and nothing when there are none:

```bash
grep -nE '^\+\+\+ b/((.*/)?(CLAUDE|AGENTS)\.md|(.*/)?\.claude/.*)$' "$REVIEW_DIR/pr.diff"
```

### 3.2 Start the reviewing session (developer)

The session must be:

- **Fresh.** A new session with no history: not the implementing session, not a resumed or continued one. A different model is welcome but not required; the independence comes from the fresh context and the inputs from `main`.
- **Read-only.** It runs in the agent tool's read-only mode (for Claude Code, plan mode: `claude --permission-mode plan`). When the tool asks to run a command, allow only reading commands (`git diff`, `git log`, `git show`, `git grep`, `ls`, `grep`) and refuse anything that writes, installs, builds, starts a server or reaches the network. It starts in `$REVIEW_DIR`, above the clone, so the tool does not load the PR branch's `CLAUDE.md` or `.claude/` settings at start-up. Claude Code still adds a `CLAUDE.md` of a folder once the session reads files there, so the clone's instruction files can reach the session; the prompt tells it to treat them as data and to report any change to them (prompt §2, G6). The clone cannot push (§3.1).
- **Without credentials or secrets.** The fresh clone has no `.env.local` and no `.local/keys`. The session's environment holds no service credentials (`env | grep -E 'STRIPE|AMADEUS|DATABASE|REDIS|SMTP|SECRET|TOKEN|PASSWORD|_KEY'` shows nothing but the agent's own sign-in) and cannot reach your GitHub login or SSH keys. It needs no network access besides its model: it reads files; it does not install, build, run the apps or call Stripe or Amadeus.

```bash
(cd "$REVIEW_DIR" &&
  env -u GH_TOKEN -u GITHUB_TOKEN -u SSH_AUTH_SOCK GH_CONFIG_DIR="$REVIEW_DIR/.no-gh" \
    claude --permission-mode plan)
```

This is the minimum. A separate OS user or a sandbox without your files gives stronger isolation, because a process running as you could still reach credentials stored in your home folder.

Give it this first message, with the values filled in:

```text
You are the reviewing session of the Velexis second-agent review.
Read <REVIEW_DIR>/prompt.md and follow it exactly.
PR=<PR>  TASK=<TASK>  HEAD_SHA=<head SHA from pr.md>  PROMPT_VERSION=<prompt-version.txt>
REVIEW_DIR=<REVIEW_DIR>  (inputs: pr.diff, pr.md, task.md, checklist.md; repository at the PR head: <REVIEW_DIR>/repo)
```

### 3.3 Output: one PR comment

The session ends with the comment text as its final message, in the format of the prompt's §6: a header (task, PR, reviewed head, prompt version, reviewer), then either the findings, each with **severity, file, line, check and failure scenario**, or the explicit line **`No findings.`**, and in both cases the table of checks with their results. Save it and post it:

```bash
"${EDITOR:-vi}" "$REVIEW_DIR/findings.md"      # paste the session's final message
gh pr comment "$PR" --body-file "$REVIEW_DIR/findings.md"
```

- Post one comment per review, also when it says `No findings.`, so that the PR shows the review ran and what it checked.
- Post it as it is, with one exception: if the text quotes anything that looks like a secret, a token, a card number or personal data (the prompt forbids it), remove the value before posting and treat the quoted item as a high finding.
- **Re-review.** When fixing high findings changed more than the lines they named, or touched another path of the table in §1, run the review again on the new head: delete `$REVIEW_DIR`, repeat §3.1 and §3.2 with the same `PR` (a new session that reads the whole diff again), and post a second comment. The latest comment's findings are the ones that must be closed.
- When the review is done, delete `$REVIEW_DIR`.

## 4. What the developer does with the findings

Severities are defined in the prompt's §5. Before the merge:

| Severity | Required before the merge |
|---|---|
| **high** | Every high finding is **fixed** in the PR (a commit, with the test that now proves it) or **answered** with evidence that it is not a defect (the code path, the test or the ADR that rules it out). No merge with an open high finding; that is also go criterion 5 of every milestone in the roadmap. |
| **medium** | Fixed, answered, or recorded as a follow-up task in the right plan (next free id, plan-lint green) and named in the PR's "Questions and follow-ups". |
| **low** | The developer's choice. No answer needed. |

Record the outcome in the PR:

1. Reply to the findings comment with one line per high and medium finding: `#1 fixed in <sha> (test …)`, `#2 answered: …`, `#3 follow-up OBE-0xx`.
2. Tick the second-agent review checkbox in the PR's security checklist and put the comment's link on that line.
3. Then do your own review against the acceptance criteria and the security checklist, as for every PR.

A finding that turns out to be a false positive is answered once. If the same false positive comes back on later PRs, improve the prompt (§6) instead of answering it again.

## 5. Dry run before the first required use

X-036's acceptance asks for one dry run before M3: run the procedure on one **merged** M2 PR (human step: the developer starts the session), preferably a deep-review one of M2 (OBE-011, OBE-012, OBE-013, OBE-018 or OBE-026). Post the comment on that PR, link it from the X-036 PR, and check that it follows the format of the prompt's §6. If the format or the checks did not work, fix the prompt or this runbook in a docs PR before the first M3 deep-review PR.

## 6. Keeping it current

- The prompt and this runbook change through ordinary docs PRs that the developer reviews. Every review comment names the prompt version it used (the last commit of the prompt file on `main`), so a finding can be traced to the rules that produced it.
- A PR that adds or changes an ADR rule the prompt checks (card handling, idempotency keys, webhook rules, timeout recovery, tenant isolation, tokens) updates the prompt's checks in the same PR.
- Recalibrate after M3: compare the findings with what the developer's own reviews found, and drop checks that never find anything only if an automated test now covers them.
