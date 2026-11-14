import { randomBytes } from 'node:crypto';
import { hashPassword } from './security.js';
import mongoose, { Types } from 'mongoose';
import { readDatabaseUri } from './config.js';
import { membershipRows } from './interest-memberships.js';
import { connectDatabase, InterestMembership, Note, Post, User } from './models.js';

const tags = ['chess', 'reading', 'running', 'music', 'gaming', 'cooking', 'travel', 'coding'];
const BATCH_SIZE = 1000;

try {
  const uri = readDatabaseUri();
  const dbName = new URL(uri).pathname;
  if (dbName !== '/secure_notes_scale_test' || process.env.SCALE_FIXTURES !== '1') {
    throw new Error('Use the isolated secure_notes_scale_test database and SCALE_FIXTURES=1');
  }
  await connectDatabase(uri);
  if (await User.exists({ email: /^scale-/ })) {
    throw new Error('Scale fixtures already exist. Use a fresh staging database.');
  }
  const now = new Date();
  const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
  const total = Number(process.env.SCALE_USERS ?? '1000000');
  if (!Number.isSafeInteger(total) || total < 1 || total > 1_000_000) {
    throw new Error('SCALE_USERS must be an integer between 1 and 1000000');
  }
  for (let start = 0; start < total; start += BATCH_SIZE) {
    const count = Math.min(total - start, BATCH_SIZE);
    const users = Array.from({ length: count }, (_, offset) => {
      const i = start + offset;
      return {
        _id: new Types.ObjectId(), name: 'Scale User ' + i,
        email: 'scale-' + i + '@example.test', passwordHash,
        tokenVersion: 0, role: 'user' as const, active: true,
        interests: ['reading', tags[i % tags.length]], createdAt: now, updatedAt: now
      };
    });
    await User.collection.insertMany(users);
    await InterestMembership.insertMany(users.flatMap(membershipRows));
    await Note.collection.insertMany(users.map(user => ({
      ownerId: user._id, title: 'Scale note', body: 'Example private note',
      createdAt: now, updatedAt: now
    })));
    await Post.collection.insertMany(users.map(user => ({
      authorId: user._id, title: 'Scale post', body: 'Example public post',
      createdAt: now, updatedAt: now
    })));
    if ((start + count) % 50_000 === 0 || start + count === total) {
      console.log('Fixture users inserted:', start + count);
    }
  }
} catch (error) {
  console.error('Fixture generation failed:', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}