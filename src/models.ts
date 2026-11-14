import mongoose, { Schema } from 'mongoose';

const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user', required: true },
  active: { type: Boolean, default: true, required: true },
  tokenVersion: { type: Number, default: 0, required: true, select: false },
  interests: { type: [String], default: [] }
}, { timestamps: true, collection: 'users' });

const noteSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  body: { type: String, default: '' }
}, { timestamps: true, collection: 'notes' });

const postSchema = new Schema({
  authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  body: { type: String, required: true }
}, { timestamps: true, collection: 'posts' });

const interestMembershipSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  interest: { type: String, required: true },
  name: { type: String, required: true }
}, { collection: 'interest_memberships', versionKey: false });

interestMembershipSchema.index(
  { interest: 1, userId: 1 }, { unique: true, name: 'interest_user_cursor' }
);
interestMembershipSchema.index({ userId: 1 }, { name: 'interest_user_sync' });

userSchema.index({ email: 1 }, { unique: true, name: 'email_unique' });
noteSchema.index({ ownerId: 1, _id: -1 }, { name: 'notes_owner_cursor' });
postSchema.index({ authorId: 1, _id: -1 }, { name: 'posts_author_cursor' });

export const User = mongoose.model('User', userSchema);
export const Note = mongoose.model('Note', noteSchema);
export const Post = mongoose.model('Post', postSchema);

export const InterestMembership = mongoose.model('InterestMembership', interestMembershipSchema);

export async function connectDatabase(uri: string, options: {
  manageIndexes?: boolean;
  maxPoolSize?: number;
} = {}) {
  const { manageIndexes = true, maxPoolSize = 10 } = options;
  await mongoose.connect(uri, {
    autoIndex: manageIndexes,
    autoCreate: manageIndexes,
    serverSelectionTimeoutMS: 8000,
    waitQueueTimeoutMS: 2000,
    maxPoolSize
  });
  if (manageIndexes) {
    await Promise.all([User.init(), Note.init(), Post.init(), InterestMembership.init()]);
  }
}
