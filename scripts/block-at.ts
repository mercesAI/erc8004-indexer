import { getPublicClient } from "../packages/shared/src/rpc.ts";
import { loadEnv } from "../packages/shared/src/env.ts";

loadEnv();

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) {
    console.error(`Usage: pnpm block-at --chain <key> --days-ago <n>`);
    process.exit(1);
  }
  return value;
}

const chain = arg("chain");
const daysAgo = Number(arg("days-ago"));
if (!Number.isFinite(daysAgo) || daysAgo < 0) {
  console.error("--days-ago must be a non-negative number");
  process.exit(1);
}

const client = getPublicClient(chain);
const target = BigInt(Math.floor(Date.now() / 1000) - daysAgo * 86_400);
let lo = 1n;
let hi = await client.getBlockNumber();
const head = await client.getBlock({ blockNumber: hi });
if (head.timestamp <= target) {
  process.stdout.write(`${hi.toString()}\n`);
  process.exit(0);
}

while (lo < hi) {
  const mid = (lo + hi) / 2n;
  const block = await client.getBlock({ blockNumber: mid });
  if (block.timestamp < target) lo = mid + 1n;
  else hi = mid;
}

process.stdout.write(`${lo.toString()}\n`);
