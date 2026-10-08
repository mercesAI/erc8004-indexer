import { ponder } from "ponder:registry";
import { validation } from "ponder:schema";
import { writeRaw } from "./helpers.js";

ponder.on("ValidationRegistry:ValidationRequest", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "ValidationRegistry", "ValidationRequest");
  const requestHash = event.args.requestHash.toLowerCase();
  await context.db
    .insert(validation)
    .values({
      chainId,
      requestHash,
      validatorAddress: event.args.validatorAddress.toLowerCase(),
      agentId: event.args.agentId,
      requestUri: event.args.requestURI,
      response: null,
      responseUri: null,
      responseHash: null,
      tag: null,
      status: "pending",
      requestedAt: event.block.timestamp,
      lastUpdate: event.block.timestamp,
    })
    .onConflictDoUpdate((row) => ({
      validatorAddress: event.args.validatorAddress.toLowerCase(),
      agentId: event.args.agentId,
      requestUri: event.args.requestURI,
      requestedAt: row.requestedAt ?? event.block.timestamp,
      status: row.status === "completed" ? "completed" : "pending",
    }));
});

ponder.on("ValidationRegistry:ValidationResponse", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "ValidationRegistry", "ValidationResponse");
  const requestHash = event.args.requestHash.toLowerCase();
  await context.db
    .insert(validation)
    .values({
      chainId,
      requestHash,
      validatorAddress: event.args.validatorAddress.toLowerCase(),
      agentId: event.args.agentId,
      requestUri: null,
      response: event.args.response,
      responseUri: event.args.responseURI,
      responseHash: event.args.responseHash.toLowerCase(),
      tag: event.args.tag,
      status: "completed",
      requestedAt: null,
      lastUpdate: event.block.timestamp,
    })
    .onConflictDoUpdate({
      validatorAddress: event.args.validatorAddress.toLowerCase(),
      agentId: event.args.agentId,
      response: event.args.response,
      responseUri: event.args.responseURI,
      responseHash: event.args.responseHash.toLowerCase(),
      tag: event.args.tag,
      status: "completed",
      lastUpdate: event.block.timestamp,
    });
});
