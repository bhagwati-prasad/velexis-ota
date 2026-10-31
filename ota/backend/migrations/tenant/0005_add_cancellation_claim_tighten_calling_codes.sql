-- velexis:phase contract
-- Bookings: a cancellation's claim as a column; customers and saved travellers: calling codes of one to three digits.

-- Lead decision (1) of 2026-10-27 (FIX-W31-OTA, OADR-0014 point 6): from the commit of a cancellation's claim (T1 of
-- bookings.cancel or console.bookings.cancel) until its outcome is recorded, the ticketing claims (the ticketing job's
-- and console.bookings.issue's) leave the booking alone, so no Flight Order Issue goes to an order whose Flight Order
-- Management DELETE is in flight. The claim writes its time here and every outcome step clears it; a claim older than
-- the ticketing claim's 5 minutes counts as abandoned and holds nothing back. Bookings written before have none (no
-- backfill: a cancellation in flight during the upgrade is not held, as before this column).
ALTER TABLE bookings ADD COLUMN cancellation_claimed_at timestamptz;

COMMENT ON COLUMN bookings.cancellation_claimed_at IS 'When a cancellation claimed the booking for its Flight Order Management DELETE (bookings.cancel, console.bookings.cancel); cleared by its outcome (cancelled, a request for the staff, not applied, the flag of a DELETE without an answer). While it is less than 5 minutes old the ticketing job skips the booking and console.bookings.issue refuses it.';

-- Lead decision (1) of 2026-10-27: a stored phone calling code has one to three digits (ITU-T E.164 country codes, and
-- what the API accepts since FIX-W30-OTA: `^\+?[0-9]{1,3}$`, stored without the `+`), no longer the baseline's one to
-- four. Before a CHECK changes, the rows that would break it are counted: any such row stops the migration with an
-- exception naming the table, the column and the count, and the schema's transaction rolls back, so nothing is
-- rewritten silently; the rows are corrected by hand, then the migration runs again. The emergency contacts
-- (`saved_travelers.emergency_contact`, `checkout_travelers.emergency_contact`, `booking_travelers.emergency_contact`)
-- are jsonb without a CHECK, so they have none to tighten.
DO $$
DECLARE
  broken bigint;
BEGIN
  SELECT count(*) INTO broken FROM customers WHERE phone_country_code !~ '^[0-9]{1,3}$';
  IF broken > 0 THEN
    RAISE EXCEPTION 'customers.phone_country_code: % row(s) hold a calling code of more than three digits; correct them, then run the migration again', broken;
  END IF;
  SELECT count(*) INTO broken FROM saved_travelers WHERE phone_country_code !~ '^[0-9]{1,3}$';
  IF broken > 0 THEN
    RAISE EXCEPTION 'saved_travelers.phone_country_code: % row(s) hold a calling code of more than three digits; correct them, then run the migration again', broken;
  END IF;
END
$$;

ALTER TABLE customers ADD CONSTRAINT customers_phone_country_code_ck
  CHECK (phone_country_code ~ '^[0-9]{1,3}$') NOT VALID;
ALTER TABLE customers DROP CONSTRAINT customers_phone_country_code_check;
ALTER TABLE customers VALIDATE CONSTRAINT customers_phone_country_code_ck;

ALTER TABLE saved_travelers ADD CONSTRAINT saved_travelers_phone_country_code_ck
  CHECK (phone_country_code ~ '^[0-9]{1,3}$') NOT VALID;
ALTER TABLE saved_travelers DROP CONSTRAINT saved_travelers_phone_country_code_check;
ALTER TABLE saved_travelers VALIDATE CONSTRAINT saved_travelers_phone_country_code_ck;

COMMENT ON COLUMN customers.phone_country_code IS 'Country calling code of the phone, one to three digits without +, as account.update stores it (Amadeus countryCallingCode).';
COMMENT ON COLUMN saved_travelers.phone_country_code IS 'Phone country calling code, one to three digits without +.';
