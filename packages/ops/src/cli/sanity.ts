import { loadEnv } from "@merces/shared";
import { closePool } from "@merces/shared";
import { runSanity } from "../sanity.js";

loadEnv();

try {
  const report = await runSanity();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await closePool();
  process.exit(report.summary.fail > 0 ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await closePool();
  process.exit(1);
}
