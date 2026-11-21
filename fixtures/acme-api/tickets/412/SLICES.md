# Slices

1. **S1 Counter store** — per-user counter in Redis with a 60 s window. ✓ done
2. **S2 Middleware** — `src/middleware/limit.ts` returns 429 after 5 attempts. ← now
3. **S3 429 page** — friendly page with retry-after.
