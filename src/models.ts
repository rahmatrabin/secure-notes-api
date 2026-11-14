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

userSchema.index({ email: 1 }, { unique: true, name: 'email_unique' });
noteSchema.index({ ownerId: 1, _id: -1 }, { name: 'notes_owner_cursor' });
postSchema.index({ authorId: 1, _id: -1 }, { name: 'posts_author_cursor' });

export const User = mongoose.model('User', userSchema);
export const Note = mongoose.model('Note', noteSchema);
export const Post = mongoose.model('Post', postSchema);

export async function connectDatabase(uri: string) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
  // Startup waits for the declared indexes, including the unique login constraint.
  await Promise.all([User.init(), Note.init(), Post.init()]);
}
