# DB Migration Checklist (Production Scale)

This checklist is for safe schema/index/data migrations when traffic and data volume are high.

## 1. Pre-Migration Readiness
- Define migration scope: schema, indexes, data backfill, rollback strategy.
- Export current index list for all collections (`users`, `applications`, `universities`, `scholarships`, `banners`).
- Capture current baseline metrics:
  - API p95 latency
  - Mongo slow queries
  - CPU, memory, disk IOPS
  - Error rate
- Confirm backup freshness and restore test (not just backup existence).

## 2. Index Plan (Large-Data Safety)
- Validate these high-impact indexes exist and are healthy:
  - `applications`: `{ user: 1, appliedAt: -1 }`, `{ university: 1, appliedAt: -1 }`, `{ scholarship: 1, appliedAt: -1 }`, `{ status: 1, appliedAt: -1 }`, `{ type: 1, appliedAt: -1 }`
  - `users`: `{ role: 1, createdAt: -1 }`, `{ role: 1, state: 1, city: 1 }`
- Add missing indexes for public listing stability:
  - `universities`: `{ isActive: 1, createdAt: -1 }`
  - `scholarships`: `{ isActive: 1, createdAt: -1 }`
  - optional search indexes for frequently queried fields (`name`, `title`, `city`, `state`)
- Build new indexes in rolling fashion and monitor lock/IO impact.

## 3. Migration Execution Strategy
- Use phased deployment:
  - Phase A: deploy backward-compatible code (supports old + new shapes)
  - Phase B: run migration/backfill jobs
  - Phase C: switch reads to new fields/indexes
  - Phase D: remove deprecated fields in a later release
- Prefer idempotent migration scripts (safe re-run).
- Run migrations in small batches to avoid replica lag and timeouts.

## 4. Data Validation Gates
- Before cutover, validate:
  - document counts match expected totals
  - required fields are populated
  - no duplicate logical records after backfill
  - sample read/write flows succeed (login, apply, notifications, downloads)
- Run API contract checks for admin panel + user app endpoints.

## 5. Performance & Reliability Gates
- Run k6 smoke/auth load tests before and after migration.
- Ensure no regression in:
  - login latency
  - applications list pagination
  - document download endpoints
- Watch for spikes in `500`, `429`, and Mongo slow query logs.

## 6. Rollback Plan (Must Be Ready Before Start)
- Keep old code path deployable.
- Keep backup snapshot + restore commands documented.
- Define rollback triggers:
  - p95 latency regression threshold breached
  - error rate threshold breached
  - data validation mismatches
- Practice rollback once in staging.

## 7. Post-Migration Cleanup
- Remove temporary migration scripts/flags only after 24-72h stability window.
- Update runbook with:
  - final schema/index state
  - incident learnings
  - new capacity thresholds

## 8. Capacity Planning (1M+ Users)
- Enforce pagination on all list endpoints.
- Avoid unbounded array growth (trim notifications and historical payloads).
- Keep response cache + async queue enabled for burst smoothing.
- Monitor DB connection pool and tune worker concurrency.
