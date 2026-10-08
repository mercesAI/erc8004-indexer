import { ponder } from "ponder:registry";
import { agent, agentMetadata } from "ponder:schema";
import { agentSeed, decodeAgentWallet, writeRaw, ZERO_ADDRESS } from "./helpers.js";

ponder.on("IdentityRegistry:Registered", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "IdentityRegistry", "Registered");
  await context.db
    .insert(agent)
    .values(
      agentSeed(chainId, event.args.agentId, {
        owner: event.args.owner.toLowerCase(),
        agentUri: event.args.agentURI,
        registeredBlock: event.block.number,
        registeredAt: event.block.timestamp,
      }),
    )
    .onConflictDoUpdate({
      owner: event.args.owner.toLowerCase(),
      agentUri: event.args.agentURI,
      registeredBlock: event.block.number,
      registeredAt: event.block.timestamp,
    });
});

ponder.on("IdentityRegistry:Transfer", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "IdentityRegistry", "Transfer");
  const from = event.args.from.toLowerCase();
  const to = event.args.to.toLowerCase();
  if (from === ZERO_ADDRESS) {
    await context.db
      .insert(agent)
      .values(agentSeed(chainId, event.args.tokenId, { owner: to }))
      .onConflictDoNothing();
    return;
  }
  await context.db
    .insert(agent)
    .values(
      agentSeed(chainId, event.args.tokenId, {
        owner: to,
        agentWallet: null,
        lastTransferAt: event.block.timestamp,
      }),
    )
    .onConflictDoUpdate({
      owner: to,
      agentWallet: null,
      lastTransferAt: event.block.timestamp,
    });
});

ponder.on("IdentityRegistry:URIUpdated", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "IdentityRegistry", "URIUpdated");
  await context.db
    .insert(agent)
    .values(
      agentSeed(chainId, event.args.agentId, {
        agentUri: event.args.newURI,
        uriUpdatedAt: event.block.timestamp,
      }),
    )
    .onConflictDoUpdate({
      agentUri: event.args.newURI,
      uriUpdatedAt: event.block.timestamp,
    });
});

ponder.on("IdentityRegistry:MetadataSet", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeRaw(context.db, chainId, event, "IdentityRegistry", "MetadataSet");
  await context.db
    .insert(agentMetadata)
    .values({
      chainId,
      agentId: event.args.agentId,
      key: event.args.metadataKey,
      // Stored as the UTF-8 of the hex string. read.agent_metadata unwraps it.
      // Writing real bytes would change Ponder's build id and refuse this schema.
      value: event.args.metadataValue as unknown as Uint8Array,
      updatedAt: event.block.timestamp,
    })
    .onConflictDoUpdate({
      value: event.args.metadataValue as unknown as Uint8Array,
      updatedAt: event.block.timestamp,
    });
  if (event.args.metadataKey === "agentWallet") {
    const wallet = decodeAgentWallet(event.args.metadataValue);
    await context.db
      .insert(agent)
      .values(agentSeed(chainId, event.args.agentId, { agentWallet: wallet }))
      .onConflictDoUpdate({ agentWallet: wallet });
  }
});
