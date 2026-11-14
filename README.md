# Secure Notes API

Express 5, TypeScript, Mongoose, JWT and Argon2id. The frontend is deployed separately.

## Local setup

Requires Node.js 24, npm, and MongoDB 7.0+ or Atlas. Run `npm ci`, copy `.env.example` to `.env`, and set `MONGODB_URI` and `JWT_SECRET`. Generate a random JWT secret with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. The API listens on port 4000 by default.

```sh
npm run build
npm run seed
npm start
```

Supply `ADMIN_EMAIL` and `ADMIN_PASSWORD` before running the seed. Set `SEED_DEMO=1` and `DEMO_PASSWORD` to include Asha and Rafi and their sample notes and posts. The seed preserves existing account credentials and does not elevate an existing regular account. To change a regular user's password, use the admin update route. The seed logs demo author IDs for public post URLs. Use `npm run dev` for watch mode.

## HTTP API

Use `Authorization: Bearer <token>` on protected routes. Send JSON for writes. All list routes accept optional `limit` (default 20, max 50) and `cursor`. Use the previous response's `nextCursor` unchanged for the next page. A null cursor indicates the end.

| Route | Access | Body fields or result |
|---|---|---|
| `GET /health` | Public | API readiness status |
| `POST /auth/login` | Public | `email`, `password` → token and safe user fields |
| `GET /me` | Signed in | Current user profile |
| `GET /notes` | Signed in | Page of own notes |
| `POST /notes` | Signed in | `title`, optional `body` |
| `GET /notes/:id` | Owner | One note |
| `PATCH /notes/:id` | Owner | `title` and/or `body` |
| `DELETE /notes/:id` | Owner | 204 |
| `GET /admin/notes` | Admin | Page of all notes including owner IDs |
| `GET /admin/users` | Admin | Page of active accounts |
| `POST /admin/users` | Admin | `name`, `email`, `password`, optional `interests` string array |
| `PATCH /admin/users/:id` | Admin | Editable fields from user creation, for regular accounts |
| `DELETE /admin/users/:id` | Admin | Deactivates regular account and returns 204 |
| `GET /admin/interest-groups` | Admin | Page of groups shaped as `{interest, users: [{_id, name}]}` |
| `POST /posts` | Signed in | `title`, `body` for a public post |
| `GET /users/:id/posts` | Public | Author summary plus that author's posts page |

### Permission and data choices

- Admins can view every note through the admin list. On the own-note routes, the database lookup or mutation requires both the note ID and authenticated owner ID, including for an admin. A foreign note returns 404. A regular account using an admin route gets 403.
- The seed bootstraps admin accounts and the admin UI manages regular accounts. Account removal deactivates the account, removes it from the active list/interest report, revokes authenticated access and hides its public author page. Notes and posts are retained in the database and the email remains reserved. Protected requests check account status and token version. A request already authorized before deactivation may finish.
- JWTs are signed with HS256 and validated for issuer, audience and expiry. They expire after 30 minutes. Admin password resets increment the token version in the same update as replacing the hash. Browser sign-out discards the browser's token. Login rate limiting uses an in-memory store for a single server instance. Deploy with the documented proxy setting only behind the expected proxy.
- Strict input schemas accept only known fields. The client cannot set note ownership, account role or token state. Public post responses expose a display name and posts, while protected user lists only return the fields needed by the UI.

## Index strategy

All three custom indexes are declared in `src/models.ts` via `schema.index()`. Startup waits for index creation. MongoDB creates a separate unique `_id_` index for each collection.

| Declared index | Query shape |
|---|---|
| `users { email: 1 }`, unique | Normalized login equality lookup and race-safe email uniqueness |
| `notes { ownerId: 1, _id: -1 }` | Owner equality plus descending ID sort and next-page bound |
| `posts { authorId: 1, _id: -1 }` | Author equality inside `$lookup` plus descending ID sort and next-page bound |

The built-in `_id_` supports account and note detail lookups and global lists in ID order. For admin users the active filter is applied to retrieved documents. A large dataset with a high fraction of inactive users could increase scan work. ID order is deterministic and is not advertised as exact creation-time order. Lists fetch one extra row to compute `nextCursor`; there is no separate total-count query.

**Interest report.** One native `User.collection.aggregate()` reads active users, projects safe fields, unwinds each interests array, sorts memberships by `(interest, userId)`, and limits before grouping the page with `$group`. The cursor contains the last visible membership's two sort keys. An interest can continue on the next page. There is no total member count per group. With stable data a membership occurs once. Edits between requests can move membership positions because the feed is not a snapshot. A full report needs to examine the source users and order computed memberships; the post-unwind sort is not served by a collection index. A multikey interest index would support a selective interest filter, which this report does not require.

**Posts.** One aggregation matches the active author by ID, then uses one `$lookup` with a foreign key equal to the author ID. Cursor, sort and limit are inside the lookup so only one page is materialized. A valid author with no posts returns an empty page. An unknown or deactivated author returns 404.

## Verify

Run the integration suite and query-plan checks against a **local or disposable MongoDB instance**.

```sh
npm test
npm run explain
```

The scripts default to local MongoDB. Set `MONGODB_TEST_URI` to override it. They each create a random temporary database and drop only that database after use. The database user needs permission to create and drop temporary databases. Keep the Atlas application user scoped to the application database.

`npm test` checks authentication and JWT integrity, ID-based note isolation, CRUD, all list categories, public post isolation and joins, concurrent duplicate emails, deactivation, password reset and index count. `npm run explain` uses 400 users, 4,800 notes and 4,800 posts. It prints summaries including keys examined, documents examined and lookup indexes. See [measured query plans](QUERY-PLANS.md).
