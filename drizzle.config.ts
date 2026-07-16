/// <reference types="node" />
import "dotenv/config";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Drizzle Kit");
}

export default {
  dialect: "postgresql",
  schema: "./src/storage/schema.ts",
  out: "./db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
};
