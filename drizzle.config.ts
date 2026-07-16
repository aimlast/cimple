import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // user_sessions is created and owned by connect-pg-simple at runtime, not
  // by the Drizzle schema. Without this exclusion, `db:push` (which runs on
  // every deploy) sees an "unknown" table and tries to DROP it — prompting
  // for confirmation, which crashes in the non-interactive deploy shell.
  tablesFilter: ["!user_sessions"],
});
