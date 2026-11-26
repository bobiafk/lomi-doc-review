# Chaos pass

Run on 2026-11-26 against the real Docker stack (`docker compose up`: Postgres,
Redis, migrate, API, worker, web) with `bash scripts/chaos.sh`. Every scenario
breaks something on purpose, then asserts from **Postgres** (the system of
record) that nothing was lost, nothing was duplicated and nothing is stuck.

**Result: 33 / 33 checks passed. 0 duplicated `(version, field)` rows and 0
versions stuck in `extracting` at the end.**

To have time to break things mid-extraction, the worker ran the dev-only canned
LLM with a 20 s artificial delay (`EXTRACTION_LLM=canned CANNED_DELAY_MS=20000`);
the delay respects the abort signal like a real request. Everything after the
LLM call (evidence validation, carry-over, fenced commit) is the production
code path. Lease, heartbeat and reconcile intervals were the defaults: 60 s,
15 s, 30 s.

## Scenarios

| # | What we broke | What happened | Verdict |
|---|---|---|---|
| 1 | **SIGKILL the worker** mid-extraction (`docker compose kill worker`), start it again | The version stayed visibly `extracting` while its dead worker's lease ran out, then the reconciler re-enqueued it and attempt 2 committed. Run log: `1:abandoned, 2:succeeded`. Exactly 5 values. Recovery took 67 s after the restart, bounded by the 60 s lease. | Pass |
| 2 | **`docker compose restart`** of every service mid-extraction | Same story: the worker was stopped mid-call (graceful shutdown waits ~10 s, then Docker kills it), the attempt is logged `abandoned`, attempt 2 succeeded 51 s after the restart. Exactly 5 values. | Pass |
| 3 | **Redis `FLUSHALL`** mid-extraction, then restart the stack | The in-flight version completed. Values, reviews and runs only grew (26 → 31 values, 1 → 1 reviews, 8 → 9 runs); the review made right before the flush is intact. | Pass |
| 4 | **`FLUSHALL` while the only copy of a job is in Redis** (worker stopped, document queued) | The job vanished from Redis; on startup the worker's reconciler read `queued` from Postgres, rang the doorbell again and the document completed in 16 s. | Pass |
| 5 | **Double upload**: the same new version posted twice concurrently, then a third time | One `202` and one `200 { duplicate: true }`; the third identical upload was a no-op too. Exactly 2 versions; v2 extracted once (`1:succeeded`). | Pass |
| 6 | **Two workers** (`--scale worker=2`) racing for three new documents | Each version was claimed once (`1:succeeded` each), no duplicated `(version, field)` rows. The losing worker's claim simply matched zero rows. | Pass |
| 7 | **v2 uploaded while v1 is extracting** | v2 accepted (`202`); v1 marked `superseded` in the same transaction. The worker's heartbeat noticed and aborted v1's LLM call; its run is logged `superseded` 14.6 s after the upload (one heartbeat interval). v1 has 0 values, v2 has 5, and `GET /documents/:id/versions/1` still serves v1. | Pass |
| 8 | **Redis stopped** during an upload | The upload still answered in 118 ms (`enableOfflineQueue: false`, enqueue failure logged), with the version committed as `queued`. When Redis came back the reconciler enqueued it and it completed. | Pass |
| 9 | **Postgres restarted** mid-extraction | The heartbeat failed quietly during the restart, the connection pool reconnected, and the original attempt committed (`1:succeeded`, 5 values). | Pass |

## What this shows

- **Postgres is the system of record; Redis is a doorbell.** Losing all of Redis (scenarios 3, 4) or Redis being down (8) lost nothing and stranded nothing: the reconciler rebuilds the queue from Postgres.
- **Nothing is stuck in `extracting` forever.** A dead worker's lease expires and the work moves to a new attempt (1, 2). With automatic attempts exhausted, the reconciler marks the version `failed` with a readable error instead (covered by `apps/worker/test/reconciler.test.ts`).
- **No duplicates, however the second run happens.** Concurrent workers (6), re-runs after a crash (1, 2) and double uploads (5) all end with exactly one set of values: the atomic claim, the fenced commit and `unique(version_id, field)` each prevent it on their own.
- **Supersede is visible and cheap.** The old version's result is discarded but its run stays in the log, and the abort saves the rest of the LLM call (7).

## Known limits

- Worst-case recovery after a crash is lease + reconcile interval (60 s + 30 s). Shorter leases recover faster but heartbeat more; 60 s is generous for one-page documents.
- `docker compose restart` waits Docker's 10 s grace period for the worker to finish its in-flight job before killing it. Long LLM calls are therefore usually cut off and retried rather than completed; that's correct, just slower.
- These runs used the canned LLM. The live smoke test (`LIVE_LLM=1`, see `apps/worker/test/live-llm.test.ts`) is the check for the real model's output.

## Reproduce

```sh
docker compose build
bash scripts/chaos.sh                 # all scenarios, ~8 minutes
bash scripts/chaos.sh supersede flush # or pick some
```

## Raw log

```text
[19:08:33] stack up with EXTRACTION_LLM=canned CANNED_DELAY_MS=20000; 16 values, 0 reviews, 3 runs
[19:08:33] == kill: SIGKILL the worker mid-extraction, then start it again
[19:08:33]   doc-a9d6317d-b862-47a3-9833-4abf90980263 v1 is extracting after 0s
[19:08:34]   worker killed (SIGKILL)
[19:08:37] PASS  kill: version is still visibly 'extracting' (lease held by the dead worker)
[19:08:43]   worker started again
[19:10:33]   doc-a9d6317d-b862-47a3-9833-4abf90980263 v1 is extracted after 67s
[19:10:34] PASS  kill: completes after the lease expires (lease 60 s + reconcile 30 s)
[19:10:34] PASS  kill: dead run logged as abandoned, retry succeeded (1:abandoned,2:succeeded)
[19:10:35] PASS  kill: exactly 5 values
[19:10:35] == restart: docker compose restart (every service) mid-extraction
[19:10:35]   doc-7076dbff-ffa0-42c3-8c6d-8d4cd0daf79a v1 is extracting after 0s
[19:10:46]   stack restarted
[19:12:09]   doc-7076dbff-ffa0-42c3-8c6d-8d4cd0daf79a v1 is extracted after 51s
[19:12:09] PASS  restart: completes
[19:12:10] PASS  restart: one successful run, earlier attempt not lost (1:abandoned,2:succeeded)
[19:12:10] PASS  restart: exactly 5 values
[19:12:10] == flush: Redis FLUSHALL mid-extraction, then restart the stack
[19:12:12]   doc-30542d95-a65b-4984-a11a-ce539371c795 v1 is extracting after 0s
[19:12:12]   before: 26 values, 1 reviews, 8 runs
[19:12:12]   FLUSHALL done
[19:12:23]   stack restarted
[19:13:45]   doc-30542d95-a65b-4984-a11a-ce539371c795 v1 is extracted after 56s
[19:13:45] PASS  flush: in-flight version completes
[19:13:45]   after:  31 values, 1 reviews, 9 runs
[19:13:45] PASS  flush: no value, review or run lost (values/reviews/runs only grew)
[19:13:45] PASS  flush: the review made before the flush is still there
[19:13:45] == flush-queued: job only in Redis (worker down), FLUSHALL, worker back
[19:13:46] PASS  flush-queued: job is in Redis before the flush
[19:13:47]   FLUSHALL done: the only job is gone
[19:14:12]   doc-1a66d704-c9c7-455d-9cb7-78cb50cf4c03 v1 is extracted after 16s
[19:14:12] PASS  flush-queued: reconciler re-enqueues from Postgres and it completes
[19:14:12] == double: the same new version uploaded twice at once, then again
[19:14:12] PASS  double: concurrent uploads -> one 202 and one 200 duplicate (got 202, 200)
[19:14:12] PASS  double: third identical upload is a no-op (200)
[19:14:12] PASS  double: exactly 2 versions exist
[19:14:33]   doc-d20498fa-ee64-4bc7-84f4-db6093b8a9a7 v2 is extracted after 15s
[19:14:33] PASS  double: v2 completes
[19:14:34] PASS  double: v2 extracted once (1:succeeded)
[19:14:34] == scale: two workers race for the same jobs
[19:14:58]   doc-16b7605f-1cc4-41ea-8ba1-83e74fda7d46 v1 is extracted after 15s
[19:14:59]   doc-6fd442da-2359-463a-b7b6-581b16f83d00 v1 is extracted after 0s
[19:14:59]   doc-f33f4d9f-9223-4e4b-b7c8-07ac3f1f9639 v1 is extracted after 0s
[19:15:00] PASS  scale: doc-16b7605f-1cc4-41ea-8ba1-83e74fda7d46 extracted once (1:succeeded)
[19:15:00] PASS  scale: doc-6fd442da-2359-463a-b7b6-581b16f83d00 extracted once (1:succeeded)
[19:15:01] PASS  scale: doc-f33f4d9f-9223-4e4b-b7c8-07ac3f1f9639 extracted once (1:succeeded)
[19:15:02] PASS  scale: no duplicated (version, field) anywhere
[19:15:05] == supersede: v2 uploaded while v1 is extracting
[19:15:05]   doc-6d0495f2-0c18-45e8-8f12-1d917f6062c4 v1 is extracting after 0s
[19:15:05] PASS  supersede: v2 accepted (202)
[19:15:05] PASS  supersede: v1 marked superseded at once
[19:15:26]   doc-6d0495f2-0c18-45e8-8f12-1d917f6062c4 v2 is extracted after 15s
[19:15:26] PASS  supersede: v2 completes
[19:15:27] PASS  supersede: v1's run was discarded and logged (1:superseded)
[19:15:28] PASS  supersede: v1 has no values, v2 has 5
[19:15:28] PASS  supersede: v1 stays queryable
[19:15:28] == redis-down: upload while Redis is stopped
[19:15:29] PASS  redis-down: upload still answered, in 118 ms
[19:15:29] PASS  redis-down: version committed as queued
[19:16:13]   doc-673b8746-9be6-403c-9055-837ee3dbdd95 v1 is extracted after 27s
[19:16:13] PASS  redis-down: reconciler enqueues it once Redis is back; it completes
[19:16:13] == postgres-restart: Postgres restarted mid-extraction
[19:16:14]   doc-457ede1b-b68f-40e1-bff0-465273ee946a v1 is extracting after 0s
[19:16:15]   postgres restarted
[19:16:35]   doc-457ede1b-b68f-40e1-bff0-465273ee946a v1 is extracted after 13s
[19:16:35] PASS  postgres-restart: completes
[19:16:36] PASS  postgres-restart: exactly 5 values (1:succeeded)
[19:16:36] duplicate (version, field) rows in the whole database: 0
[19:16:36] stuck versions (extracting with an expired lease): 0
[19:16:36] ALL PASSED
```
