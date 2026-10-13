-- OTA backend read access: SELECT for velexis_ota_app on the baseline platform tables it needs.
--
-- Repeatable migration (ADR-0021). The runner of @velexis/db applies it after all numbered platform files of a
-- run, and only when its SHA-256 differs from its row in platform.schema_migrations (id R__ota_read_access,
-- phase "repeatable"): on a fresh database, then again after each edit. Unlike a numbered file it MAY be edited:
-- the edit is applied on the next `pnpm db:migrate` or velexis-deploy run. It may contain only GRANT, REVOKE and
-- COMMENT ON statements (the runner rejects anything else), and every statement is idempotent, so applying the
-- file twice changes nothing.
--
-- What it grants is the list of ADR-0004 (Database roles), nothing more. The OTA backend never writes a platform
-- table (ADR-0003), so it gets SELECT only:
--   - the tables tenants, tenant_domains, api_keys, api_key_tenant_grants, tenant_memberships, plans,
--     supplier_connections and payment_provider_connections;
--   - on accounts, only the columns id, email, email_verified_at, full_name, locale, time_zone, mfa_enabled,
--     status, deleted_at and version. accounts never gets a table-level SELECT: it would cover every column,
--     including the ones added later.
--
-- Never granted (ADR-0004, ADR-0021): the secrets and hashes of accounts (password_hash, mfa_secret_ciphertext,
-- encryption_key_id) and its security counters and flags (failed_login_count, locked_until, is_platform_admin).
-- The OTA backend never verifies portal passwords or TOTP codes: staff reach the OTA admin with the platform's
-- one-time console token. If a password grant for third-party consoles is built later, the platform verifies
-- the credentials, not the OTA backend (ADR-0008), so these columns stay out of this file.
-- The other platform tables (subscriptions, invoices, account_sessions, tenant_invitations,
-- tenant_schema_migrations, provisioning_jobs, platform_audit_log, schema_migrations) are not readable either.
-- packages/db/test/integration/baselines.int.test.ts proves every denial with a "permission denied" error.
--
-- Changing it:
--   - a platform migration that adds a table or column the OTA backend must read grants it in that numbered
--     file (conventions §9) or extends this file in the same pull request; the shared Amadeus account tables of
--     ADR-0012 are granted by 0002_add_mvp_platform_deltas.sql;
--   - an unchanged file does not run again, so a numbered file that drops and re-creates a table listed here
--     must grant it again itself (or the same pull request edits this file);
--   - GRANT only adds: deleting a name from a list below revokes nothing. Withdraw a privilege with an explicit
--     REVOKE, and check the numbered files first, because this file runs after them and a REVOKE here would
--     undo their grants on every fresh database.
-- Schema USAGE for velexis_ota_app and its search_path (pg_catalog) come from deploy/postgres/bootstrap.sql.

GRANT SELECT ON platform.tenants, platform.tenant_domains, platform.api_keys, platform.api_key_tenant_grants,
  platform.tenant_memberships, platform.plans, platform.supplier_connections,
  platform.payment_provider_connections
  TO velexis_ota_app;

GRANT SELECT (id, email, email_verified_at, full_name, locale, time_zone, mfa_enabled, status, deleted_at, version)
  ON platform.accounts
  TO velexis_ota_app;
