# The draft SDK publish workflow and its record (SDK-015)

This folder holds the DRAFT of the workflow that publishes `@velexis/ota-sdk` to npm, `sdk-publish.draft.yml`, and
this file, the record of how the draft came to be, what was checked and what the owner should know (SDK-015,
[ota/sdk/README.md](../README.md) §9). The draft never runs here: GitHub runs only the workflows in
`.github/workflows/`. The owner approves it line by line; on approval it moves unchanged to
`.github/workflows/sdk-publish.yml` (lead decisions (32a) and (32j) of 2026-11-20; the SDK-015 block of
[ota/docs/plans/agent-tasks.md](../../docs/plans/agent-tasks.md)). Neither file is in the npm package: the `files`
field of `ota/sdk/package.json` (`dist`, `src`, `README.md`, `CHANGELOG.md`) leaves this folder out.

**The drafts.** SDK-015 wrote the first draft in wave 60 (243 lines). FIX-W61-SDK revised it in wave 61 for lead
decision (30h) of 2026-11-19 (312 lines, SHA-256 `ece648dff2fa0fa56be858143d6f89dbe5968616081fb11436c9a1a4990f178a`),
and FIX-W62-SDK in wave 62 for lead decisions (31f) to (31h) of 2026-11-19 (322 lines, SHA-256
`6fe2f78f983e6141b6c5ab49a9b5ec16adbfab6c5255acb98fb7411755dbedbb`). In wave 63 FIX-W63-SDK committed the wave 62
draft here byte for byte as `sdk-publish.draft.yml` (lead decision (32j)): the same 322 lines and SHA-256. The wave 60
and wave 61 drafts, the unified diffs between the drafts and the working files of the checks (wave 61's copies of
npm's documentation, the fake registry and OIDC endpoint, the scratch package roots, the runner scripts and their
logs) stayed in the waves' scratch folders and are not kept; the sections below describe them instead of naming
their paths.

Sections 1 to 5 are wave 61's record and "Wave 62" is wave 62's, as written then: "the revised draft" of sections 1
to 5 is the wave 61 draft, and "not committed" was true until wave 63. "Wave 63" records the move to this folder.

## 1. What was read, and when (2026-11-19)

docs.npmjs.com could not be fetched from this session: the session's network policy refuses the host
(`CONNECT tunnel failed, response 403`, also from the fetch tool). The pages were read instead from their source in
npm's documentation repository, which docs.npmjs.com is built from, through raw.githubusercontent.com, on
2026-11-19 at about 19:12 UTC (SHA-256 of wave 61's copies in brackets; the copies are not kept):

| Page on docs.npmjs.com | Source read |
|---|---|
| https://docs.npmjs.com/trusted-publishers | https://raw.githubusercontent.com/npm/documentation/main/content/packages-and-modules/securing-your-code/trusted-publishers.mdx (`eb5a16e4…b583`) |
| https://docs.npmjs.com/generating-provenance-statements | https://raw.githubusercontent.com/npm/documentation/main/content/packages-and-modules/securing-your-code/generating-provenance-statements.mdx (`1cb28a3d…3f`) |
| https://docs.npmjs.com/about-access-tokens | https://raw.githubusercontent.com/npm/documentation/main/content/integrations/integrating-npm-with-external-services/about-access-tokens.mdx (`6e79564d…021c`) |
| https://docs.npmjs.com/creating-and-viewing-access-tokens | https://raw.githubusercontent.com/npm/documentation/main/content/integrations/integrating-npm-with-external-services/creating-and-viewing-access-tokens.mdx (`c6c774c2…bfc2`) |
| https://docs.npmjs.com/staged-publishing | https://raw.githubusercontent.com/npm/documentation/main/content/packages-and-modules/securing-your-code/staged-publishing.mdx (`896866a1…15d`) |

Also read: the npm CLI that Node 24 ships, npm 11.19.1 (`/opt/node24/lib/node_modules/npm`): `lib/utils/oidc.js`,
`lib/commands/publish.js`, `lib/commands/trust/github.js`, `lib/trust-cmd.js`, `docs/content/commands/npm-trust.md`
and `npm-stage.md`, `node_modules/@npmcli/config/lib/env-replace.js` and `lib/index.js`, `node_modules/libnpmpublish`
11.2.0 `lib/publish.js`; and actions/setup-node at the commit ci.yml pins
(https://raw.githubusercontent.com/actions/setup-node/49933ea5288caeca8642d1e84afbd3f7d6820020/src/authutil.ts,
`f7d60bf5…d491`).

## 2. What trusted publishing needs, and how npm 11.19.1 behaves

1. **Requirements.** npm CLI 11.5.1 or later and Node 22.14.0 or later (trusted-publishers.mdx:9); GitHub-hosted
   runners only, no self-hosted ones (:23-27); `id-token: write` in the job (:111, :131); on npmjs.com, in the
   package's settings, a trusted publisher of type GitHub Actions naming the owner, the repository, the workflow's
   file name only (`sdk-publish.yml`, which must be in `.github/workflows/`) and, optionally, the environment
   (:45-52). Configurations created after 2026-09-03 allow `npm stage publish` by default; `npm publish` must be
   allowed explicitly (:92). A new configuration must complete a publish within 2 days or it expires (:232-234).
   `package.json`'s `repository.url` must match the GitHub repository exactly (:368; case-sensitive,
   generating-provenance-statements.mdx:39). With `workflow_dispatch` the trusted publisher is matched against the
   dispatched workflow's file (:374): sdk-publish.yml itself.
2. **Provenance.** Automatic with trusted publishing from GitHub Actions (trusted-publishers.mdx:266), only from a
   public repository for a public package (:276-281). In npm 11.19.1 it is switched on only when `provenance` is not
   configured, the OIDC token says `repository_visibility: public` and the registry says the package is public
   (oidc.js:144-168), so never for the first version of a new package. The draft keeps `--provenance` explicit: then
   libnpmpublish always makes the statement (publish.js:137-160) and refuses the publish if it cannot
   (`id-token: write` missing: :180-187). The repository is public (checked 2026-11-19).
3. **Which credential npm uses.** `npm publish` runs the OIDC exchange before it reads its credentials
   (publish.js:147-150); only on GitHub Actions, GitLab and CircleCI (oidc.js:28-37). Every failure of the exchange is
   silent apart from npm's verbose or silly log, and npm then goes on with whatever token its configuration holds:
   no `id-token: write` (oidc.js:63-69), no ID token (:95-111), the registry refusing the exchange (:119-128), no
   token in the answer (:130-133), anything else (:169-171). A successful exchange replaces the configured token for
   the publish (oidc.js:140-141).
   - **NODE_AUTH_TOKEN empty**: setup-node's `.npmrc` line `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`
     (authutil.ts:47-53) gives an empty token, which is no credential (config/lib/index.js:895-898): a real publish
     stops with `ENEEDAUTH` (publish.js:161-166), a dry run only warns and goes on (publish.js:163-164).
   - **NODE_AUTH_TOKEN unset**: npm keeps `${NODE_AUTH_TOKEN}` literally (env-replace.js:7-8) and sends it as the
     token. setup-node itself exports the placeholder `XXXXX-XXXXX-XXXXX-XXXXX` when the variable is unset when it
     runs (authutil.ts:54-58), which npm also sends.
   - **Both an OIDC token and NODE_AUTH_TOKEN**: the trusted publisher's token wins when the exchange succeeds; when it
     fails, npm publishes with NODE_AUTH_TOKEN without saying so at the default log level.
   Proven against a fake registry and OIDC endpoint (a scratch experiment of wave 61, not kept), each case
   one `npm publish` of npm 11.19.1 with setup-node's `.npmrc`:
   | Case | Result |
   |---|---|
   | A exchange works, NODE_AUTH_TOKEN set | uploaded with the OIDC token |
   | B exchange refused, NODE_AUTH_TOKEN set | uploaded with NODE_AUTH_TOKEN, exit 0 |
   | C exchange refused, NODE_AUTH_TOKEN="" | `ENEEDAUTH`, nothing uploaded, exit 1 |
   | D exchange refused, NODE_AUTH_TOKEN unset | uploaded with the bearer token `${NODE_AUTH_TOKEN}` |
   | E exchange refused, setup-node's placeholder | uploaded with the bearer token `XXXXX-XXXXX-XXXXX-XXXXX` |
   | F no `id-token: write`, NODE_AUTH_TOKEN set | no exchange tried, uploaded with NODE_AUTH_TOKEN |
   | G exchange works, NODE_AUTH_TOKEN="" | uploaded with the OIDC token |
   | H dry run, exchange refused, NODE_AUTH_TOKEN="" | warning only, exit 0 |
   | I dry run, exchange works, NODE_AUTH_TOKEN="" | `npm verbose oidc Successfully retrieved and set token`, exit 0 |
   No output of any case contains the exchanged token.
4. **A package that has never been published.** A trusted publisher cannot be configured for it: npm 11.19.1's own
   documentation of `npm trust` says "Package must exist: The package you're configuring must already exist on the
   npm registry" (docs/content/commands/npm-trust.md:19), and the website's steps start from the package's settings
   page (trusted-publishers.mdx:37, :220). So 1.0.0 needs the fallback token of (30h), and trusted publishing starts
   with the next release.
5. **The fallback token.** npm removed legacy tokens, automation tokens included, in November 2025; only granular
   access tokens remain (about-access-tokens.mdx:16). A granular token for this needs read and write access to the
   scope `@velexis` (the package does not exist yet), the shortest expiry (at least 1 day,
   creating-and-viewing-access-tokens.mdx:54) and, for a publish from CI, "Bypass 2FA" (about-access-tokens.mdx:39,
   :45). **npm removes direct publishing with granular tokens in January 2027** (about-access-tokens.mdx:80-82);
   after that a token can only stage a version (`npm stage publish`, a stage-only token) for a maintainer to approve
   with 2FA. See §5.

## 3. Changes from the wave 60 draft, line by line (line numbers of the wave 61 draft)

| Lines | Change | Why |
|---|---|---|
| 1-2 | The DRAFT line names the revision (FIX-W61-SDK, decision (30h)). | Which version the owner approves. |
| 7-10 | The header says the repository must be the one the workflow runs in, and that a trusted-publishing dry run checks the trusted publisher's token. | The two new checks (lines 111-122, 258-264). |
| 12-16 | New: the credential paragraph, `credential` input, trusted publishing first, NPM_TOKEN of the environment `npm` for 1.0.0 only and why. | (30h); §2.4. |
| 17-21 | `publish` has `id-token: write` "for the trusted publisher's token and the provenance statement"; "the npm token of the environment `npm`" removed. | The token is no longer the default credential. |
| 33-39 | New input `credential` (choice: `trusted-publishing`, the default, or `npm-token`). | (30h) asks for the fallback from the same file without editing it, chosen by an input or by the secret's presence. The input is the safe choice: with the secret's presence deciding, a token left in the environment would publish silently whenever the exchange fails for any reason (§2.3, case B), hide a broken trusted publisher, and sit in every trusted run's environment. With the input, a trusted-publishing run has no token at all (case C: it stops with `ENEEDAUTH`), and the secret is read only by a run that asks for it. |
| 86-91 | The readiness step gets `REPOSITORY` (`github.repository`) and `SERVER_URL` (`github.server_url`) instead of one `REPOSITORY_URL`. | It compares with the repository the run belongs to. |
| 99 | Reads the two variables. | Same. |
| 111-122 | `repository.url` must be exactly `git+<server>/<owner>/<repository>.git` of this run (letter case included), the form (30h) decided (`git+https://github.com/bhagwati-prasad/velexis-ota.git` on github.com); `type` must be `git` and `directory` `ota/sdk`. A mismatch names both values. Wave 60's check stripped `git+` and `.git` and compared the rest. | (30h) fixes the field; npm compares the URL exactly (§2.1); a fork's or a mistyped URL is refused before anything is built. |
| 181-182 | The `environment: npm` comment: the trusted publisher names the environment; NPM_TOKEN is the 1.0.0 fallback. | (30h). |
| 186-188 | The `id-token: write` comment: the OIDC token is exchanged for the publish token and signs the provenance statement. | Its two uses now. |
| 196 | setup-node's comment: the publish step sets NODE_AUTH_TOKEN. | The token is no longer set in the step's `env`. |
| 212-220 | New step: npm must be 11.5.1 or later. | Trusted publishing's minimum (§2.1). The runner's Node 24 from `.nvmrc` ships a newer npm (11.19.1 here); the check makes a downgrade fail clearly instead of as `ENEEDAUTH`. |
| 223-227 | The publish step's `env`: `CREDENTIAL`; `NPM_TOKEN_FALLBACK` is the secret only when `credential` is `npm-token` and empty otherwise; `NODE_AUTH_TOKEN: secrets.NPM_TOKEN` removed. | The secret is not even in a trusted-publishing run's environment. |
| 229-251 | The step sets NODE_AUTH_TOKEN in its own shell: `""` for trusted publishing (with `--loglevel verbose`, so the job log shows npm's oidc lines), the secret for `npm-token` (refused when the environment has none), and refuses an unknown value. | Empty, not unset: an unset variable and setup-node's placeholder are both sent as tokens (§2.3, cases D and E); an export in the script wins over setup-node's exported placeholder whatever the precedence of step `env` and `GITHUB_ENV`. |
| 252-256 | One argument list; a real run is `npm publish <tarball> --provenance --access public`. | As before, with the log level. |
| 257-264 | A dry run is piped to a log; with trusted publishing the step fails unless npm logged `verbose oidc Successfully retrieved and set token` (oidc.js:142). | A dry run needs no credential and only warns when the exchange fails (§2.3, case H), so without this check the dry run would pass and the real run fail. The line is npm's own wording; if a later npm changes it, the dry run fails (safe side) and the grep is updated. |

Unchanged: the trigger and `dry_run` (on by default), `permissions: {}`, the concurrency group, the tag and main
checks, the private and licence checks, the CHANGELOG check, the SDK's tests, build and size check, one tarball packed
once, the refusal of declarations that name `@velexis/api-types`, the SRI hash from the packed tarball, the artifact,
the integrity check in `publish`, `--provenance --access public`, the release job and its notes, per-job permissions
and every action pin.

## 4. Checks run on the revised draft (the wave 61 draft)

- `actionlint` 1.7.12 with shellcheck 0.11.0 and with shellcheck 0.9.0: no findings (and the repository's workflows:
  none). A planted unquoted variable is reported, so shellcheck ran.
- Pins: `node tools/ci/check-package-json.mjs --root <scratch root>` (a scratch root with the draft in
  `.github/workflows/`): 0 problems; with `pnpm/action-setup@v5` planted: 1 problem. A scratch script that compares
  the pins (not kept): all 5 actions carry the same commit and tag as the repository's workflows (checkout,
  setup-node and pnpm/action-setup as ci.yml; upload-artifact and download-artifact as deploy.yml).
- Prettier with the repository's configuration (`--stdin-filepath .github/workflows/sdk-publish.yml`): no change.
- The readiness step, extracted from the YAML (a scratch runner and its log, not kept): today's package
  fails with five errors (private, licence `UNLICENSED`, repository missing, its type and directory missing, CHANGELOG
  section not dated); a ready mock (`git+https://github.com/bhagwati-prasad/velexis-ota.git`, `type`, `directory`,
  dated section) passes; the same mock run as another repository fails; mocks with another repository, other letter
  case, a URL without `git+` and `.git`, a string `repository` and no `directory` fail; a commit not on main fails.
- The pack step (a scratch runner and its log, not kept) on a copy of today's built package: passes (tarball, sha512
  integrity, IIFE SRI hash); a declaration that imports `@velexis/api-types/ota` and a missing
  `dist/types/api-types.d.ts` both fail.
- The publish job's two new steps (a scratch runner and its log, not kept) against the fake registry, with a job
  environment like GitHub's (`id-token: write`, setup-node's `.npmrc` and placeholder): npm 11.19.1 passes the version
  check; trusted-publishing dry run with a working exchange passes; with a refused exchange it fails with the error;
  a real trusted-publishing run with a refused exchange stops with `ENEEDAUTH` and uploads nothing (no fallback); an
  `npm-token` run without the secret fails; with it the dry run passes using the token; an unknown credential fails.
  No trusted-publishing request carried the secret, and no output contains the exchanged token.

## 5. For the owner

- **Before 1.0.0** (README §9): the npm organisation `velexis`; a granular access token with read and write on the
  scope `@velexis`, Bypass 2FA, the shortest expiry, stored as the secret `NPM_TOKEN` of the environment `npm`; run
  the workflow with `credential: npm-token`.
- **Right after 1.0.0**: on npmjs.com, @velexis/ota-sdk, Settings, Trusted publishing, GitHub Actions: organisation or
  user `bhagwati-prasad`, repository `velexis-ota`, workflow file `sdk-publish.yml`, environment `npm`, allowed
  actions including `npm publish`; publish the next version within 2 days (or recreate the configuration); then
  "Require two-factor authentication and disallow tokens", delete the secret and revoke the token.
- **Decision needed: January 2027.** npm's documentation says direct publishing with granular tokens is removed in
  January 2027 (about-access-tokens.mdx:80-82). If 1.0.0 is published after that, the fallback cannot `npm publish`;
  it could stage 1.0.0 with a stage-only token (`npm stage publish`, which this draft does not run) for the owner to
  approve with 2FA on npmjs.com. The website says staging a package that does not exist yet publishes a placeholder
  version `0.0.0-stage` (staged-publishing.mdx:9), while npm 11.19.1's `npm stage` documentation says the package must
  exist (npm-stage.md:53); this was not tried.
- **What the trusted-publishing dry run does not prove.** It proves that npm got the trusted publisher's token (the
  exchange matched this repository, `sdk-publish.yml` and the environment `npm`), not which actions that trusted
  publisher allows. npm's documentation does not say whether a trusted publisher that allows only `npm stage publish`
  (the default of configurations created after 2026-09-03, trusted-publishers.mdx:92) refuses the exchange or only the
  upload; if only the upload, the dry run passes and the real run fails without publishing anything. So `npm publish`
  must be ticked when the trusted publisher is added (README §9 step 5).
- **`npm-token` is not limited to 1.0.0 by the workflow itself.** The draft documents "1.0.0 only" in its input's
  description and header but does not refuse `npm-token` for another version. What ends the fallback is the token's
  short expiry and README §9 step 5 (the secret deleted and the token revoked after the first trusted release).

(Review note of 2026-11-19, FIX-W61-SDK's reviewer: the two points above were added to this file; the wave 61 draft
itself is unchanged, SHA-256 `ece648df…178a` as above.)

## Wave 62 (FIX-W62-SDK, lead decisions (31f), (31g) and (31h) of 2026-11-19)

The wave 62 draft (322 lines, SHA-256 `6fe2f78f983e6141b6c5ab49a9b5ec16adbfab6c5255acb98fb7411755dbedbb`), since
wave 63 `sdk-publish.draft.yml` in this folder, is the wave 61 draft (312 lines, not kept) with the changes below,
which list every changed line (the unified diff was a working file of wave 62, not kept). Nothing was written under
`.github/`; the draft is still for the owner's line-by-line approval, and in wave 62 it was not committed.

### The decisions

- **(31f)** 1.0.0 is published before January 2027, when npm removes direct publishing with granular access tokens
  (about-access-tokens.mdx:80-82, §2.5 above): the owner's licence choice (H-14), the npm organisation, the approval
  of this draft's lines, the release commit on `main` and the publish happen in December 2026, ahead of the launch
  block. If that slips, a later wave adds a staging path (`npm stage publish`, approved by the owner with 2FA) to the
  draft; there is no staging path now. This settles §5's "Decision needed: January 2027".
- **(31g)** The draft refuses the credential `npm-token` for any version other than 1.0.0, enforcing (30h)'s
  "1.0.0 only" in code. This settles §5's last point ("`npm-token` is not limited to 1.0.0 by the workflow itself").
- **(31h)** The trusted-publishing dry run's dependency on npm's verbose log line
  (`verbose oidc Successfully retrieved and set token`, oidc.js:142) is accepted: if npm rewords it, the dry run
  fails, which is the safe side. No line changes for it.

### Changes from wave 61's draft, line by line (line numbers of the wave 62 draft, `sdk-publish.draft.yml`)

| Lines | Change | Why |
|---|---|---|
| 1-2 | The DRAFT line also names FIX-W62-SDK and decision (31g). | Which revision the owner approves. |
| 7-11 | The header's list of what a run refuses ends with "and the credential npm-token for any version but 1.0.0" (the sentence is re-wrapped, its other words unchanged). | (31g), in the one place that lists every refusal. |
| 17-19 | The credential paragraph adds that the check job refuses `npm-token` for any other version (31g), and that npm ends direct publishing with granular tokens in January 2027, so 1.0.0 is published before then (31f). | The person approving the lines sees why the token is for 1.0.0 only and when it would stop working. The workflow does not check the date: npm itself refuses the token then, and (31f) puts a staging path in a later wave if needed. |
| 88 | The readiness step's name becomes "Check that the tag's commit is on main and that the package and the credential are ready for this version". | The step now checks the run's input as well as the package. |
| 91 | The step's `env` gets `CREDENTIAL: ${{ inputs.credential }}`. | The script reads the input from its environment, as it reads `VERSION`, never from an expression inside the script. |
| 103 | The script reads `CREDENTIAL` with the other variables. | Same. |
| 106-110 | New: when the credential is `npm-token` and the version is not `1.0.0`, the step records the problem "The credential npm-token publishes 1.0.0 only (lead decisions (30h) and (31g)), not X.Y.Z: run this workflow with the credential trusted-publishing, through the trusted publisher that ota/sdk/README.md §9 step 5 adds after 1.0.0", printed as `::error::` with the step's other problems, and fails. | (31g). It is the check job's third step, after the tag check and the checkout and before anything is installed, tested, built or packed, and the `publish` job (`needs: check`), the only job with the environment `npm` and so the only one that can read `NPM_TOKEN`, never starts after it: a refused run never reads the secret. The version is the tag's, `X.Y.Z` with no pre-release part (the tag step's pattern `^sdk-v([0-9]+\.[0-9]+\.[0-9]+)$`), which the same step requires `package.json` to name, so a string comparison with `1.0.0` is exact. A dry run is refused too: `dry_run` does not change what a run may publish with. |
| 249 | A comment in the publish step's `npm-token` branch: 1.0.0 only, the check job refused this credential for any other version. | A reader of the publish step sees where the version is enforced; the step's commands are unchanged. |

Unchanged: every other line, so every property §3 lists, and in particular the input `credential` (its values and
the default `trusted-publishing`), `dry_run` on by default, the trusted-publishing dry run's check of npm's log line
(31h), the token decided in the publish step's own shell (empty for trusted publishing), one tarball packed once and
checked by integrity in `publish`, the SRI hash from the packed file, `--provenance --access public`, per-job
permissions and every action pin.

### Checks run on the wave 62 draft (2026-11-20, Node v24.22.3, npm 11.19.1)

- **actionlint** 1.7.12 with shellcheck 0.11.0 and with shellcheck 0.9.0 (`/usr/bin/shellcheck`): no findings. A
  scratch copy with a planted unquoted variable (not kept) is reported by both (SC2086), so shellcheck ran.
  The repository's workflows: no findings.
- **Prettier** with the repository's configuration (`--stdin-filepath .github/workflows/sdk-publish.yml`): no change
  (Prettier's output was identical to the draft).
- **Pins**: `node tools/ci/check-package-json.mjs --root <scratch root>` (a scratch root with the draft in
  `.github/workflows/`): 0 problems; the same with `pnpm/action-setup@v5` planted: 1 problem
  ("is not pinned to a full 40-character commit SHA (ADR-0023)"). A scratch script that compares the pins (not kept):
  all 5 actions carry the same commit and tag as the repository's workflows (checkout, setup-node and
  pnpm/action-setup as ci.yml; upload-artifact and download-artifact as deploy.yml).
- **The readiness step**, extracted from the YAML by its name (wave 61's scratch runner with a version and a
  credential per case, run twice with the same results; the runner and its logs are not kept), on scratch git
  repositories with today's `package.json` and CHANGELOG edited per case ("ready": not private, a licence, the
  repository field of (30h), a dated section; "ready-1.0.1" and "ready-1.1.0": the same with that version and its own
  dated section above 1.0.0's):

  | Case | Credential | Result |
  |---|---|---|
  | ready, 1.0.0 | npm-token | passes (exit 0) |
  | ready-1.0.1, 1.0.1 | npm-token | refused (exit 1), the one error above naming 1.0.1 |
  | ready-1.0.1, 1.0.1 | trusted-publishing | passes |
  | ready-1.1.0, 1.1.0 | npm-token | refused, the same error naming 1.1.0 |
  | ready-1.1.0, 1.1.0 | trusted-publishing | passes |
  | ready, 1.0.0 | trusted-publishing | passes |
  | 1.0.1 without a dated section | npm-token | refused with both errors (the credential's and the CHANGELOG's) |
  | today's package, 1.0.0 | npm-token | wave 61's five package errors, no credential error |

  Wave 61's cases, run again with `trusted-publishing`, give wave 61's results (today's package: five errors; ready
  as another repository, another repository's URL, other letter case, a URL without `git+` and `.git`, a string
  `repository`, no `directory`: refused; a commit not on main: refused).
- **Before the change**: the same runner on wave 61's draft (given that draft's step name; log not kept): 1.0.1 and
  1.1.0 with `npm-token` pass (exit 0), the gap (31g) closes; every other case as above without the credential error.
- **The publish job's two steps** (a scratch runner and its log, not kept) against a copy of wave 61's fake registry
  and OIDC endpoint with wave 61's 1.0.0 tarball: P1 to P6 give wave 61's results (trusted-publishing dry run passes
  with a working exchange and fails with a refused one; a real trusted-publishing run with a refused exchange stops
  with `ENEEDAUTH`; `npm-token` without the secret fails and with it the dry run uses the token; an unknown credential
  fails); no trusted-publishing request carried the secret and no output contains the exchanged token. The registry
  process was stopped afterwards.

### For the owner

- **The calendar (31f).** In December 2026, ahead of the launch block: choose the licence (H-14); create the npm
  organisation `velexis`; approve this draft's lines (it is then committed as `.github/workflows/sdk-publish.yml`);
  make the release commit on `main` (README §9 step 1: version, dated CHANGELOG section, no `"private"`, the licence,
  the `repository` field); tag `sdk-v1.0.0`; create the short-lived granular token and store it as `NPM_TOKEN` of the
  environment `npm`; run the workflow with `credential: npm-token`, first with `dry_run` on, then off. If any of that
  slips into January 2027, the token can no longer publish directly, and a later wave adds the staging path first.
- **After 1.0.0** (README §9 step 5, unchanged): the trusted publisher with `npm publish` allowed, a release through
  it within 2 days, then tokens disallowed, the secret deleted and the token revoked. From 1.0.1 on the workflow
  accepts only `credential: trusted-publishing`.
- **Still as §5 says**: what the trusted-publishing dry run does not prove (whether the trusted publisher allows
  `npm publish`, not only `npm stage publish`), so `npm publish` must be ticked when it is added.
- **`main` first** (review note of 2026-11-20, FIX-W62-SDK's reviewer). The readiness check refuses a tag whose commit
  is not on `main` (line 97), and `main` does not hold the SDK yet (its last merge is PR #1 of 2026-10-13). So before
  the release commit of December 2026, the integration branch reaches `main` once with a merge commit, after the
  developer's own deep review of X-037, X-038, X-039 and X-041 (ADR-0028 items 1 and 2, X-019 step 5). The draft is
  unchanged by this note (SHA-256 as above).

## Wave 63 (FIX-W63-SDK, lead decisions (32a) and (32j) of 2026-11-20)

- **(32j)** The draft and this record get a durable home that never runs: `ota/sdk/release/sdk-publish.draft.yml` and
  this file, both in SDK-015's Files. Not under `.github/`: GitHub runs only `.github/workflows/`. Not in the npm
  package: its `files` field (`dist`, `src`, `README.md`, `CHANGELOG.md`) leaves `release/` out. The draft is the wave
  62 file byte for byte (322 lines, SHA-256 `6fe2f78f983e6141b6c5ab49a9b5ec16adbfab6c5255acb98fb7411755dbedbb`, the
  same as the source's); no line changed, so its first lines still say it is not in `.github/workflows/` until
  approved. The root `.gitignore` ignores every `release/` folder (the output of `deploy/scripts/pack-release.sh`), so
  it gains `!/ota/sdk/release/`, as it re-includes `deploy/caddy/build/`.
- **(32a)** The order of the December 2026 steps (what the owner does now in parallel, main protected, the integration
  branch merged into main by about 4 December, the release task that can ride that merge, the publish by about 18
  December with 31 December the hard limit, the checkpoint of Friday 11 December, no staging path now) is in
  SDK-015's dated note of 2026-11-20 in `ota/docs/plans/agent-tasks.md` and, in one sentence, in
  [ota/sdk/README.md](../README.md) §9 step 1. It refines the calendar of "For the owner" above, which otherwise
  stands.

### Checks (2026-11-20, Node v24.22.3, npm 11.19.1)

- **actionlint** 1.7.12 on `ota/sdk/release/sdk-publish.draft.yml` with shellcheck 0.11.0 and with shellcheck 0.9.0
  (`/usr/bin/shellcheck`): no findings (exit 0). A scratch copy at the same relative path with
  `echo ::error::The commit of $GITHUB_REF_NAME is not on main` planted in line 98 is reported by both (SC2086,
  line 96's `run`), so shellcheck ran.
- **The pins** are still the repository's: each of the 5 actions carries the same commit and tag as `ci.yml`
  (checkout, setup-node, pnpm/action-setup) and `deploy.yml` (upload-artifact, download-artifact). Dependabot's
  github-actions entry (`.github/dependabot.yml`, directory `/`) reads only `.github/workflows/`, so it never updates
  the draft's pins here: when it moves an action of `ci.yml` or `deploy.yml` (or ADR-0029's later move to v5 does),
  the draft keeps the old commit until someone compares the pins again, as README §9 step 3 says before the move.
- **`npm pack --dry-run`** in `ota/sdk`: 80 files, under `CHANGELOG.md`, `README.md`, `dist/`, `package.json` and
  `src/`; none under `release/`.
- **The repository checks** at this path: Prettier checks the draft here (not git-ignored, a `.yml` file) and finds
  no change (`pnpm format:check` passes; this `.md` file is in `.prettierignore`, as every Markdown file is);
  `check-package-json.mjs` reads only `.github/workflows/` and `.github/actions/` (18 package.json files, 3 workflow
  files, 0 problems) and `check-no-hardcoded-hosts.mjs` only the `src` folders (0 problems), so neither reads the
  draft; `ci.yml`'s repository guards pass; `eslint tools/ci` and `node --test tools/ci/*.test.mjs` (86 tests) pass.
