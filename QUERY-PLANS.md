# Measured MongoDB query plans

Executed against MongoDB Community **7.0.24** with 400 active users, 4,800 notes, and 4,800 posts. Cursor-page examples request five rows and fetch one extra to detect the next page. These are observed work counts for this fixture, not latency estimates.

| Query or stage | Observed plan/index | Keys examined | Documents examined |
|---|---|---:|---:|
| Login by email | `IXSCAN`, `email_unique` | 1 | 1 |
| Account lookup by ID | `IDHACK` | 1 | 1 |
| Note lookup by ID with an owner check | `IXSCAN`, `_id_` | 1 | 1 |
| Own notes, cursor page | `IXSCAN`, `notes_owner_cursor` | 6 | 6 |
| Admin users, cursor page | `IXSCAN`, `_id_` | 6 | 6 |
| Admin all notes, cursor page | `IXSCAN`, `_id_` | 6 | 6 |
| Public posts, author match | `IXSCAN`, `_id_` | 1 | 1 |
| Public posts, foreign `$lookup` | `indexesUsed: ["posts_author_cursor"]` | 6 | 6 |
| Global interests report, source scan | `COLLSCAN` | 0 | 400 |

The report applies its membership cursor and sort after `$unwind`. The page bounds the returned membership count. MongoDB still examines the source users for each page. Adding a multikey index to support a global report would require a different input query shape to be useful.

Reproduce with `npm run build` followed by `npm run explain`. No index hints are used. The script seeds a temporary database, prints the observed plans, and drops that temporary database. Results may vary with MongoDB version and data distribution.
