import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { connectDatabase, Note, Post, User } from './models.js';
import { interestsPipeline, postsPipeline } from './queries.js';

type Plan = {
  stage?: string;
  indexName?: string;
  indexesUsed?: string[];
  nReturned?: number;
  totalKeysExamined?: number;
  totalDocsExamined?: number;
};

function summarize(value: unknown) {
  const plans: Plan[] = [];
  function visit(node: unknown) {
    if (typeof node !== 'object' || node === null) return;
    const data = node as Record<string, unknown> & Plan;
    const { stage, indexName, indexesUsed, nReturned, totalKeysExamined, totalDocsExamined } = data;
    if (stage || indexesUsed || totalDocsExamined !== undefined) {
      plans.push({ stage, indexName, indexesUsed, nReturned, totalKeysExamined, totalDocsExamined });
    }
    for (const [key, child] of Object.entries(data)) {
      if (key !== 'rejectedPlans' && key !== 'allPlansExecution') visit(child);
    }
  }
  visit(value);
  return plans;
}

const dbName = 'secure_notes_explain_' + randomBytes(6).toString('hex');
let cleanup = false;
try {
  const uri = new URL(process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017');
  uri.pathname = '/' + dbName;
  await connectDatabase(uri.toString());
  cleanup = true;

  // These records live in a temporary database and are never available to the app.
  const users = Array.from({ length: 400 }, (_, n) => ({
    _id: new Types.ObjectId(), email: 'demo' + n + '@example.test', name: 'User ' + n,
    interests: [n % 2 ? 'chess' : 'reading'], active: true
  }));
  await User.collection.insertMany(users);
  const ids = users.flatMap(user => Array.from({ length: 12 }, () => user._id));
  await Note.collection.insertMany(ids.map(ownerId => ({ ownerId, title: 'Explain fixture', body: '' })));
  await Post.collection.insertMany(ids.map(authorId => ({ authorId, title: 'Explain fixture', body: 'Public' })));

  const account = users[0];
  const cursor = (await Note.find({ ownerId: account._id }).sort({ _id: -1 }).skip(1).limit(1).lean())[0]._id;
  const postCursor = (await Post.find({ authorId: account._id }).sort({ _id: -1 }).skip(1).limit(1).lean())[0]._id;
  const reports = {
    login: await User.findOne({ email: account.email }).explain('executionStats'),
    profile: await User.findById(account._id).explain('executionStats'),
    ownNote: await Note.findOne({ _id: cursor, ownerId: account._id }).explain('executionStats'),
    ownNotesPage: await Note.find({ ownerId: account._id, _id: { $lt: cursor } })
      .sort({ _id: -1 }).limit(6).explain('executionStats'),
    adminUsersPage: await User.find({ active: true, _id: { $lt: users[350]._id } })
      .sort({ _id: -1 }).limit(6).explain('executionStats'),
    adminNotesPage: await Note.find({ _id: { $lt: cursor } }).sort({ _id: -1 }).limit(6).explain('executionStats'),
    publicPostsPage: await User.aggregate(postsPipeline(account._id, 5, postCursor)).explain('executionStats'),
    interestGroups: await User.aggregate(interestsPipeline(5)).explain('executionStats')
  };
  console.log(JSON.stringify(Object.fromEntries(Object.entries(reports).map(([name, report]) =>
    [name, summarize(report)]
  )), null, 2));
} catch (error) {
  console.error('Explain run failed. Check MONGODB_TEST_URI and test database permissions.',
    error instanceof Error ? error.name : '');
  process.exitCode = 1;
} finally {
  try {
    if (cleanup) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
}
