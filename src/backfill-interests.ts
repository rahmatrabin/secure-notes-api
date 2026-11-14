import mongoose from 'mongoose';
import { readDatabaseUri } from './config.js';
import { membershipRows } from './interest-memberships.js';
import { connectDatabase, InterestMembership, User } from './models.js';

try {
  if (process.env.INTEREST_BACKFILL !== 'offline') {
    throw new Error('Stop all user writers and set INTEREST_BACKFILL=offline');
  }
  await connectDatabase(readDatabaseUri());

  // Only the derived collection is cleared. Run while the API and seed jobs are stopped.
  await InterestMembership.deleteMany({});
  let batch: ReturnType<typeof membershipRows> = [];
  let inserted = 0;
  for await (const user of User.find({ active: true }).select('name active interests').lean().cursor()) {
    batch.push(...membershipRows(user));
    if (batch.length >= 2000) {
      await InterestMembership.insertMany(batch, { ordered: true });
      inserted += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await InterestMembership.insertMany(batch, { ordered: true });
    inserted += batch.length;
  }
  const actual = await InterestMembership.countDocuments({});
  if (actual !== inserted) throw new Error('Membership count mismatch');
  console.log('Interest backfill complete. Verified rows:', actual);
} catch (error) {
  console.error('Interest backfill did not complete:', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}