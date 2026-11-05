import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Large immutable workspace/batch payloads live in R2. D1 owns their current
// pointers, the balance version and the transaction that posts a reviewed batch.
export const allocationBatches = sqliteTable("allocation_batches", {
  id: text("id").primaryKey(),
  product: text("product").notNull(),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
  versionAtCreation: integer("version_at_creation").notNull(),
  status: text("status").notNull(),
  dataKey: text("data_key").notNull(),
  totalCents: integer("total_cents").notNull(),
  quantity: integer("quantity").notNull(),
  reviewDigest: text("review_digest").notNull(),
  completedAt: text("completed_at"),
});

export const allocationWorkspace = sqliteTable("allocation_workspace", {
  id: text("id").primaryKey(),
  version: integer("version").notNull().default(0),
  dataKey: text("data_key"),
  lastBatchId: text("last_batch_id").references(() => allocationBatches.id),
  updatedAt: text("updated_at").notNull(),
});

export const allocationReviews = sqliteTable(
  "allocation_reviews",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => allocationBatches.id),
    reviewerId: text("reviewer_id").notNull(),
    reviewerRunId: text("reviewer_run_id").notNull(),
    status: text("status").notNull(),
    reviewDigest: text("review_digest").notNull(),
    dataKey: text("data_key").notNull(),
    submittedAt: text("submitted_at").notNull(),
    submittedBy: text("submitted_by").notNull(),
  },
  (table) => [
    uniqueIndex("allocation_reviews_batch_reviewer").on(table.batchId, table.reviewerId),
    uniqueIndex("allocation_reviews_batch_run").on(table.batchId, table.reviewerRunId),
  ],
);

export const allocationEvents = sqliteTable("allocation_events", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  batchId: text("batch_id").references(() => allocationBatches.id),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
  detailJson: text("detail_json").notNull(),
});

// Browser accounts are independent of ChatGPT. Password and session tokens are
// stored only as salted password hashes and SHA-256 token hashes, respectively.
export const appUsers = sqliteTable("app_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  platformOwnerId: text("platform_owner_id"),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordIterations: integer("password_iterations").notNull(),
  passwordVersion: integer("password_version").notNull().default(1),
  mustChangePassword: integer("must_change_password").notNull().default(0),
  disabled: integer("disabled").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const appSessions = sqliteTable("app_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => appUsers.id),
  passwordVersion: integer("password_version").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const appAuthLimits = sqliteTable("app_auth_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  attempts: integer("attempts").notNull(),
}, (table) => [index("app_auth_limits_window").on(table.windowStart)]);
