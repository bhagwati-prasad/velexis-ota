-- =====================================================================================================
-- Velexis OTA platform - shared REFERENCE data schema `reference` (PostgreSQL 16)
-- Read-only for tenants (the tenant search_path is "tenant_<key>, reference"); loaded and refreshed by platform
-- jobs from IATA / ISO / IANA sources. Natural keys only (ISO 3166, ISO 4217, IANA, IATA, ICAO codes), so tenant
-- rows can reference them BY VALUE (e.g. bookings.origin_iata = airports.iata_code) without cross-schema FKs.
-- Autocomplete: pg_trgm is NOT available, so prefix search uses btree indexes on lower(...) text_pattern_ops,
-- queried as  WHERE lower(name) LIKE lower($1) || '%'  plus exact-code lookups on the primary keys.
-- Trailing "-- " comments document each column (dictionary.json is generated from them, "* " = shown in ER).
-- =====================================================================================================

CREATE SCHEMA IF NOT EXISTS reference;

-- ISO 4217 currencies (selling / billing currencies, minor units for formatting and rounding).
CREATE TABLE reference.currencies (
  code         char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),             -- * ISO 4217 alphabetic code, e.g. EUR.
  numeric_code char(3) CHECK (numeric_code ~ '^[0-9]{3}$'),                 -- ISO 4217 numeric code, e.g. 978.
  name         text NOT NULL,                                               -- * English name, e.g. Euro.
  symbol       text,                                                        -- Display symbol, e.g. EUR sign.
  minor_units  smallint NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 4), -- Number of decimals used for amounts.
  is_active    boolean NOT NULL DEFAULT true,                               -- False for historic currencies.
  created_at   timestamptz NOT NULL DEFAULT now(),                          -- Row creation time (load job).
  updated_at   timestamptz NOT NULL DEFAULT now()                           -- Last refresh by the load job.
);
CREATE INDEX currencies_name_lower_idx ON reference.currencies (lower(name) text_pattern_ops);

-- ISO 3166-1 countries.
CREATE TABLE reference.countries (
  code           char(2) PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),           -- * ISO 3166-1 alpha-2 code, e.g. FR (used by Amadeus document/address fields).
  alpha3         char(3) UNIQUE CHECK (alpha3 ~ '^[A-Z]{3}$'),             -- ISO 3166-1 alpha-3 code, e.g. FRA.
  numeric_code   char(3),                                                   -- ISO 3166-1 numeric code.
  name           text NOT NULL,                                             -- * English short name.
  official_name  text,                                                      -- Official long name.
  continent_code char(2) CHECK (continent_code IN ('AF','AN','AS','EU','NA','OC','SA')), -- Continent.
  currency_code  char(3) REFERENCES reference.currencies (code) ON DELETE SET NULL, -- Main currency of the country.
  calling_code   text CHECK (calling_code ~ '^[0-9]{1,4}$'),                -- International calling code without +, e.g. 33 (Amadeus countryCallingCode).
  is_eu          boolean NOT NULL DEFAULT false,                            -- EU member state (EU261 notices, VAT rules).
  created_at     timestamptz NOT NULL DEFAULT now(),                        -- Row creation time.
  updated_at     timestamptz NOT NULL DEFAULT now()                         -- Last refresh.
);
CREATE INDEX countries_name_lower_idx ON reference.countries (lower(name) text_pattern_ops);
CREATE INDEX countries_currency_idx ON reference.countries (currency_code);

-- IANA time zones (convert Amadeus local date-times to UTC for upcoming/past trips and deadlines).
CREATE TABLE reference.time_zones (
  name                text PRIMARY KEY,                                     -- * IANA zone name, e.g. Europe/Paris.
  country_code        char(2) REFERENCES reference.countries (code) ON DELETE SET NULL, -- Country of the zone.
  utc_offset_minutes  integer NOT NULL,                                     -- * Standard offset from UTC in minutes.
  dst_offset_minutes  integer,                                              -- Offset during daylight saving time (NULL = no DST).
  created_at          timestamptz NOT NULL DEFAULT now(),                   -- Row creation time.
  updated_at          timestamptz NOT NULL DEFAULT now()                    -- Last refresh.
);
CREATE INDEX time_zones_country_idx ON reference.time_zones (country_code);

-- IATA cities / metropolitan areas (e.g. PAR groups CDG and ORY) used for city-wide search.
CREATE TABLE reference.cities (
  iata_code    char(3) PRIMARY KEY CHECK (iata_code ~ '^[A-Z]{3}$'),        -- * IATA city code, e.g. PAR.
  name         text NOT NULL,                                               -- * City name, e.g. Paris.
  country_code char(2) NOT NULL REFERENCES reference.countries (code) ON DELETE RESTRICT, -- * Country of the city.
  state_code   text,                                                        -- State / province code where relevant (US, CA, AU, BR).
  time_zone    text REFERENCES reference.time_zones (name) ON DELETE SET NULL, -- IANA time zone.
  latitude     numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),            -- Latitude in degrees.
  longitude    numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),         -- Longitude in degrees.
  search_rank  integer NOT NULL DEFAULT 0,                                  -- Popularity score used to order autocomplete suggestions.
  created_at   timestamptz NOT NULL DEFAULT now(),                          -- Row creation time.
  updated_at   timestamptz NOT NULL DEFAULT now()                           -- Last refresh.
);
CREATE INDEX cities_name_lower_idx ON reference.cities (lower(name) text_pattern_ops);
CREATE INDEX cities_country_idx ON reference.cities (country_code);
CREATE INDEX cities_time_zone_idx ON reference.cities (time_zone);

-- Airports and other IATA locations (rail/bus stations) served by Amadeus.
CREATE TABLE reference.airports (
  iata_code    char(3) PRIMARY KEY CHECK (iata_code ~ '^[A-Z]{3}$'),        -- * IATA location code, e.g. CDG (Amadeus iataCode).
  icao_code    char(4) UNIQUE CHECK (icao_code ~ '^[A-Z0-9]{4}$'),          -- ICAO code, e.g. LFPG.
  name         text NOT NULL,                                               -- * Airport name, e.g. Charles de Gaulle.
  city_code    char(3) REFERENCES reference.cities (iata_code) ON DELETE SET NULL, -- * IATA city served.
  city_name    text,                                                        -- Denormalised city name for display and city-name autocomplete.
  country_code char(2) NOT NULL REFERENCES reference.countries (code) ON DELETE RESTRICT, -- * Country.
  time_zone    text REFERENCES reference.time_zones (name) ON DELETE SET NULL, -- IANA time zone (local -> UTC conversion of flight times).
  latitude     numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),            -- Latitude in degrees.
  longitude    numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),         -- Longitude in degrees.
  elevation_ft integer,                                                     -- Elevation in feet.
  kind         text NOT NULL DEFAULT 'airport' CHECK (kind IN ('airport','heliport','rail_station','bus_station','seaplane_base')), -- Location type.
  is_active    boolean NOT NULL DEFAULT true,                               -- False for closed airports (kept for history).
  search_rank  integer NOT NULL DEFAULT 0,                                  -- Popularity score for ordering suggestions.
  created_at   timestamptz NOT NULL DEFAULT now(),                          -- Row creation time.
  updated_at   timestamptz NOT NULL DEFAULT now()                           -- Last refresh.
);
CREATE INDEX airports_name_lower_idx ON reference.airports (lower(name) text_pattern_ops);
CREATE INDEX airports_city_name_lower_idx ON reference.airports (lower(city_name) text_pattern_ops);
CREATE INDEX airports_city_idx ON reference.airports (city_code);
CREATE INDEX airports_country_idx ON reference.airports (country_code);
CREATE INDEX airports_time_zone_idx ON reference.airports (time_zone);
CREATE INDEX airports_rank_idx ON reference.airports (search_rank DESC) WHERE is_active;

-- Airlines (IATA carrier codes as used by Amadeus carrierCode / validatingAirlineCodes).
CREATE TABLE reference.airlines (
  iata_code       char(2) PRIMARY KEY CHECK (iata_code ~ '^[A-Z0-9]{2}$'),  -- * IATA designator, e.g. AF.
  icao_code       char(3) UNIQUE CHECK (icao_code ~ '^[A-Z]{3}$'),          -- ICAO designator, e.g. AFR.
  name            text NOT NULL,                                            -- * Airline name, e.g. Air France.
  common_name     text,                                                     -- Short commercial name / brand.
  country_code    char(2) REFERENCES reference.countries (code) ON DELETE SET NULL, -- Country of registration.
  accounting_code char(3) CHECK (accounting_code ~ '^[0-9]{3}$'),           -- 3-digit ticketing prefix (prefix of ticket document numbers), e.g. 057.
  alliance        text CHECK (alliance IN ('star_alliance','oneworld','skyteam')), -- Alliance membership.
  is_low_cost     boolean NOT NULL DEFAULT false,                           -- Low-cost carrier flag.
  is_active       boolean NOT NULL DEFAULT true,                            -- False for defunct carriers.
  logo_url        text,                                                     -- Logo asset URL for result lists.
  created_at      timestamptz NOT NULL DEFAULT now(),                       -- Row creation time.
  updated_at      timestamptz NOT NULL DEFAULT now()                        -- Last refresh.
);
CREATE INDEX airlines_name_lower_idx ON reference.airlines (lower(name) text_pattern_ops);
CREATE INDEX airlines_accounting_code_idx ON reference.airlines (accounting_code);
CREATE INDEX airlines_country_idx ON reference.airlines (country_code);

-- Aircraft types (IATA equipment codes from Amadeus aircraft.code, e.g. 320, 77W).
CREATE TABLE reference.aircraft (
  iata_code    char(3) PRIMARY KEY CHECK (iata_code ~ '^[A-Z0-9]{3}$'),     -- * IATA aircraft type code.
  icao_code    char(4),                                                     -- ICAO type designator, e.g. A320 (several IATA codes may share one).
  name         text NOT NULL,                                               -- * Display name, e.g. AIRBUS A320.
  manufacturer text,                                                        -- Manufacturer, e.g. Airbus.
  body_type    text CHECK (body_type IN ('narrow','wide','regional','turboprop','helicopter','other')), -- Body category for display.
  created_at   timestamptz NOT NULL DEFAULT now(),                          -- Row creation time.
  updated_at   timestamptz NOT NULL DEFAULT now()                           -- Last refresh.
);
CREATE INDEX aircraft_name_lower_idx ON reference.aircraft (lower(name) text_pattern_ops);
CREATE INDEX aircraft_icao_idx ON reference.aircraft (icao_code);
