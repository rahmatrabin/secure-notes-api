# Secure Notes API

[API health](https://secure-notes-api-sdr9.onrender.com/health) · [Open the web app](https://sec-notes.vercel.app) · [Frontend repository](https://github.com/rahmatrabin/secure-notes-web)

This is the API behind Secure Notes. It handles sign-in, notes, public posts, and admin user management. It is written in TypeScript with Express and stores data in MongoDB through Mongoose. Passwords are hashed with Argon2id, and sign-in returns a JWT access token.

## Run it locally

Use Node.js 24, npm, and a MongoDB deployment that supports transactions, such as Atlas or a local replica set.

From this repository in PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Open `.env` and set:

- `MONGODB_URI` to the URI for your development database.
- `JWT_SECRET` to the value generated above.
- `FRONTEND_ORIGIN` to your frontend's exact origin. For local development, use `http://localhost:5173`.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD` to the credentials for the initial local admin. New passwords need 6–128 characters and must include an uppercase letter, a lowercase letter, a number, and a special character.

```powershell
npm run build
npm run seed
npm start
```

Open [localhost:4000/health](http://localhost:4000/health). A ready API returns `{"status":"ok"}`. Use `npm run dev` for watch mode.

To add sample data, set `SEED_DEMO=1` and a separate `DEMO_PASSWORD` before running the seed. This creates two sample regular users, Asha and Rafi, with notes and public posts. Running the seed again preserves existing account passwords. Keep actual credentials and the `.env` file out of Git.

## API at a glance

- **Health and sign-in:** `GET /health` checks API readiness. `POST /auth/login` accepts an email and password. `GET /me` returns the signed-in profile.
- **My notes:** `GET /notes` lists your notes, and `POST /notes` creates one. Use `GET`, `PATCH`, or `DELETE` on `/notes/:id` to read, edit, or delete a note you own.
- **Admin:** `GET /admin/notes` lists all notes. Use `GET` or `POST /admin/users` to list active accounts or create a regular account. Use `PATCH` or `DELETE /admin/users/:id` to edit or deactivate a regular account. `GET /admin/interest-groups` groups users by interest.
- **Public posts:** Signed-in users can publish with `POST /posts`. Anyone can read an active author's public posts through `GET /users/:id/posts`.

Send JSON for write requests and `Authorization: Bearer <token>` for protected requests. Lists accept a `limit` from 1 to 50, defaulting to 20. Pass the response's `nextCursor` as the next request's `cursor`. A null cursor means there are no more results.

The API checks role and ownership on protected requests. Deactivation disables the account and hides its public author page while keeping its saved records. JWTs expire after 30 minutes. Password resets and deactivation change the account's token version, so existing tokens fail subsequent access checks.

## How the two reports work

**Users by interest.** A user who likes chess and reading has one membership row for each interest. The endpoint makes one `collection.aggregate()` call. MongoDB reads a page in interest and user ID order, then groups the rows for display. A group can continue on the next page. User changes and membership changes are saved in the same transaction.

**Posts by author.** A single aggregation finds the active author and uses `$lookup` to join their posts. Pagination is applied within the lookup, so the API fetches one page at a time.

The backend defines its indexes in `src/models.ts`. The four-index patch keeps the unique email index, the notes and posts pagination indexes, and the interest membership index. Its membership writes use both the interest and user ID, so they can use the same compound index as pagination. The earlier version also defined `interest_user_sync`; on an existing database, that index can be removed once all processes use the four-index code. MongoDB's built-in `_id_` indexes are separate from this count.

## Tests

Point `MONGODB_TEST_URI` at a disposable MongoDB replica set and run:

```powershell
npm test
npm run explain
```

The scripts create and clean up temporary databases. The tests cover access rules, note and account operations, pagination, and the aggregation endpoints. The explain script shows which indexes the queries use and how many documents and keys they examine.

## Deploy to Render

Create a Node web service from this repository. Use `npm ci --include=dev && npm run build` for the build command, `npm start` for the start command, and `/health` for the health check.

Set the production `MONGODB_URI`, `JWT_SECRET`, and `FRONTEND_ORIGIN` on Render. For this project's frontend, use `https://sec-notes.vercel.app` as the origin. The API can use its in-memory login limiter on a single instance. For multiple instances, set a shared `REDIS_URL`.

If you are upgrading an older database that predates interest memberships, back up the database and stop the API and any jobs that write users. With the updated backend built and its environment pointing at that database, run:

```powershell
$env:INTEREST_BACKFILL = 'offline'
node dist/backfill-interests.js
Remove-Item Env:INTEREST_BACKFILL
```

The script rebuilds the membership rows from existing users. After it completes, start the API and check **Interests** in the admin view. A fresh database gets membership rows when accounts are seeded or created.
