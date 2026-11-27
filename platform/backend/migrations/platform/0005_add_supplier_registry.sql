-- velexis:phase expand
-- Add the supplier registry and tie the supplier connections and the Velexis Amadeus accounts to their supply sources

-- PBE-078 (ADR-0030 items 2, 3 and 11; PADR-0020 items 1, 2 and 5, and items 7 to 9; multi-supplier plan §4.4;
-- platform/docs/data-model.md §4.11). A supply source is one supplier used through one account: one of Velexis's
-- accounts, which serves every OTA that Velexis supplies, or an OTA's own. Four tables hold the registry:
--   - suppliers: the suppliers the platform knows (amadeus, pkfare);
--   - supplier_environments: the global switch of a supplier in one environment (PBE-081 changes it);
--   - supply_sources: the sources, each with its supplier, environment and owner, and the stop of sales that staff,
--     the wallet watch or a balance refusal set on a source (PBE-081, PBE-087, X-066);
--   - supply_source_ids: every supply id a source has had (`sup_` plus 16 random base32 characters, no ULID), the
--     current one with no retirement date; an id is unique for ever (PBE-080 rotates and resolves them).
-- A source's own id is a prefixed ULID, `ssr_` (PLATFORM_ID_PREFIXES). The supply id is the opaque id that OTAs see.
--
-- supplier_connections gains its supply source (nullable: the previous release and the inserts of today's tests do
-- not write it; PBE-106 makes it NOT NULL in a later release) and the per-tenant switch (NOT NULL, on by default, so
-- the same writers keep working). `provider` gets a foreign key to suppliers in place of its CHECK and keeps
-- DEFAULT 'amadeus' (PBE-106 drops the default). The unique key gains credential_source, so an OTA can later hold a
-- Velexis row and an own row of one supplier and environment (PBE-103). supplier_connections_source_ck is rewritten
-- for the other suppliers: a Velexis row of another supplier names no Amadeus account, it reaches its account through
-- its supply source. amadeus_accounts gains the account's supply source, as supplier_accounts will (PBE-079).
--
-- Existing rows (platform rows, not tenant data, so the backfill runs here; conventions §9): one source per Velexis
-- Amadeus account and one per `tenant` connection, each with one supply id drawn in SQL from gen_random_uuid() (core
-- PostgreSQL 16; pgcrypto is not installed). A `velexis` connection shares its account's source. Every connection is
-- switched on by the column's default. The rows keep their `version` and `updated_at`: nothing the API answers
-- changes. A last check stops the migration if a connection or an account is left without a source, or a source
-- without exactly one current supply id.

-- The suppliers. A supplier's id is a short lower-case name, not a ULID; the OTA backend's adapters are registered
-- under the same names.
CREATE TABLE platform.suppliers (
  id         text PRIMARY KEY CONSTRAINT suppliers_id_ck CHECK (id ~ '^[a-z][a-z0-9]{1,31}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.suppliers IS 'Flight content suppliers the platform knows; every supply source and connection names one.';
COMMENT ON COLUMN platform.suppliers.id IS 'Supplier id, a short lower-case name (amadeus, pkfare); supplier_connections.provider refers to it.';
COMMENT ON COLUMN platform.suppliers.name IS 'Name shown to Velexis staff in the platform admin, never to an OTA on Velexis supply.';
COMMENT ON COLUMN platform.suppliers.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.suppliers.updated_at IS 'Last modification time.';

INSERT INTO platform.suppliers (id, name) VALUES ('amadeus', 'Amadeus'), ('pkfare', 'PKFare');

-- The global switch per supplier and environment. Off leaves every source of the supplier in that environment out of
-- new searches, pricing and checkout, the OTAs' own accounts included; existing bookings are still served (PADR-0020
-- item 9). Amadeus sells today in both environments, so it starts on; PKFare starts off in both: in `live` until
-- PKFare certifies Velexis (ADR-0030 item 28), and in `test` until staff switch it on with a reason (PBE-081).
CREATE TABLE platform.supplier_environments (
  supplier_id   text NOT NULL REFERENCES platform.suppliers (id) ON DELETE RESTRICT,
  environment   text NOT NULL CHECK (environment IN ('test','live')),
  sales_enabled boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, environment)
);
COMMENT ON TABLE platform.supplier_environments IS 'Global state of a supplier in one environment, set by a platform admin (PADR-0020 item 1).';
COMMENT ON COLUMN platform.supplier_environments.supplier_id IS 'Supplier the switch covers.';
COMMENT ON COLUMN platform.supplier_environments.environment IS 'test or live.';
COMMENT ON COLUMN platform.supplier_environments.sales_enabled IS 'Global switch: false leaves every source of the supplier in this environment out of new searches, pricing and checkout; existing bookings are still served.';
COMMENT ON COLUMN platform.supplier_environments.version IS 'Optimistic-locking counter.';
COMMENT ON COLUMN platform.supplier_environments.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.supplier_environments.updated_at IS 'Last modification time.';

INSERT INTO platform.supplier_environments (supplier_id, environment, sales_enabled) VALUES
  ('amadeus', 'test', true),
  ('amadeus', 'live', true),
  ('pkfare', 'test', false),
  ('pkfare', 'live', false);

-- The supply sources. A Velexis source has no tenant and serves every OTA whose connection points at it; an OTA's own
-- source belongs to that OTA. The stop of sales covers one source for every OTA: who set it (`sales_stop`), when and
-- why; staff lift it (PBE-081). The list of who may set a stop has a CHECK of its own, so a later value (PBE-107's
-- cap) rewrites that CHECK alone.
CREATE TABLE platform.supply_sources (
  id                       text PRIMARY KEY CHECK (id LIKE 'ssr\_%'),
  supplier_id              text NOT NULL REFERENCES platform.suppliers (id) ON DELETE RESTRICT,
  environment              text NOT NULL CHECK (environment IN ('test','live')),
  credential_source        text NOT NULL CHECK (credential_source IN ('velexis','tenant')),
  tenant_id                text REFERENCES platform.tenants (id) ON DELETE CASCADE,
  sales_stop               text CONSTRAINT supply_sources_sales_stop_ck
                           CHECK (sales_stop IN ('staff','wallet_watch','balance_refusal')),
  sales_stop_at            timestamptz,
  sales_stop_reason        text,
  sales_stop_by_account_id text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supply_sources_owner_ck CHECK ((credential_source = 'tenant') = (tenant_id IS NOT NULL)),
  CONSTRAINT supply_sources_sales_stop_shape_ck CHECK (
    (sales_stop IS NULL AND sales_stop_at IS NULL AND sales_stop_reason IS NULL AND sales_stop_by_account_id IS NULL)
    OR
    (sales_stop IS NOT NULL AND sales_stop_at IS NOT NULL AND sales_stop_reason IS NOT NULL
       AND char_length(sales_stop_reason) BETWEEN 1 AND 500 AND (sales_stop = 'staff' OR sales_stop_by_account_id IS NULL))
  ),
  CONSTRAINT supply_sources_id_env_uq UNIQUE (id, environment),
  CONSTRAINT supply_sources_connection_uq UNIQUE (id, supplier_id, environment, credential_source)
);
CREATE INDEX supply_sources_tenant_idx ON platform.supply_sources (tenant_id) WHERE tenant_id IS NOT NULL;
COMMENT ON TABLE platform.supply_sources IS 'Supply sources: one supplier used through one account, a Velexis account that serves every OTA it supplies or an OTA''s own.';
COMMENT ON COLUMN platform.supply_sources.id IS 'Source id (ssr_ + ULID); never shown to an OTA, which sees the supply id of supply_source_ids.';
COMMENT ON COLUMN platform.supply_sources.supplier_id IS 'Supplier of the source.';
COMMENT ON COLUMN platform.supply_sources.environment IS 'test or live.';
COMMENT ON COLUMN platform.supply_sources.credential_source IS 'Whose account: velexis = one of Velexis''s accounts, for every OTA it supplies; tenant = the OTA''s own account.';
COMMENT ON COLUMN platform.supply_sources.tenant_id IS 'OTA whose own account this is (credential_source = tenant); NULL for a Velexis source.';
COMMENT ON COLUMN platform.supply_sources.sales_stop IS 'Who stopped the source''s sales, for every OTA: staff, wallet_watch (the balance fell under the floor) or balance_refusal (the supplier refused a ticket for the balance); NULL = no stop.';
COMMENT ON COLUMN platform.supply_sources.sales_stop_at IS 'When the stop was set.';
COMMENT ON COLUMN platform.supply_sources.sales_stop_reason IS 'Why the stop was set (1 to 500 characters; never shown to an OTA).';
COMMENT ON COLUMN platform.supply_sources.sales_stop_by_account_id IS 'Platform admin who set a staff stop; NULL for the wallet watch and a balance refusal.';
COMMENT ON COLUMN platform.supply_sources.version IS 'Optimistic-locking counter.';
COMMENT ON COLUMN platform.supply_sources.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.supply_sources.updated_at IS 'Last modification time.';

-- Every supply id a source has had. The current one has no retirement date (one per source); a rotation retires it
-- and adds the next (PBE-080). An id is never reused: the generator draws again when the table holds it already.
CREATE TABLE platform.supply_source_ids (
  supply_id        text PRIMARY KEY CONSTRAINT supply_source_ids_supply_id_ck
                   CHECK (supply_id ~ '^sup_[0-9A-HJKMNP-TV-Z]{16}$'),
  supply_source_id text NOT NULL REFERENCES platform.supply_sources (id) ON DELETE CASCADE,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz,
  CONSTRAINT supply_source_ids_dates_ck CHECK (retired_at IS NULL OR retired_at >= issued_at)
);
CREATE UNIQUE INDEX supply_source_ids_current_uq ON platform.supply_source_ids (supply_source_id) WHERE retired_at IS NULL;
CREATE INDEX supply_source_ids_source_idx ON platform.supply_source_ids (supply_source_id, issued_at);
COMMENT ON TABLE platform.supply_source_ids IS 'Every supply id a source has had, unique for ever; an old id still resolves to its source.';
COMMENT ON COLUMN platform.supply_source_ids.supply_id IS 'Supply id: sup_ + 16 random Crockford base32 characters, with no time part, hash or counter (not a ULID); what an OTA sees of a source.';
COMMENT ON COLUMN platform.supply_source_ids.supply_source_id IS 'Source the id names.';
COMMENT ON COLUMN platform.supply_source_ids.issued_at IS 'When the id became the source''s current id.';
COMMENT ON COLUMN platform.supply_source_ids.retired_at IS 'When a rotation replaced it; NULL while it is the current id (one per source).';

-- The connections: the row's supply source and the per-tenant switch.
ALTER TABLE platform.supplier_connections
  ADD COLUMN supply_source_id text,
  ADD COLUMN sales_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE platform.supplier_connections
  ADD CONSTRAINT supplier_connections_supply_source_fk
    FOREIGN KEY (supply_source_id, provider, environment, credential_source)
    REFERENCES platform.supply_sources (id, supplier_id, environment, credential_source);
CREATE INDEX supplier_connections_supply_source_idx ON platform.supplier_connections (supply_source_id)
  WHERE supply_source_id IS NOT NULL;
COMMENT ON COLUMN platform.supplier_connections.supply_source_id IS 'Supply source the row sells through: its account''s source for velexis, its own for tenant (same supplier, environment and credential source, composite FK); NULL only for rows written before their writer sets it (NOT NULL in a later release, PBE-106).';
COMMENT ON COLUMN platform.supplier_connections.sales_enabled IS 'Per-tenant switch, set by a platform admin: false leaves the source out of this OTA''s new searches, pricing and checkout; existing bookings are still served. status disabled stays the emergency stop that serves nothing.';

-- `provider`: a foreign key to suppliers in place of the baseline's CHECK, and still DEFAULT 'amadeus'.
ALTER TABLE platform.supplier_connections
  ADD CONSTRAINT supplier_connections_provider_fk FOREIGN KEY (provider)
    REFERENCES platform.suppliers (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE platform.supplier_connections DROP CONSTRAINT supplier_connections_provider_check;
ALTER TABLE platform.supplier_connections VALIDATE CONSTRAINT supplier_connections_provider_fk;
COMMENT ON COLUMN platform.supplier_connections.provider IS 'Supplier of the connection (FK to suppliers); DEFAULT amadeus for the writers that name none until the default is dropped (PBE-106).';

-- One row per tenant, supplier, environment and credential source.
ALTER TABLE platform.supplier_connections
  ADD CONSTRAINT supplier_connections_env_source_uq UNIQUE (tenant_id, provider, environment, credential_source);
ALTER TABLE platform.supplier_connections DROP CONSTRAINT supplier_connections_env_uq;

-- The shapes of the two credential sources, for every supplier: a `tenant` row holds its own credentials and no
-- Velexis account; a `velexis` row holds none, and names the Velexis Amadeus account for Amadeus, or no Amadeus
-- account and its supply source for another supplier.
ALTER TABLE platform.supplier_connections DROP CONSTRAINT supplier_connections_source_ck;
ALTER TABLE platform.supplier_connections ADD CONSTRAINT supplier_connections_source_ck CHECK (
  (credential_source = 'tenant' AND amadeus_account_id IS NULL AND base_url IS NOT NULL
     AND client_id IS NOT NULL AND client_secret_ciphertext IS NOT NULL AND encryption_key_id IS NOT NULL)
  OR
  (credential_source = 'velexis' AND base_url IS NULL AND client_id IS NULL
     AND client_secret_ciphertext IS NULL AND encryption_key_id IS NULL
     AND ((provider = 'amadeus' AND amadeus_account_id IS NOT NULL)
          OR (provider <> 'amadeus' AND amadeus_account_id IS NULL AND supply_source_id IS NOT NULL)))
) NOT VALID;
ALTER TABLE platform.supplier_connections VALIDATE CONSTRAINT supplier_connections_source_ck;

-- The Velexis Amadeus accounts: the account's supply source, one per account, of the account's environment.
ALTER TABLE platform.amadeus_accounts ADD COLUMN supply_source_id text;
ALTER TABLE platform.amadeus_accounts
  ADD CONSTRAINT amadeus_accounts_supply_source_uq UNIQUE (supply_source_id),
  ADD CONSTRAINT amadeus_accounts_supply_source_fk FOREIGN KEY (supply_source_id, environment)
    REFERENCES platform.supply_sources (id, environment);
COMMENT ON COLUMN platform.amadeus_accounts.supply_source_id IS 'The account''s supply source (a velexis source of amadeus in the same environment); the velexis connections on this account share it. NULL only for accounts written before their writer sets it.';

-- The backfill: one source and one supply id per Velexis Amadeus account and per `tenant` connection. The ids are
-- drawn per row (each LATERAL call of gen_random_uuid() is its own) and kept by the MATERIALIZED CTE, so the three
-- writes below use the same ids. A ULID is 10 Crockford characters of the millisecond time and 16 of 80 random bits;
-- the random bits are the 48 + 32 random bits of a version 4 UUID around its version and variant digits.
WITH owners AS (
  SELECT 'amadeus_account' AS owner, a.id AS owner_id, 'amadeus' AS supplier_id, a.environment,
         'velexis' AS credential_source, NULL::text AS tenant_id
  FROM platform.amadeus_accounts AS a
  WHERE a.supply_source_id IS NULL
  UNION ALL
  SELECT 'supplier_connection', c.id, c.provider, c.environment, 'tenant', c.tenant_id
  FROM platform.supplier_connections AS c
  WHERE c.credential_source = 'tenant' AND c.supply_source_id IS NULL
),
draws AS (
  SELECT o.*,
         floor(extract(epoch FROM now()) * 1000)::bigint::bit(50)
           || ('x' || substr(r.source_hex, 1, 12) || substr(r.source_hex, 21, 8))::bit(80) AS source_bits,
         ('x' || substr(r.id_hex, 1, 12) || substr(r.id_hex, 21, 8))::bit(80) AS id_bits
  FROM owners AS o
  CROSS JOIN LATERAL (
    SELECT replace(gen_random_uuid()::text, '-', '') AS source_hex,
           replace(gen_random_uuid()::text, '-', '') AS id_hex
    WHERE o.owner_id IS NOT NULL
  ) AS r
),
drawn AS MATERIALIZED (
  SELECT d.owner, d.owner_id, d.supplier_id, d.environment, d.credential_source, d.tenant_id,
         'ssr_' || (SELECT string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                                            substring(d.source_bits FROM n * 5 + 1 FOR 5)::integer + 1, 1), ''
                                     ORDER BY n)
                    FROM generate_series(0, 25) AS n) AS source_id,
         'sup_' || (SELECT string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                                            substring(d.id_bits FROM n * 5 + 1 FOR 5)::integer + 1, 1), ''
                                     ORDER BY n)
                    FROM generate_series(0, 15) AS n) AS supply_id
  FROM draws AS d
),
sources AS (
  INSERT INTO platform.supply_sources (id, supplier_id, environment, credential_source, tenant_id)
  SELECT source_id, supplier_id, environment, credential_source, tenant_id FROM drawn
),
supply_ids AS (
  INSERT INTO platform.supply_source_ids (supply_id, supply_source_id)
  SELECT supply_id, source_id FROM drawn
),
accounts AS (
  UPDATE platform.amadeus_accounts AS a
  SET supply_source_id = d.source_id
  FROM drawn AS d
  WHERE d.owner = 'amadeus_account' AND a.id = d.owner_id
)
UPDATE platform.supplier_connections AS c
SET supply_source_id = d.source_id
FROM drawn AS d
WHERE d.owner = 'supplier_connection' AND c.id = d.owner_id;

-- A `velexis` connection shares the source of its account.
UPDATE platform.supplier_connections AS c
SET supply_source_id = a.supply_source_id
FROM platform.amadeus_accounts AS a
WHERE c.credential_source = 'velexis' AND c.supply_source_id IS NULL AND a.id = c.amadeus_account_id;

-- The backfill left no connection or account without a source, and no source without exactly one current id.
DO $$
DECLARE
  missing bigint;
BEGIN
  SELECT count(*) INTO missing FROM platform.supplier_connections WHERE supply_source_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'platform.supplier_connections.supply_source_id: % row(s) without a supply source after the backfill', missing;
  END IF;
  SELECT count(*) INTO missing FROM platform.amadeus_accounts WHERE supply_source_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'platform.amadeus_accounts.supply_source_id: % row(s) without a supply source after the backfill', missing;
  END IF;
  SELECT count(*) INTO missing FROM platform.supply_sources AS s
  WHERE (SELECT count(*) FROM platform.supply_source_ids AS i WHERE i.supply_source_id = s.id AND i.retired_at IS NULL) <> 1;
  IF missing > 0 THEN
    RAISE EXCEPTION 'platform.supply_source_ids: % source(s) without exactly one current supply id after the backfill', missing;
  END IF;
END
$$;

-- Privileges. velexis_platform_app owns the registry's data (it also gets DML from the default privileges of
-- deploy/postgres/bootstrap.sql). velexis_ota_app reads what the OTA backend's resolver needs (OBE-146), column by
-- column, so a column added later is not readable until a grant names it: a supplier's global switch, a source's
-- supplier, environment, owner and whether a stop is set (never who set it, when or why), and which source a supply id
-- names and whether it is current. It reads nothing of suppliers. The new columns of supplier_connections and
-- amadeus_accounts are covered by the table-level SELECT it already has on both tables (R__ota_read_access.sql, 0002).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  platform.suppliers, platform.supplier_environments, platform.supply_sources, platform.supply_source_ids
  TO velexis_platform_app;
GRANT SELECT (supplier_id, environment, sales_enabled) ON platform.supplier_environments TO velexis_ota_app;
GRANT SELECT (id, supplier_id, environment, credential_source, tenant_id, sales_stop) ON platform.supply_sources
  TO velexis_ota_app;
GRANT SELECT (supply_id, supply_source_id, retired_at) ON platform.supply_source_ids TO velexis_ota_app;
