# MongoDB query plans

These results are from the Secure Notes API at commit `e662686`, tested on a local MongoDB Community 7.0.26 replica set. The explain script created 400 active users, 4,800 notes, 4,800 public posts, and 400 interest memberships. Each page example requests five results and reads one extra candidate to determine whether another page exists. The counts below describe database work on this fixture.

| Query | Index or access path | Keys examined | Documents examined |
| --- | --- | ---: | ---: |
| Login by email | `email_unique` | 1 | 1 |
| Account lookup by ID | Built-in ID lookup (`IDHACK`) | 1 | 1 |
| Note by ID with owner check | `_id_` | 1 | 1 |
| Own notes, cursor page | `notes_owner_cursor` | 6 | 6 |
| Admin users, cursor page | `_id_` | 6 | 6 |
| Admin all notes, cursor page | `_id_` | 6 | 6 |
| Public posts, author match | `_id_` | 1 | 1 |
| Public posts, foreign `$lookup` | `posts_author_cursor` | 6 | 6 |
| Interest groups, first page | `interest_user_cursor` | 6 | 6 |
| Interest groups, later page (same interest) | `interest_user_cursor` | 6 | 6 |
| Interest groups, later page (subsequent interests) | `interest_user_cursor` | 6 | 6 |

## Why these indexes are here

- `email_unique` on `users` supports login by normalized email and enforces uniqueness.
- `notes_owner_cursor` on `notes` supports owner filtering and descending ID pagination.
- `posts_author_cursor` on `posts` supports author filtering and descending ID pagination inside `$lookup`.
- `interest_user_cursor` on `interest_memberships` keeps rows in `(interest, userId)` order and enforces uniqueness for that pair. Writes locate each membership using both fields, so they can use the same index.

All four custom indexes are declared with `schema.index()` in `src/models.ts`. The built-in `_id_` indexes handle ID lookups and the admin lists. The admin user list also filters on `active`. The fixture contains only active users, so it does not measure the extra scan work that could occur when many accounts are inactive.

## Interest groups and public posts

The interest endpoint makes one `collection.aggregate()` call. It reads a bounded page of membership rows and then groups those rows by interest. A later page uses two index ranges inside the same pipeline: the rest of the current interest and the interests that sort after it. Each range produced six candidates in the test, and the combined pipeline applies the page limit before grouping. The older approach sorted rows after expanding the users' interest arrays. The current pipeline reads membership rows directly in index order.

The public posts endpoint also uses one aggregation pipeline. It matches the active author by ID, then applies the post cursor, order, and limit inside `$lookup`. The explain output reports the foreign index separately from the author lookup.

## Reproduce the results

Point `MONGODB_TEST_URI` at a disposable MongoDB deployment, then run these commands from the backend repository:

```powershell
npm run build
npm run explain
```

The script creates a temporary database, prints the execution statistics, and drops that database when it finishes. The MongoDB account needs permission to perform those operations. No index hints are used. Results can vary with MongoDB version and data distribution. This check does not measure production latency or concurrent traffic capacity.
