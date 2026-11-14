import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { createApp } from '../dist/app.js';
import { connectDatabase, InterestMembership, Note, Post, User } from '../dist/models.js';
import { hashPassword } from '../dist/security.js';
import { syncInterestMemberships } from '../dist/interest-memberships.js';

const uri = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const dbName = 'secure_notes_test_' + randomBytes(6).toString('hex');
const secret = randomBytes(48).toString('hex');
const origin = 'http://localhost:5173';
const password = 'Test-only1!' + 'a'.repeat(49);
let server;
let baseUrl;
let cleanup = false;
let adminToken;
let ashaToken;
let rafiToken;
let asha;
let rafi;
let admin;
const noteIds = [];

async function request(path, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(body && { 'Content-Type': 'application/json' }), ...headers
    },
    body: body && JSON.stringify(body)
  });
  return {
    status: response.status,
    headers: response.headers,
    data: response.status === 204 ? null : await response.json()
  };
}

async function login(email, input = password) {
  const response = await request('/auth/login', { method: 'POST', body: { email, password: input } });
  assert.equal(response.status, 200);
  assert.equal(response.data.user.passwordHash, undefined);
  assert.equal(response.data.user.tokenVersion, undefined);
  return response.data.token;
}

before(async () => {
  const url = new URL(uri);
  url.pathname = '/' + dbName;
  await connectDatabase(url.toString());
  cleanup = true;
  const passwordHash = await hashPassword(password);
  [admin, asha, rafi] = await User.create([
    { name: 'Admin', email: 'admin@example.test', role: 'admin', passwordHash },
    { name: 'Asha', email: 'asha@example.test', interests: ['reading', 'chess'], passwordHash },
    { name: 'Rafi', email: 'rafi@example.test', interests: ['chess'], passwordHash }
  ]);
  await mongoose.connection.transaction(async session => {
    for (const user of [asha, rafi]) await syncInterestMemberships(user, session);
  });
  server = createApp({ secret, frontendOrigin: origin }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  adminToken = await login(admin.email);
  ashaToken = await login(' ASHA@example.test ');
  rafiToken = await login(rafi.email);
});

after(async () => {
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  try {
    if (cleanup) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

test('health, CORS, password confidentiality and JWT tampering/expiration', async () => {
  const health = await request('/health', { headers: { Origin: origin } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), origin);
  const foreign = await request('/health', { headers: { Origin: 'https://elsewhere.test' } });
  assert.notEqual(foreign.headers.get('access-control-allow-origin'), 'https://elsewhere.test');
  assert.equal((await request('/me')).status, 401);
  assert.equal((await request('/me', { token: ashaToken.slice(0, -12) + '9'.repeat(12) })).status, 401);
  const expired = jwt.sign({ ver: 0 }, secret, {
    expiresIn: -1, subject: String(asha._id), issuer: 'secure-notes-api', audience: 'secure-notes-client'
  });
  assert.equal((await request('/me', { token: expired })).status, 401);
  const user = await request('/me', { token: ashaToken });
  assert.equal(user.data.name, 'Asha');
  assert.equal(user.headers.get('cache-control'), 'no-store');
  assert.equal(user.data.passwordHash, undefined);
  assert.match((await User.findById(asha._id).select('+passwordHash')).passwordHash, /^\$argon2id\$/);
  const wrong = await request('/auth/login', { method: 'POST', body: { email: asha.email, password: 'wrong' } });
  const missing = await request('/auth/login', {
    method: 'POST', body: { email: 'unknown@example.test', password: 'wrong' }
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, missing.data);
});

test('own notes CRUD and pagination; foreign notes resist reads, writes and injected ownership', async () => {
  for (let n = 0; n < 5; n++) {
    const created = await request('/notes', {
      token: ashaToken, method: 'POST', body: { title: 'Note ' + n, body: 'Original body' }
    });
    assert.equal(created.status, 201);
    noteIds.push(created.data._id);
  }
  const path = '/notes/' + noteIds[0];
  for (const token of [rafiToken, adminToken]) {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await request(path, { token, method, ...(method === 'PATCH' && { body: { title: 'changed' } }) });
      assert.equal(response.status, 404);
    }
  }
  assert.equal((await request('/notes', {
    token: rafiToken, method: 'POST', body: { title: 'Injected', ownerId: String(asha._id) }
  })).status, 400);
  assert.equal((await request('/notes', { token: rafiToken })).data.items.length, 0);
  const patched = await request(path, { token: ashaToken, method: 'PATCH', body: { title: 'Changed' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.body, 'Original body');
  assert.equal((await request(path, { token: ashaToken })).data.title, 'Changed');
  const visited = await walk('/notes', ashaToken);
  assert.deepEqual(visited.map(item => item._id), [...noteIds].reverse());
  assert.equal((await request('/notes?limit=999', { token: ashaToken })).status, 400);
  assert.equal((await request('/notes?cursor=bad', { token: ashaToken })).status, 400);
  assert.equal((await request('/admin/notes', { token: rafiToken })).status, 403);
  assert.deepEqual((await walk('/admin/notes', adminToken)).map(item => item._id), [...noteIds].reverse());
  assert.equal((await request(path, { token: ashaToken, method: 'DELETE' })).status, 204);
  assert.equal((await request(path, { token: ashaToken, method: 'DELETE' })).status, 404);
});

async function walk(path, token, limit = 2) {
  const items = [];
  let cursor = null;
  for (let n = 0; n < 10; n++) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const response = await request(path + '?' + params, { token });
    assert.equal(response.status, 200);
    items.push(...response.data.items);
    cursor = response.data.nextCursor;
    if (!cursor) return items;
  }
  assert.fail('Cursor failed to terminate');
}

test('grouped interest membership pagination, including a group split across pages', async () => {
  const rows = await walk('/admin/interest-groups', adminToken, 1);
  assert.deepEqual(rows.map(group => [group.interest, group.users[0].name]), [
    ['chess', 'Asha'], ['chess', 'Rafi'], ['reading', 'Asha']
  ]);
  assert.deepEqual(Object.keys(rows[0].users[0]).sort(), ['_id', 'name']);
  assert.equal((await request('/admin/interest-groups?cursor=bad', { token: adminToken })).status, 400);
  assert.equal((await request('/admin/interest-groups', { token: ashaToken })).status, 403);
});

test('one public author returns only their posts, with pages and safe fields', async () => {
  const path = '/users/' + asha._id + '/posts';
  assert.deepEqual((await request(path)).data.items, []);
  const expected = [];
  for (let n = 0; n < 5; n++) {
    const result = await request('/posts', {
      token: ashaToken, method: 'POST', body: { title: 'Post ' + n, body: 'Public text' }
    });
    assert.equal(result.status, 201);
    expected.unshift(result.data._id);
  }
  assert.equal((await request('/posts', {
    token: rafiToken, method: 'POST', body: { title: 'A separate author', body: 'Public text' }
  })).status, 201);
  assert.deepEqual((await walk(path)).map(item => item._id), expected);
  assert.deepEqual(Object.keys((await request(path)).data.author).sort(), ['_id', 'name']);
  assert.equal((await request('/users/' + new Types.ObjectId() + '/posts')).status, 404);
  assert.equal((await request('/users/nope/posts')).status, 400);
});

test('admin users CRUD, duplicate email under concurrency, role escalation and session invalidation', async () => {
  const path = '/admin/users';
  const body = { name: 'Nila', email: 'nila@example.test', password, interests: ['Chess', ' chess '] };
  assert.equal((await request(path, { token: ashaToken, method: 'POST', body })).status, 403);
  assert.equal((await request(path, { token: adminToken, method: 'POST', body: { ...body, role: 'admin' } })).status, 400);
  const responses = await Promise.all([1, 2].map(() => request(path, { token: adminToken, method: 'POST', body })));
  assert.deepEqual(responses.map(item => item.status).sort(), [201, 409]);
  const { data: account } = responses.find(item => item.status === 201);
  assert.deepEqual(account.interests, ['chess']);
  assert.equal(account.passwordHash, undefined);
  assert.equal((await walk(path, adminToken)).length, 4);
  const accountPath = path + '/' + account._id;
  const renamed = await request(accountPath, { token: adminToken, method: 'PATCH', body: { name: 'New name' } });
  assert.deepEqual(renamed.data.interests, ['chess']);
  const groupMembers = async () => (await walk('/admin/interest-groups', adminToken, 1))
    .flatMap(group => group.users.map(user => ({ interest: group.interest, ...user })))
    .filter(user => user._id === account._id);
  assert.deepEqual(await groupMembers(), [
    { interest: 'chess', _id: account._id, name: 'New name' }
  ]);
  const moved = await request(accountPath, {
    token: adminToken, method: 'PATCH', body: { interests: ['running', 'reading'] }
  });
  assert.equal(moved.status, 200);
  assert.deepEqual((await groupMembers()).map(user => user.interest), ['reading', 'running']);
  const old = await login(body.email);
  const newPassword = 'Changed-only2!' + 'b'.repeat(46);
  const changed = await request(accountPath, { token: adminToken, method: 'PATCH', body: { password: newPassword } });
  assert.equal(changed.status, 200);
  assert.equal((await request('/me', { token: old })).status, 401);
  const latest = await login(body.email, newPassword);
  const created = await request('/notes', { token: latest, method: 'POST', body: { title: 'Retained' } });
  assert.equal((await request(path + '/' + admin._id, { token: adminToken, method: 'DELETE' })).status, 404);
  assert.equal((await request(accountPath, { token: adminToken, method: 'DELETE' })).status, 204);
  assert.deepEqual(await groupMembers(), []);
  assert.equal((await request('/me', { token: latest })).status, 401);
  assert.equal((await request('/users/' + account._id + '/posts')).status, 404);
  assert.equal((await walk(path, adminToken)).length, 3);
  assert.ok(await Note.exists({ _id: created.data._id }));
});

test('only the declared query and membership sync indexes exist', async () => {
  const indexes = await Promise.all([User, Note, Post, InterestMembership]
    .map(model => model.collection.indexes()));
  assert.deepEqual(indexes.map(list => list.map(index => index.name).sort()), [
    ['_id_', 'email_unique'], ['_id_', 'notes_owner_cursor'], ['_id_', 'posts_author_cursor'],
    ['_id_', 'interest_user_cursor', 'interest_user_sync']
  ]);
  assert.equal(indexes[0].find(index => index.name === 'email_unique').unique, true);
  assert.equal(indexes[3].find(index => index.name === 'interest_user_cursor').unique, true);
});
