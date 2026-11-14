import { createHash } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { readDatabaseUri } from './config.js';
import { connectDatabase, Note, Post, User } from './models.js';
import { email, password } from './input.js';
import { hashPassword } from './security.js';
import { syncInterestMemberships } from './interest-memberships.js';

function fixtureId(userId: Types.ObjectId, type: string, number: number) {
  const hex = createHash('sha256').update(type + ':' + userId + ':' + number).digest('hex');
  return new Types.ObjectId(hex.slice(0, 24));
}

type SeedUser = { name: string; email: string; password: string; role: 'user' | 'admin'; interests: string[] };

async function ensureUser(input: SeedUser) {
  const { password, ...fields } = input;
  const passwordHash = await hashPassword(password);
  return mongoose.connection.transaction(async session => {
    const user = await User.findOneAndUpdate({ email: input.email }, {
      $setOnInsert: { ...fields, passwordHash, active: true, tokenVersion: 0,
        createdAt: new Date(), updatedAt: new Date() }
    }, { upsert: true, returnDocument: 'after', timestamps: false, setDefaultsOnInsert: false, session });
    if (!user || user.role !== input.role || !user.active) {
      throw new Error('Seed email already belongs to a conflicting or inactive account');
    }
    await syncInterestMemberships(user, session);
    return user;
  });
}

try {
  const adminEmail = email.parse(process.env.ADMIN_EMAIL);
  const adminPassword = password.parse(process.env.ADMIN_PASSWORD);
  const seedDemo = process.env.SEED_DEMO === '1';
  const demoPassword = seedDemo ? password.parse(process.env.DEMO_PASSWORD) : '';
  if (seedDemo && (demoPassword === adminPassword || ['asha@example.test', 'rafi@example.test'].includes(adminEmail))) {
    throw new Error('Use distinct admin credentials and a separate admin email');
  }
  await connectDatabase(readDatabaseUri());
  await ensureUser({ name: 'Demo Admin', email: adminEmail, password: adminPassword, role: 'admin', interests: [] });
  console.log('Admin account ready:', adminEmail);
  if (seedDemo) {
    const demoUsers = [
      { name: 'Asha', email: 'asha@example.test', interests: ['chess', 'reading'] },
      { name: 'Rafi', email: 'rafi@example.test', interests: ['chess', 'running'] }
    ];
    for (const account of demoUsers) {
      const user = await ensureUser({ ...account, role: 'user', password: demoPassword });
      console.log('Demo user ready: %s (public posts ID %s)', account.email, user._id);
      for (let n = 1; n <= 3; n++) {
        const noteTitle = 'Private note ' + n;
        const postTitle = 'Public post ' + n;
        const now = new Date();
        await Note.updateOne({ _id: fixtureId(user._id, 'note', n) }, {
          $setOnInsert: {
            ownerId: user._id, title: noteTitle, body: 'Private sample content for ' + account.name + '.',
            createdAt: now, updatedAt: now
          }
        }, { upsert: true, timestamps: false });
        await Post.updateOne({ _id: fixtureId(user._id, 'post', n) }, {
          $setOnInsert: {
            authorId: user._id, title: postTitle, body: 'Public sample content by ' + account.name + '.',
            createdAt: now, updatedAt: now
          }
        }, { upsert: true, timestamps: false });
      }
    }
  }
} catch (error) {
  const dbError = error as { name?: string; code?: number; codeName?: string; message?: string };
  console.error('Seed failed', {
    name: dbError?.name,
    code: dbError?.code,
    codeName: dbError?.codeName,
    badAuth: /bad auth|authentication failed/i.test(dbError?.message ?? ''),
  });
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
