/**
 * A tiny test runner for tests/gl/*.test.ts (no AI, no database):
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/gl/<file>.test.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
const failed: string[] = [];

export async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed.push(name);
    console.error(`  ✗ ${name}`, err);
  }
}

export function done(label: string): never {
  console.log(`\n${label}: ${passed} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "gl");
export const fixture = (name: string) => path.join(FIXTURES, name);
