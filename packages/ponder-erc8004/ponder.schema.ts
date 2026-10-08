import { index, onchainEnum, onchainTable, primaryKey } from "ponder";

export const validationStatus = onchainEnum("validation_status", ["pending", "completed"]);

export const agent = onchainTable(
  "agents",
  (t) => ({
    chainId: t.integer().notNull(),
    agentId: t.bigint().notNull(),
    owner: t.text().notNull(),
    agentUri: t.text().notNull(),
    agentWallet: t.text(),
    registeredBlock: t.bigint(),
    registeredAt: t.bigint(),
    lastTransferAt: t.bigint(),
    uriUpdatedAt: t.bigint(),
    feedbackCount: t.integer().notNull(),
    lastFeedbackAt: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.agentId] }),
    ownerIdx: index().on(table.owner),
    registeredAtIdx: index().on(table.registeredAt),
  }),
);

export const agentMetadata = onchainTable(
  "agent_metadata",
  (t) => ({
    chainId: t.integer().notNull(),
    agentId: t.bigint().notNull(),
    key: t.text().notNull(),
    value: t.bytes().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.agentId, table.key] }),
  }),
);

export const feedback = onchainTable(
  "feedback",
  (t) => ({
    chainId: t.integer().notNull(),
    agentId: t.bigint().notNull(),
    clientAddress: t.text().notNull(),
    feedbackIndex: t.bigint().notNull(),
    value: t.bigint().notNull(),
    valueDecimals: t.integer().notNull(),
    valueNorm: t.doublePrecision().notNull(),
    tag1: t.text().notNull(),
    tag2: t.text().notNull(),
    endpoint: t.text().notNull(),
    feedbackUri: t.text().notNull(),
    feedbackHash: t.text().notNull(),
    isRevoked: t.boolean().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.text().notNull(),
  }),
  (table) => ({
    pk: primaryKey({
      columns: [table.chainId, table.agentId, table.clientAddress, table.feedbackIndex],
    }),
    agentIdx: index().on(table.chainId, table.agentId),
    clientIdx: index().on(table.clientAddress),
    blockTimeIdx: index().on(table.blockTime),
  }),
);

export const feedbackResponse = onchainTable(
  "feedback_responses",
  (t) => ({
    chainId: t.integer().notNull(),
    txHash: t.text().notNull(),
    logIndex: t.integer().notNull(),
    agentId: t.bigint().notNull(),
    clientAddress: t.text().notNull(),
    feedbackIndex: t.bigint().notNull(),
    responder: t.text().notNull(),
    responseUri: t.text().notNull(),
    responseHash: t.text().notNull(),
    blockTime: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
  }),
);

export const validation = onchainTable(
  "validations",
  (t) => ({
    chainId: t.integer().notNull(),
    requestHash: t.text().notNull(),
    validatorAddress: t.text().notNull(),
    agentId: t.bigint().notNull(),
    requestUri: t.text(),
    response: t.integer(),
    responseUri: t.text(),
    responseHash: t.text(),
    tag: t.text(),
    status: validationStatus().notNull(),
    requestedAt: t.bigint(),
    lastUpdate: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.requestHash] }),
  }),
);

export const rawEvent = onchainTable(
  "raw_events",
  (t) => ({
    chainId: t.integer().notNull(),
    txHash: t.text().notNull(),
    logIndex: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    contract: t.text().notNull(),
    eventName: t.text().notNull(),
    args: t.json().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
    blockIdx: index().on(table.chainId, table.blockNumber),
  }),
);
