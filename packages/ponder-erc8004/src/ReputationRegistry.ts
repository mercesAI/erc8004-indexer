import { ponder } from "ponder:registry";
import { agent, feedback, feedbackResponse } from "ponder:schema";
import { agentSeed, valueNorm, writeRaw } from "./helpers.js";

ponder.on("ReputationRegistry:NewFeedback", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "ReputationRegistry", "NewFeedback");
  const clientAddress = event.args.clientAddress.toLowerCase();
  await context.db
    .insert(feedback)
    .values({
      chainId,
      agentId: event.args.agentId,
      clientAddress,
      feedbackIndex: event.args.feedbackIndex,
      value: event.args.value,
      valueDecimals: event.args.valueDecimals,
      valueNorm: valueNorm(event.args.value, event.args.valueDecimals),
      tag1: event.args.tag1,
      tag2: event.args.tag2,
      endpoint: event.args.endpoint,
      feedbackUri: event.args.feedbackURI,
      feedbackHash: event.args.feedbackHash.toLowerCase(),
      isRevoked: false,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash.toLowerCase(),
    })
    .onConflictDoUpdate({
      value: event.args.value,
      valueDecimals: event.args.valueDecimals,
      valueNorm: valueNorm(event.args.value, event.args.valueDecimals),
      tag1: event.args.tag1,
      tag2: event.args.tag2,
      endpoint: event.args.endpoint,
      feedbackUri: event.args.feedbackURI,
      feedbackHash: event.args.feedbackHash.toLowerCase(),
      isRevoked: false,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash.toLowerCase(),
    });
  await context.db
    .insert(agent)
    .values(
      agentSeed(chainId, event.args.agentId, {
        feedbackCount: 1,
        lastFeedbackAt: event.block.timestamp,
      }),
    )
    .onConflictDoUpdate((row) => ({
      feedbackCount: Number(row.feedbackCount) + 1,
      lastFeedbackAt: event.block.timestamp,
    }));
});

ponder.on("ReputationRegistry:FeedbackRevoked", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "ReputationRegistry", "FeedbackRevoked");
  const clientAddress = event.args.clientAddress.toLowerCase();
  await context.db
    .insert(feedback)
    .values({
      chainId,
      agentId: event.args.agentId,
      clientAddress,
      feedbackIndex: event.args.feedbackIndex,
      value: 0n,
      valueDecimals: 0,
      valueNorm: 0,
      tag1: "",
      tag2: "",
      endpoint: "",
      feedbackUri: "",
      feedbackHash: `0x${"0".repeat(64)}`,
      isRevoked: true,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash.toLowerCase(),
    })
    .onConflictDoUpdate({ isRevoked: true });
});

ponder.on("ReputationRegistry:ResponseAppended", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "ReputationRegistry", "ResponseAppended");
  await context.db.insert(feedbackResponse).values({
    chainId,
    txHash: event.transaction.hash.toLowerCase(),
    logIndex: event.log.logIndex,
    agentId: event.args.agentId,
    clientAddress: event.args.clientAddress.toLowerCase(),
    feedbackIndex: event.args.feedbackIndex,
    responder: event.args.responder.toLowerCase(),
    responseUri: event.args.responseURI,
    responseHash: event.args.responseHash.toLowerCase(),
    blockTime: event.block.timestamp,
  }).onConflictDoNothing();
});
