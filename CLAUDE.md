# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first: it is the operating manual for every AI agent in this repository (read order, picking tasks, definition of done, commands).

The five most important rules:

1. **Decisions win.** [`docs/mvp/decisions.md`](docs/mvp/decisions.md), then the ADRs in [`docs/mvp/adr/`](docs/mvp/adr/README.md), override everything else, including your own preferences and the plans. If a task conflicts with them, stop and ask.
2. **One task = one branch (`task/<ID>-<slug>`) = one PR.** Pick tasks in milestone order whose dependencies are merged. Touch only the task's **Files**. Never merge, never push to `main`.
3. **Contract first.**
   - Change the OpenAPI document and regenerate types before writing handlers.
   - The SDK's JSDoc types must match `docs/velexis-sdk/sdk/src/*.d.ts`. Never edit those contract files or the reference SQL.
4. **Done means proven.**
   - The Verify command, `pnpm lint`, `pnpm typecheck` and `pnpm test` (and `pnpm test:int` for backend changes) pass.
   - Docs, ADRs and the plan status are updated.
   - **Never delete, skip or weaken a test** to get green.
5. **Security is not optional.**
   - No secrets in code.
   - Never log or store card data, tokens or passwords.
   - Tenant data only through `tenantTx`.
   - The platform never touches tenant schemas, and the OTA backend never writes platform tables.
   - No tokens readable by browser JavaScript.
