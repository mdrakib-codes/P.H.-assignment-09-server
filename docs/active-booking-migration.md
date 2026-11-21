# Active Booking Duplicate Migration

The `bookings_active_customer_service_uidx` index is required because the booking create flow checks for an active booking before inserting. Two concurrent requests can both pass that check and both insert, so only a database-level unique partial index can enforce the invariant: at most one active booking per customer email and service.

The index is unique on `{ customerEmail, serviceId }`, excludes `status` from the key, and applies only when `status` is `requested`, `accepted`, or `in-progress`. It uses `{ locale: 'en', strength: 2 }` collation so mixed-case email variants are treated as the same key. Terminal bookings (`cancelled`, `rejected`, `completed`) are outside the partial filter and do not block future bookings.

Duplicate cleanup must happen before the index is deployed. MongoDB cannot create a unique index over an existing collection that already contains duplicate active keys, and server startup will fail if index creation fails. Cleanup must be run against a local or staging database only. Never run it against Atlas or a production database from this workflow.

Booking creation and any other operation capable of creating an active duplicate must be paused during the final migration and index deployment window. This includes any operation that can insert a booking or transition a booking into `requested`, `accepted`, or `in-progress`. Pausing and resuming traffic is an operational deployment instruction; do not implement automatic pause or resume behavior in application code.

## Required deployment sequence

Follow this sequence exactly. Booking writes remain paused from step 1 through successful index verification in step 9.

1. Pause active booking writes.
   - Block booking creation and any other operation capable of creating an active duplicate.
   - Keep writes paused until step 10.

2. Run the migration dry-run:

   ```bash
   node scripts/migrate-active-booking-duplicates.js
   ```

   The default mode detects duplicate groups, normalizes email case for grouping, reports suspicious records, selects a canonical booking, and prints the exact planned cancellations. It makes no booking writes and never creates the index.

3. Review all duplicate and suspicious records.

4. Obtain explicit operator approval for the reviewed plan.

5. Apply approved duplicate cleanup if necessary:

   ```bash
   node scripts/migrate-active-booking-duplicates.js --apply --confirm CANCEL_DUPLICATE_BOOKINGS
   ```

   `--apply` alone is not sufficient. The explicit confirmation token is required. The script refuses to proceed if suspicious records are present.

6. Re-run duplicate detection.

   ```bash
   node scripts/migrate-active-booking-duplicates.js
   ```

7. Require zero duplicate active groups.

8. Create or deploy the unique partial index.

9. Verify the index exists with the expected definition:
   - name: `bookings_active_customer_service_uidx`
   - unique: `true`
   - key: `{ customerEmail: 1, serviceId: 1 }`
   - partial filter: `status` in `requested`, `accepted`, `in-progress`
   - collation: `{ locale: 'en', strength: 2 }`

10. Resume booking writes only after successful index verification.

There must be no gap between final duplicate verification in step 7 and successful index creation and verification in steps 8-9 during which active booking writes can occur. A new active duplicate created in that gap would prevent the unique index from being created or would leave the migration result stale.

If index creation fails, keep booking writes paused until the cause is resolved. Re-run duplicate detection before retrying index creation, and repeat the required sequence as needed.

## Canonical selection

Canonical selection order is:

1. `in-progress`
2. `accepted`
3. `requested`

For equal statuses, the earliest valid `createdAt` wins; for equal timestamps, the lowest `_id` wins.

## Suspicious records

A record is suspicious if it has an invalid `_id`, `customerEmail`, `serviceId`, active status, or `createdAt`. Suspicious records appear in the report with reasons and are excluded from planning. Apply mode aborts with a failure result until they are reviewed and corrected manually.

## Verification

After apply, the script re-runs duplicate detection. Success requires zero duplicate groups, zero suspicious records, and zero skipped updates. If any update skipped because a booking changed status after inspection, the run is reported as failed even though no unintended record was cancelled.

## Startup safety

Do not add this migration to server startup. The migration requires an operator-reviewed plan and explicit confirmation. Server startup must continue to fail fast if duplicate active bookings prevent the unique index from being created.

Traffic pausing and resumption are deployment operations only. Do not add code that automatically pauses or resumes application traffic around this migration or index deployment.
