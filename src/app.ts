import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit, type Store } from 'express-rate-limit';
import mongoose, { Types } from 'mongoose';
import { z, ZodError } from 'zod';
import {
  ApiError, createUser, loginInput, noteInput, objectId, page, pageQuery, pageSize,
  postInput, updateNote, updateUser
} from './input.js';
import { InterestMembership, Note, Post, User } from './models.js';
import { syncInterestMemberships } from './interest-memberships.js';
import { interestsPipeline, postsPipeline } from './queries.js';
import { authenticate, hashPassword, issueToken, requireAdmin, verifyPassword, type Principal } from './security.js';

type AppConfig = {
  secret: string;
  frontendOrigin: string;
  trustProxy?: number;
  loginStore?: Store;
};
type PublicUser = {
  _id: Types.ObjectId; name: string; email: string; role: string; active: boolean; interests: string[];
};
type Member = { _id: Types.ObjectId; name: string };
type Group = { _id: string; users: Member[] };
type PublicPost = { _id: Types.ObjectId; title: string; body: string; createdAt: Date };

const userFields = 'name email role active interests';
const noteFields = 'ownerId title body createdAt updatedAt';
const interestQuery = z.strictObject({ limit: pageSize, cursor: z.string().min(1).max(450).optional() });
const interestPosition = z.strictObject({ interest: z.string().min(1).max(40), userId: objectId });

function exposeUser(user: PublicUser) {
  const { _id, name, email, role, active, interests } = user;
  return { _id, name, email, role, active, interests };
}

function readInterestCursor(raw?: string) {
  if (!raw) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('Malformed cursor');
    return interestPosition.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new ApiError(400, 'Invalid interest cursor');
  }
}

function paginationFilter(cursor?: Types.ObjectId) {
  return cursor ? { _id: { $lt: cursor } } : {};
}

const handleError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof ApiError) return res.status(error.status).json({ message: error.message });
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: 'Invalid input',
      issues: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
    });
  }
  if (error?.code === 50 || error?.name === 'MongoWaitQueueTimeoutError' ||
    error?.name === 'MongoServerSelectionError' || error?.name === 'MongoNotConnectedError') {
    res.set('Retry-After', '1');
    return res.status(503).json({ message: 'The service is busy. Try again shortly.' });
  }
  if (error?.code === 11000) return res.status(409).json({ message: 'Email is already in use' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ message: 'Request is too large' });
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON' });
  // Log a diagnostic category without request bodies, JWTs, or connection strings.
  console.error('Request failed', error instanceof Error ? error.name : 'UnknownError');
  return res.status(500).json({ message: 'Unexpected server error' });
};

export function createApp(config: AppConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 0);
  app.use(helmet());
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cors({ origin: config.frontendOrigin, methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'] }));
  app.use(express.json({ limit: '64kb' }));
  const auth = authenticate(config.secret);
  const principal = (res: express.Response) => res.locals.principal as Principal;
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 25, skipSuccessfulRequests: true,
    store: config.loginStore,
    requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.statusCode >= 500,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { message: 'Too many login attempts. Try again later.' } });

  app.get('/health', (_req, res) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
  });

  // Bound memory and worker-thread pressure from simultaneous Argon2 checks per API process.
  let activeLogins = 0;
  app.post('/auth/login', loginLimiter, async (req, res) => {
    const input = loginInput.parse(req.body);
    if (activeLogins >= 4) {
      res.set('Retry-After', '1');
      throw new ApiError(503, 'Login is busy. Try again shortly.');
    }
    activeLogins++;
    try {
      const user = await User.findOne({ email: input.email })
        .select(userFields + ' +passwordHash +tokenVersion').lean();
      const valid = await verifyPassword(user?.passwordHash, input.password);
      if (!user?.active || !valid) throw new ApiError(401, 'Invalid email or password');
      res.json({ token: issueToken(user._id, user.tokenVersion, config.secret), user: exposeUser(user) });
    } finally {
      activeLogins--;
    }
  });

  app.get('/me', auth, async (_req, res) => {
    const user = await User.findOne({ _id: principal(res).id, active: true }).select(userFields).lean();
    if (!user) throw new ApiError(401, 'Invalid or expired session');
    res.json(exposeUser(user));
  });

  const notes = express.Router();
  notes.use(auth);
  notes.get('/', async (req, res) => {
    const { limit, cursor } = pageQuery.parse(req.query);
    const rows = await Note.find({ ownerId: principal(res).id, ...paginationFilter(cursor) })
      .select(noteFields).sort({ _id: -1 }).limit(limit + 1).lean();
    res.json(page(rows, limit, row => row._id.toHexString(), row => row));
  });
  notes.post('/', async (req, res) => {
    const input = noteInput.parse(req.body);
    const note = await Note.create({ ...input, ownerId: principal(res).id });
    const { _id, ownerId, title, body, createdAt, updatedAt } = note;
    res.status(201).json({ _id, ownerId, title, body, createdAt, updatedAt });
  });
  const ownedNote = (id: unknown, res: express.Response) => ({ _id: objectId.parse(id), ownerId: principal(res).id });
  notes.get('/:id', async (req, res) => {
    const note = await Note.findOne(ownedNote(req.params.id, res)).select(noteFields).lean();
    if (!note) throw new ApiError(404, 'Note not found');
    res.json(note);
  });
  notes.patch('/:id', async (req, res) => {
    const note = await Note.findOneAndUpdate(ownedNote(req.params.id, res),
      { $set: updateNote.parse(req.body) }, { returnDocument: 'after', runValidators: true })
      .select(noteFields).lean();
    if (!note) throw new ApiError(404, 'Note not found');
    res.json(note);
  });
  notes.delete('/:id', async (req, res) => {
    const result = await Note.deleteOne(ownedNote(req.params.id, res));
    if (!result.deletedCount) throw new ApiError(404, 'Note not found');
    res.sendStatus(204);
  });
  app.use('/notes', notes);

  const admin = express.Router();
  admin.use(auth, requireAdmin);
  admin.get('/notes', async (req, res) => {
    const { limit, cursor } = pageQuery.parse(req.query);
    const rows = await Note.find(paginationFilter(cursor)).select(noteFields)
      .sort({ _id: -1 }).limit(limit + 1).lean();
    res.json(page(rows, limit, row => row._id.toHexString(), row => row));
  });
  admin.get('/users', async (req, res) => {
    const { limit, cursor } = pageQuery.parse(req.query);
    const rows = await User.find({ active: true, ...paginationFilter(cursor) }).select(userFields)
      .sort({ _id: -1 }).limit(limit + 1).lean();
    res.json(page(rows, limit, row => row._id.toHexString(), exposeUser));
  });
  admin.post('/users', async (req, res) => {
    const { password, ...input } = createUser.parse(req.body);
    const passwordHash = await hashPassword(password);
    const user = await mongoose.connection.transaction(async session => {
      const account = new User({ ...input, passwordHash });
      await account.save({ session });
      await syncInterestMemberships(account, session);
      return account;
    });
    res.status(201).json(exposeUser(user));
  });
  admin.patch('/users/:id', async (req, res) => {
    const id = objectId.parse(req.params.id);
    const { password, ...fields } = updateUser.parse(req.body);
    const update = password === undefined ? { $set: fields } : {
      $set: { ...fields, passwordHash: await hashPassword(password) },
      $inc: { tokenVersion: 1 }
    };
    const user = await mongoose.connection.transaction(async session => {
      const account = await User.findOneAndUpdate({ _id: id, active: true, role: 'user' }, update, {
        returnDocument: 'after', runValidators: true, session
      }).select(userFields).lean();
      if (!account) throw new ApiError(404, 'Regular user not found');
      if (fields.name !== undefined || fields.interests !== undefined) {
        await syncInterestMemberships(account, session);
      }
      return account;
    });
    res.json(exposeUser(user));
  });
  admin.delete('/users/:id', async (req, res) => {
    const id = objectId.parse(req.params.id);
    await mongoose.connection.transaction(async session => {
      const result = await User.updateOne({ _id: id, active: true, role: 'user' }, {
        $set: { active: false }, $inc: { tokenVersion: 1 }
      }, { session });
      if (!result.modifiedCount) throw new ApiError(404, 'Regular user not found');
      await InterestMembership.deleteMany({ userId: id }, { session });
    });
    res.sendStatus(204);
  });

  admin.get('/interest-groups', async (req, res) => {
    const { limit, cursor } = interestQuery.parse(req.query);
    const groups = await InterestMembership.collection.aggregate<Group>(
      interestsPipeline(limit, readInterestCursor(cursor)),
      { maxTimeMS: 3000 }
    ).toArray();
    const count = groups.reduce((sum, group) => sum + group.users.length, 0);
    let nextCursor: string | null = null;
    if (count > limit) {
      const lastGroup = groups[groups.length - 1];
      lastGroup.users.pop();
      if (!lastGroup.users.length) groups.pop();
      const visibleGroup = groups[groups.length - 1];
      const lastMember = visibleGroup.users[visibleGroup.users.length - 1];
      nextCursor = Buffer.from(JSON.stringify({
        interest: visibleGroup._id, userId: lastMember._id.toHexString()
      })).toString('base64url');
    }
    res.json({ items: groups.map(group => ({ interest: group._id, users: group.users })), nextCursor });
  });
  app.use('/admin', admin);

  app.post('/posts', auth, async (req, res) => {
    const post = await Post.create({ ...postInput.parse(req.body), authorId: principal(res).id });
    const { _id, authorId, title, body, createdAt } = post;
    res.status(201).json({ _id, authorId, title, body, createdAt });
  });
  app.get('/users/:id/posts', async (req, res) => {
    const id = objectId.parse(req.params.id);
    const { limit, cursor } = pageQuery.parse(req.query);
    const [author] = await User.aggregate<{ _id: Types.ObjectId; name: string; posts: PublicPost[] }>(
      postsPipeline(id, limit, cursor)
    );
    if (!author) throw new ApiError(404, 'Author not found');
    res.json({ author: { _id: author._id, name: author.name },
      ...page(author.posts, limit, row => row._id.toHexString(), row => row) });
  });

  app.use((_req, _res, next) => next(new ApiError(404, 'Route not found')));
  app.use(handleError);
  return app;
}
