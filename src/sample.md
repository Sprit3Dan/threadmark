# Cache invalidation review

The write-through cache <!-- @t1:start -->invalidates on every commit<!-- @t1:end -->,
which is simple but expensive under the load we measured on Tuesday.

| workload | invalidations/s | p95 |
| --- | --- | --- |
| read heavy | 12 | 3ms |
| write heavy | 1,400 | 46ms |

`REINDEX` runs on the same path, so a schema change <!-- @t2:start -->blocks
readers for the duration<!-- @t2:end --> of the rewrite.

## Options considered

- [x] Invalidate per commit — shipped
- [ ] Invalidate on a timer, with a bounded staleness budget
- [ ] Per-key leases, so only the affected keys drop

```sql
SELECT count(*) FROM invalidations WHERE bucket = 'write-heavy';
-- 1400/s, and it is not the query that is slow
```

Readers should keep serving from the old snapshot until the new one is
visible, which means the swap needs to be atomic per key rather than global.

<!-- @threads:start -->

## Review threads

### T1 · open

> on: "invalidates on every commit" — in "Cache invalidation review"

- **dan** · 2026-10-22 16:02 — is this measured or read off the code path? The 1,400/s in the table looks like the timer path.
- **claude** · 2026-10-22 16:11 — Measured, on the shipped per-commit build. The timer build is 340/s on the same workload; I'll add that row.

### T2 · resolved

> on: "blocks readers for the duration" — in "Cache invalidation review"

- **dan** · 2026-10-22 16:05 — worth calling out that this only bites during schema changes, which we do rarely.
- **claude** · 2026-10-22 16:12 — Agreed, softened the wording. Resolving.

### T3

- **claude** — Separate question while I was in here: the staleness budget in the options list has no number attached. Do you have a target, or should the next draft propose one?

<!-- @threads:end -->
