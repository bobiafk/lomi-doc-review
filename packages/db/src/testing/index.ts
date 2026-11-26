// Test helpers for packages that need a real, migrated Postgres. Use
// `globalSetup` in the consumer's vitest config, then createTestDatabase()
// once per test file.
export { createTestDatabase, type TestDatabase } from "./test-db.js";
export { default as globalSetup } from "./global-setup.js";
