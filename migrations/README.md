# Migrations

`schema.sql` is the full, idempotent schema and is always safe to re-run. When a
later change needs more than `CREATE ... IF NOT EXISTS` (for example adding a
column to an existing table), add a file here:

```
migrations/0001-short-name.sql
```

Rules:
- Idempotent where SQLite allows it; otherwise guard with a comment explaining the
  one-time step. (`ALTER TABLE ... ADD COLUMN` fails if the column exists, so check
  `PRAGMA table_info(<table>)` first, or wrap in the README instructions.)
- Also update `schema.sql` so a fresh database has the column, then run
  `npm run schema:oneline`.
- Apply with `npx wrangler d1 execute fuego-steakhouse --remote --file=migrations/0001-short-name.sql`
  (preview first: `fuego-steakhouse-preview`).
