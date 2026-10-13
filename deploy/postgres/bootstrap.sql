-- =====================================================================================================
-- Velexis database bootstrap: database, the four login roles, base schemas and default privileges.
-- Design: docs/mvp/adr/0004-postgresql-schema-per-tenant.md (Database roles), docs/velexis-sdk/db/README.md §8.
--
-- Run as a superuser with psql variables (idempotent; safe to re-run, passwords are reset each run):
--   psql -v ON_ERROR_STOP=1 -v db_name=velexis \
--        -v migrator_password=... -v provisioner_password=... -v platform_password=... -v ota_password=... \
--        -f deploy/postgres/bootstrap.sql
-- Used by: deploy/scripts/provision-vm.sh (VM), deploy/scripts/dev-setup.sh (local), .github/workflows/ci.yml.
--
-- What it does NOT do: create tables. Migrations create them (platform/reference 0001_baseline, tenant
-- 0001_baseline). The OTA read-only grants on individual platform tables are in the repeatable platform file
-- R__ota_read_access.sql, because the tables do not exist yet (ADR-0021).
-- =====================================================================================================
\set ON_ERROR_STOP on

-- ---- Roles ------------------------------------------------------------------------------------------
-- velexis_migrator:     DDL only, used only by velexis-deploy and local `pnpm db:migrate`. Owns the database,
--                       `platform` and `reference`; member of velexis_provisioner (tenant fan-out with SET ROLE).
-- velexis_provisioner:  OTA worker's tenant provisioning. CREATE on the database, owns every tenant_<key> schema,
--                       no privilege on `platform` or `reference` (ADR-0004). Never serves requests.
-- velexis_platform_app: platform backend API + worker. DML on platform and reference. Nothing on tenants.
-- velexis_ota_app:      OTA backend API + worker. DML on tenant schemas (granted per schema at provisioning),
--                       SELECT on reference, SELECT on selected platform tables (migration), search_path pg_catalog.
SELECT format('CREATE ROLE velexis_migrator LOGIN PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velexis_migrator') \gexec
SELECT format('CREATE ROLE velexis_provisioner LOGIN PASSWORD %L', :'provisioner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velexis_provisioner') \gexec
SELECT format('CREATE ROLE velexis_platform_app LOGIN PASSWORD %L', :'platform_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velexis_platform_app') \gexec
SELECT format('CREATE ROLE velexis_ota_app LOGIN PASSWORD %L', :'ota_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velexis_ota_app') \gexec

SELECT format('ALTER ROLE velexis_migrator WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD %L', :'migrator_password') \gexec
SELECT format('ALTER ROLE velexis_provisioner WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD %L', :'provisioner_password') \gexec
SELECT format('ALTER ROLE velexis_platform_app WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD %L', :'platform_password') \gexec
SELECT format('ALTER ROLE velexis_ota_app WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD %L', :'ota_password') \gexec

-- Leak guard (ADR-0004): the OTA role resolves no schema unless tenantTx sets search_path in the transaction.
ALTER ROLE velexis_ota_app SET search_path = pg_catalog;
-- Never hold a transaction (and its row locks) open while waiting on Amadeus, Stripe or a slow client.
ALTER ROLE velexis_platform_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE velexis_ota_app SET idle_in_transaction_session_timeout = '60s';
-- Migrations wait at most 5 s for a lock (the runner also sets it per file).
ALTER ROLE velexis_migrator SET lock_timeout = '5s';
ALTER ROLE velexis_provisioner SET lock_timeout = '5s';
-- The deploy-time tenant fan-out (velexis_migrator) creates tenant objects as the provisioner, so ownership and
-- default privileges stay with one role (SET LOCAL ROLE velexis_provisioner in packages/db, ADR-0021).
GRANT velexis_provisioner TO velexis_migrator;

-- ---- Database ------------------------------------------------------------------------------------------
SELECT format('CREATE DATABASE %I OWNER velexis_migrator ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0',
              :'db_name', 'UTF8', 'C.UTF-8', 'C.UTF-8')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO velexis_platform_app, velexis_ota_app', :'db_name') \gexec
-- CREATE on the database lets the provisioner create tenant schemas; it gets nothing on platform or reference.
SELECT format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO velexis_provisioner', :'db_name') \gexec
SELECT format('GRANT ALL ON DATABASE %I TO velexis_migrator', :'db_name') \gexec

\connect :db_name

-- Nothing is created in `public`.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ---- Base schemas (the baselines use CREATE SCHEMA IF NOT EXISTS, so these stay owned by the migrator) --
CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION velexis_migrator;
CREATE SCHEMA IF NOT EXISTS reference AUTHORIZATION velexis_migrator;

GRANT USAGE ON SCHEMA platform, reference TO velexis_platform_app;
GRANT USAGE ON SCHEMA reference TO velexis_ota_app;
-- USAGE only. SELECT on the platform tables the OTA backend may read is granted table by table, and
-- column by column on accounts, in platform/backend/migrations/platform/R__ota_read_access.sql (ADR-0004 list).
GRANT USAGE ON SCHEMA platform TO velexis_ota_app;

-- Tables and sequences the migrator creates later get these privileges automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velexis_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA platform
  GRANT USAGE, SELECT ON SEQUENCES TO velexis_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA reference
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velexis_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA reference
  GRANT USAGE, SELECT ON SEQUENCES TO velexis_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA reference
  GRANT SELECT ON TABLES TO velexis_ota_app;

-- Tenant schemas: created by the OTA provisioning job as velexis_provisioner (CREATE SCHEMA ... AUTHORIZATION
-- velexis_provisioner), which then runs
--   GRANT USAGE ON SCHEMA tenant_<key> TO velexis_ota_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenant_<key> TO velexis_ota_app;
--   ALTER DEFAULT PRIVILEGES FOR ROLE velexis_provisioner IN SCHEMA tenant_<key> GRANT ... TO velexis_ota_app;
-- The platform role never receives any privilege on a tenant schema, and the provisioner none on platform.
