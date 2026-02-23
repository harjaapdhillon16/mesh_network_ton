import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  buildAcceptMessage,
  buildBeaconMessage,
  buildIntentMessage,
  buildOfferMessage,
  buildSettleMessage,
  parseMeshMessage,
  serializeMeshMessage,
} from './protocol.js';
import {
  acceptIntentOffer,
  closeRegistry,
  expireIntents,
  getDeal,
  getIntent,
  listIntents,
  listOffersForIntent,
  listPeers,
  markProcessedMessage,
  migrate as migrateRegistry,
  recordOffer,
  saveIntent,
  settleDeal,
  updateIntentStatus,
  upsertPeer,
} from './registry.js';
import { pickBestOffer, rankOffers } from './router.js';
import { createReputationClient } from './reputation.js';

export const manifest = {
  name: 'mesh',
  version: '1.0.0',
  sdkVersion: '^1.0.0',
  description: 'Agent coordination protocol for MESH network',
};

function now() {
  return Math.floor(Date.now() / 1000);
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid budget');
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

function isProductionMode(config = {}) {
  const mode = String(config.mode || process.env.MESH_MODE || '').toLowerCase();
  return mode === 'production' || mode === 'mainnet';
}

function maxIntentDeadlineSeconds(config = {}) {
  const raw = Number(config.maxIntentDeadlineSeconds ?? process.env.MESH_MAX_INTENT_DEADLINE_SECONDS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 3600;
}

function maxPayloadBytes(config = {}) {
  const raw = Number(config.maxPayloadBytes ?? process.env.MESH_MAX_PAYLOAD_BYTES);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 16 * 1024;
}

function validateRating(rating) {
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new Error('rating must be an integer from 1 to 10');
  }
  return n;
}

function validateIntentPayloadSize(payload, config) {
  const size = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
  if (size > maxPayloadBytes(config)) {
    throw new Error(`payload exceeds ${maxPayloadBytes(config)} bytes`);
  }
}

function buildInboundMessageMeta(event, msg, consumerAddress = 'unknown') {
  const chatId = event?.chatId ?? event?.chat?.id ?? event?.message?.chatId ?? event?.message?.chat?.id ?? null;
  const messageId = event?.messageId ?? event?.id ?? event?.message?.id ?? null;
  const text = event?.text ?? event?.message?.text ?? '';
  const payloadHash = sha256Hex(text);
  const key = messageId != null
    ? `consumer:${consumerAddress}:tg:${chatId ?? 'na'}:${messageId}`
    : `consumer:${consumerAddress}:hash:${payloadHash}`;
  return {
    key,
    messageType: msg?.type ?? null,
    sourceChatId: chatId,
    sourceMessageId: messageId,
    payloadHash,
    firstSeenAt: now(),
  };
}

function getPluginConfigFromAny(obj) {
  return (
    obj?.config?.pluginConfig ||
    obj?.ctx?.config?.pluginConfig ||
    obj?.pluginConfig ||
    obj?.config?.plugins?.mesh ||
    {}
  );
}

function getLogger(sdk) {
  return sdk?.logger || console;
}

function assertProductionPrereqs(sdk, config = {}) {
  if (!isProductionMode(config)) return;

  const dbUrl = config.databaseUrl || process.env.MESH_DATABASE_URL || process.env.DATABASE_URL;
  const supabaseUrl = config.supabaseUrl || process.env.MESH_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = config.supabaseServiceRoleKey || process.env.MESH_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dbUrl && !(supabaseUrl && supabaseKey)) {
    throw new Error('Production mode requires either Postgres (MESH_DATABASE_URL) or Supabase REST credentials');
  }
  if (!config.contractAddress) {
    throw new Error('Production mode requires contractAddress');
  }
  if (config.allowLocalReputationFallback === true) {
    throw new Error('Production mode forbids allowLocalReputationFallback=true');
  }
}

function getOwnAddress(sdk, config = {}) {
  return (
    config.address ||
    sdk?.wallet?.address ||
    sdk?.ton?.walletAddress ||
    sdk?.agent?.walletAddress ||
    null
  );
}

async function sendTelegramMessage(sdk, chatId, text) {
  if (!text) throw new Error('Missing text');

  const sendImpl = async () => {
    if (sdk?.telegram?.sendMessage) {
      return sdk.telegram.sendMessage(chatId, text);
    }
    if (sdk?.sendMessage) {
      return sdk.sendMessage({ chatId, text });
    }
    if (sdk?.transport?.telegram?.sendMessage) {
      return sdk.transport.telegram.sendMessage({ chatId, text });
    }

    const logger = getLogger(sdk);
    logger.info?.(`[MESH fallback send] chat=${chatId} ${text}`);
    return { local: true, chatId, text };
  };

  const config = { ...(sdk?.__meshRuntimeConfig || {}), ...getPluginConfigFromAny(sdk) };
  const retries = Math.max(0, Number(config.sendRetries ?? 2));
  const baseDelayMs = Math.max(50, Number(config.sendRetryBaseMs ?? 150));

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await sendImpl();
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      await sleep(baseDelayMs * (2 ** attempt));
    }
  }
  throw lastError;
}

async function replyToChat(sdk, chatId, text) {
  if (!chatId || !text) return null;
  try {
    return await sendTelegramMessage(sdk, chatId, text);
  } catch (err) {
    getLogger(sdk).warn?.('Failed to send MESH reply', err);
    return null;
  }
}

async function postMeshMessage(sdk, config, message) {
  const meshGroupId = config.meshGroupId;
  if (meshGroupId == null) {
    throw new Error('meshGroupId missing in mesh plugin config');
  }
  const text = serializeMeshMessage(message);
  return sendTelegramMessage(sdk, meshGroupId, text);
}

function getReputationClient(sdk, config) {
  return createReputationClient(sdk, {
    contractAddress: config.contractAddress,
    mode: config.mode,
    strictChain: config.strictChain,
    allowLocalReputationFallback: config.allowLocalReputationFallback,
  });
}

async function beaconFromConfigAndState(sdk, config, overrides = {}) {
  const address = getOwnAddress(sdk, config);
  if (!address) throw new Error('Agent wallet address not configured');
  const rep = getReputationClient(sdk, config);
  const repScore = await rep.getReputation(address);
  const stakeInfo = await rep.getStakeInfo(address);
  return {
    message: buildBeaconMessage({
      from: address,
      skills: overrides.skills ?? config.skills ?? ['swap'],
      minFee: String(overrides.minFee ?? config.minFee ?? '0.1'),
      responseTime: String(overrides.responseTime ?? config.responseTime ?? '< 5s'),
      stake: String(overrides.stake ?? stakeInfo.stake ?? config.stake ?? '0'),
      replyChat: overrides.replyChat ?? config.replyChat ?? config.meshGroupId,
    }),
    peerRecord: {
      address,
      skills: overrides.skills ?? config.skills ?? ['swap'],
      minFee: toNum(overrides.minFee ?? config.minFee ?? 0.1),
      responseTime: overrides.responseTime ?? config.responseTime ?? '< 5s',
      reputation: repScore || 100,
      stake: stakeInfo.stake,
      stakeAgeSeconds: stakeInfo.ageSeconds,
      lastSeen: now(),
      replyChat: overrides.replyChat ?? config.replyChat ?? config.meshGroupId,
    },
  };
}

function defaultOfferForIntent(intent, selfPeer, config) {
  const minFee = toNum(selfPeer?.minFee ?? config.minFee ?? 0.1, 0.1);
  const budget = toNum(intent.budget, 0);
  const fee = Math.min(budget, Math.max(minFee, Number((budget * 0.75 || minFee).toFixed(3))));
  return {
    fee: String(fee.toFixed(3).replace(/\.000$/, '')),
    eta: config.defaultEta || '5s',
  };
}

async function getSelfPeer(sdk, config) {
  const address = getOwnAddress(sdk, config);
  if (!address) return null;
  const peers = await listPeers(sdk);
  return peers.find((p) => p.address === address) || null;
}

async function autoAcceptBestOffer(sdk, config, intentId) {
  const intent = await getIntent(sdk, intentId);
  if (!intent || intent.status !== 'pending') return null;
  const offers = await listOffersForIntent(sdk, intentId);
  if (offers.length === 0) return null;

  const repClient = getReputationClient(sdk, config);
  const scored = await rankOffers(intent, offers, {
    getReputation: async (address) => repClient.getReputation(address),
  });
  const best = pickBestOffer(scored);
  if (!best) return null;

  const nowTs = now();
  const waitForDeadline = config.waitForDeadline !== false;
  if (waitForDeadline && nowTs < intent.deadline) {
    return { deferred: true, best };
  }

  const accepted = await acceptIntentOffer(sdk, intentId, best.id, best.fromAddress);
  if (!accepted.ok) return { skipped: true, reason: accepted.reason };

  const ownAddress = getOwnAddress(sdk, config);
  const acceptMsg = buildAcceptMessage({
    intentId,
    from: ownAddress,
    to: best.fromAddress,
    fee: String(best.feeRaw ?? best.fee),
    selectedAt: nowTs,
  });
  await postMeshMessage(sdk, config, acceptMsg);

  await settleDeal(sdk, {
    intentId,
    executorAddress: best.fromAddress,
    fee: best.fee,
  });

  return { accepted: true, best, scored };
}

async function handleBeacon(msg, sdk, config) {
  const repClient = getReputationClient(sdk, config);
  const reputation = await repClient.getReputation(msg.from);
  if (reputation <= 0) {
    return { ignored: true, reason: 'unstaked_or_unknown_peer' };
  }
  const stakeInfo = await repClient.getStakeInfo(msg.from);
  return upsertPeer(sdk, {
    address: msg.from,
    skills: msg.skills,
    minFee: msg.minFee,
    responseTime: msg.responseTime,
    reputation,
    stake: stakeInfo.stake,
    stakeAgeSeconds: stakeInfo.ageSeconds,
    lastSeen: now(),
    replyChat: msg.replyChat,
  });
}

async function handleIntent(msg, sdk, config) {
  await saveIntent(sdk, {
    id: msg.id,
    fromAddress: msg.from,
    skill: msg.skill,
    payload: msg.payload,
    budget: msg.budget,
    deadline: msg.deadline,
    minReputation: msg.minReputation,
    status: 'pending',
    createdAt: now(),
  });

  const ownAddress = getOwnAddress(sdk, config);
  if (!ownAddress || ownAddress === msg.from) {
    return { saved: true, autoOffer: false };
  }

  const selfPeer = await getSelfPeer(sdk, config);
  const skills = selfPeer?.skills || config.skills || [];
  if (!skills.includes(msg.skill)) {
    return { saved: true, autoOffer: false, reason: 'skill_mismatch' };
  }

  const repClient = getReputationClient(sdk, config);
  const selfRep = await repClient.getReputation(ownAddress);
  if (selfRep < (msg.minReputation || 0)) {
    return { saved: true, autoOffer: false, reason: 'reputation_too_low' };
  }

  const suggested = defaultOfferForIntent({ ...msg, budget: msg.budget }, selfPeer, config);
  if (toNum(suggested.fee) > toNum(msg.budget)) {
    return { saved: true, autoOffer: false, reason: 'budget_too_low' };
  }

  return runMeshOffer({ intentId: msg.id, fee: suggested.fee, eta: suggested.eta }, sdk, config, { auto: true });
}

async function handleOffer(msg, sdk, config) {
  const repClient = getReputationClient(sdk, config);
  const stakeInfo = await repClient.getStakeInfo(msg.from);
  const offer = await recordOffer(sdk, {
    intentId: msg.intentId,
    fromAddress: msg.from,
    fee: msg.fee,
    eta: msg.eta,
    reputation: msg.reputation ?? (await repClient.getReputation(msg.from)),
    stakeAgeSeconds: stakeInfo.ageSeconds,
    escrowAddress: msg.escrowAddress,
  });

  const intent = await getIntent(sdk, msg.intentId);
  const ownAddress = getOwnAddress(sdk, config);
  if (!intent || intent.fromAddress !== ownAddress) {
    return { saved: true, autoAccept: false, offer };
  }

  const result = await autoAcceptBestOffer(sdk, config, msg.intentId);
  return { saved: true, autoAccept: !!result?.accepted, offer, selection: result ?? null };
}

async function handleAccept(msg, sdk, config) {
  const intent = await getIntent(sdk, msg.intentId);
  if (intent && intent.status === 'pending') {
    await updateIntentStatus(sdk, msg.intentId, 'accepted', {
      selectedExecutor: msg.to,
    });
  }

  const existing = await getDeal(sdk, msg.intentId);
  if (!existing) {
    await settleDeal(sdk, {
      intentId: msg.intentId,
      executorAddress: msg.to,
      fee: msg.fee,
    });
  }

  const ownAddress = getOwnAddress(sdk, config);
  if (ownAddress === msg.to) {
    await replyToChat(sdk, config.operatorChatId, `MESH accept received for intent ${msg.intentId}. Fee ${msg.fee} TON.`);
  }

  return { accepted: true };
}

async function handleSettle(msg, sdk, config) {
  const repClient = getReputationClient(sdk, config);
  await settleDeal(sdk, {
    intentId: msg.intentId,
    executorAddress: msg.from,
    txHash: msg.txHash,
    outcome: msg.outcome,
    rating: msg.rating,
    settledAt: now(),
  });

  await updateIntentStatus(sdk, msg.intentId, 'settled');

  const reputation = await repClient.getReputation(msg.from);
  await upsertPeer(sdk, {
    address: msg.from,
    reputation,
    lastSeen: now(),
    skills: (await listPeers(sdk)).find((p) => p.address === msg.from)?.skills || [],
  });

  return { settled: true, reputation };
}

async function withSetup(sdk, config) {
  sdk.__meshRuntimeConfig = { ...(sdk.__meshRuntimeConfig || {}), ...(config || {}) };
  if (!sdk.__meshMigrationsComplete) {
    await migrateRegistry(sdk, { config });
    sdk.__meshMigrationsComplete = true;
  }
  const sweepEveryMs = Math.max(250, Number(config?.expirySweepIntervalMs ?? 1000));
  const nowMs = Date.now();
  if (!sdk.__meshLastExpirySweepAt || (nowMs - sdk.__meshLastExpirySweepAt) >= sweepEveryMs) {
    await expireIntents(sdk);
    sdk.__meshLastExpirySweepAt = nowMs;
  }
  return { sdk, config };
}

async function processDeadlinesOnce(sdk, config) {
  const pending = await listIntents(sdk, { status: 'pending' });
  const ts = now();
  let accepted = 0;
  let expired = 0;

  for (const intent of pending) {
    if (!Number.isFinite(intent.deadline) || intent.deadline > ts) continue;
    const selection = await autoAcceptBestOffer(sdk, { ...config, waitForDeadline: false }, intent.id);
    if (selection?.accepted) {
      accepted += 1;
      continue;
    }

    const latest = await getIntent(sdk, intent.id);
    if (latest?.status === 'pending') {
      await updateIntentStatus(sdk, intent.id, 'expired');
      expired += 1;
    }
  }

  return { accepted, expired, scanned: pending.length };
}

function ensureDeadlineScheduler(sdk, config) {
  if (!(config.enableScheduler ?? true)) return;
  if (sdk.__meshDeadlineScheduler) return;

  const intervalMs = Math.max(250, Number(config.schedulerIntervalMs ?? 1000));
  const logger = getLogger(sdk);

  const timer = setInterval(async () => {
    try {
      await processDeadlinesOnce(sdk, config);
    } catch (err) {
      logger.error?.('[MESH] deadline scheduler tick failed', err);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  sdk.__meshDeadlineScheduler = timer;
}

async function runMeshRegister(args, sdk, config) {
  const address = getOwnAddress(sdk, config);
  if (!address) throw new Error('Agent wallet address not configured');

  const repClient = getReputationClient(sdk, config);
  const registration = await repClient.registerAgent({
    address,
    stake: toNum(args?.stake ?? config.stake ?? 1),
  });

  const { message, peerRecord } = await beaconFromConfigAndState(sdk, {
    ...config,
    skills: args?.skills ?? config.skills,
    minFee: args?.minFee ?? config.minFee,
    responseTime: config.responseTime,
  });

  await upsertPeer(sdk, {
    ...peerRecord,
    reputation: registration.reputation,
    stake: registration.stake,
  });
  await postMeshMessage(sdk, config, message);

  return {
    ok: true,
    address,
    beacon: message,
    registration,
  };
}

async function runMeshBroadcast(args, sdk, config) {
  const address = getOwnAddress(sdk, config);
  if (!address) throw new Error('Agent wallet address not configured');

  const id = args?.id || uuidv4();
  const budget = parseBudget(args?.budget);
  if (budget <= 0) throw new Error('budget must be greater than 0');
  validateIntentPayloadSize(args?.payload || {}, config);
  const deadline = Number.isInteger(args?.deadline)
    ? args.deadline
    : Math.floor(Date.now() / 1000) + 30;
  const ts = now();
  if (deadline <= ts) throw new Error('deadline must be in the future');
  if ((deadline - ts) > maxIntentDeadlineSeconds(config)) {
    throw new Error(`deadline exceeds max horizon of ${maxIntentDeadlineSeconds(config)} seconds`);
  }

  const intentMsg = buildIntentMessage({
    id,
    from: address,
    skill: args?.skill,
    payload: args?.payload || {},
    budget: String(budget),
    deadline,
    minReputation: args?.minReputation ?? 0,
  });

  await saveIntent(sdk, {
    id,
    fromAddress: address,
    skill: args?.skill,
    payload: args?.payload || {},
    budget,
    deadline,
    minReputation: args?.minReputation ?? 0,
    status: 'pending',
    createdAt: now(),
  });

  await postMeshMessage(sdk, config, intentMsg);
  return { ok: true, intent: intentMsg };
}

async function runMeshOffer(args, sdk, config, { auto = false } = {}) {
  const intent = await getIntent(sdk, args?.intentId);
  if (!intent) throw new Error(`Intent not found: ${args?.intentId}`);

  const ownAddress = getOwnAddress(sdk, config);
  if (!ownAddress) throw new Error('Agent wallet address not configured');
  if (intent.fromAddress === ownAddress && !auto) {
    throw new Error('Cannot offer on your own intent');
  }

  const selfPeer = await getSelfPeer(sdk, config);
  const skills = selfPeer?.skills || config.skills || [];
  if (!skills.includes(intent.skill)) {
    throw new Error(`Agent does not have required skill: ${intent.skill}`);
  }

  const fee = toNum(args?.fee);
  if (!Number.isFinite(fee) || fee <= 0) {
    throw new Error('Offer fee must be greater than 0');
  }
  if (fee > toNum(intent.budget)) {
    throw new Error('Offer fee exceeds intent budget');
  }

  const repClient = getReputationClient(sdk, config);
  const reputation = await repClient.getReputation(ownAddress);
  const stakeInfo = await repClient.getStakeInfo(ownAddress);

  const offerMsg = buildOfferMessage({
    intentId: intent.id,
    from: ownAddress,
    fee: String(args?.fee),
    eta: args?.eta || '5s',
    reputation,
    escrowAddress: config.escrowAddress,
  });

  const offer = await recordOffer(sdk, {
    intentId: intent.id,
    fromAddress: ownAddress,
    fee: args?.fee,
    eta: args?.eta || '5s',
    reputation,
    stakeAgeSeconds: stakeInfo.ageSeconds,
    escrowAddress: config.escrowAddress,
  });

  await postMeshMessage(sdk, config, offerMsg);
  return { ok: true, auto, offer, message: offerMsg };
}

async function runMeshSettle(args, sdk, config) {
  const intent = await getIntent(sdk, args?.intentId);
  if (!intent) throw new Error(`Intent not found: ${args?.intentId}`);

  const ownAddress = getOwnAddress(sdk, config);
  if (!ownAddress) throw new Error('Agent wallet address not configured');

  const deal = await getDeal(sdk, args.intentId);
  const amount = deal?.fee ?? toNum(args?.amount, 0);

  const repClient = getReputationClient(sdk, config);
  const rating = validateRating(args.rating);
  const payment = await repClient.verifyPayment({
    txHash: args?.txHash,
    amount,
    intentId: args.intentId,
    expectedRecipient: ownAddress,
    expectedSender: intent.fromAddress ?? null,
    network: String(config.mode || process.env.MESH_MODE || 'testnet').toLowerCase(),
  });
  if (!payment.ok) {
    throw new Error(`Payment verification failed: ${payment.reason || 'unknown'}`);
  }

  const settleMsg = buildSettleMessage({
    intentId: args.intentId,
    from: ownAddress,
    txHash: args.txHash,
    outcome: args.outcome,
    rating,
  });

  const repUpdate = await repClient.recordOutcome({
    executorAddress: ownAddress,
    txHash: args.txHash,
    rating,
  });

  await postMeshMessage(sdk, config, settleMsg);

  await settleDeal(sdk, {
    intentId: args.intentId,
    executorAddress: ownAddress,
    fee: deal?.fee ?? amount,
    txHash: args.txHash,
    outcome: args.outcome,
    rating,
    settledAt: now(),
  });
  await updateIntentStatus(sdk, args.intentId, 'settled');

  await upsertPeer(sdk, {
    address: ownAddress,
    skills: (await getSelfPeer(sdk, config))?.skills || config.skills || [],
    minFee: config.minFee,
    responseTime: config.responseTime,
    reputation: repUpdate.reputation,
    lastSeen: now(),
  });

  return { ok: true, settle: settleMsg, reputation: repUpdate };
}

async function runMeshPeers(_args, sdk) {
  const peers = await listPeers(sdk);
  return { ok: true, peers };
}

export async function migrate(sdk) {
  return migrateRegistry(sdk);
}

export const tools = [
  {
    name: 'mesh_register',
    description: 'Register agent stake/reputation and broadcast beacon to the MESH bus',
    parameters: {
      type: 'object',
      properties: {
        skills: { type: 'array', items: { type: 'string' } },
        minFee: { type: 'string' },
        stake: { type: 'number' },
      },
      required: ['skills', 'minFee', 'stake'],
    },
    handler: async (args, sdk) => {
      const config = getPluginConfigFromAny(sdk);
      await withSetup(sdk, config);
      return runMeshRegister(args, sdk, config);
    },
  },
  {
    name: 'mesh_broadcast',
    description: 'Broadcast an intent to the MESH bus',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        payload: { type: 'object' },
        budget: { type: ['number', 'string'] },
        deadline: { type: 'number' },
        minReputation: { type: 'number' },
      },
      required: ['skill', 'payload', 'budget', 'deadline'],
    },
    handler: async (args, sdk) => {
      const config = getPluginConfigFromAny(sdk);
      await withSetup(sdk, config);
      return runMeshBroadcast(args, sdk, config);
    },
  },
  {
    name: 'mesh_offer',
    description: 'Send an offer for an existing intent visible in the local registry',
    parameters: {
      type: 'object',
      properties: {
        intentId: { type: 'string' },
        fee: { type: ['number', 'string'] },
        eta: { type: 'string' },
      },
      required: ['intentId', 'fee', 'eta'],
    },
    handler: async (args, sdk) => {
      const config = getPluginConfigFromAny(sdk);
      await withSetup(sdk, config);
      return runMeshOffer(args, sdk, config);
    },
  },
  {
    name: 'mesh_settle',
    description: 'Post settlement and update on-chain reputation for a completed intent',
    parameters: {
      type: 'object',
      properties: {
        intentId: { type: 'string' },
        txHash: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
        rating: { type: 'number' },
      },
      required: ['intentId', 'txHash', 'outcome', 'rating'],
    },
    handler: async (args, sdk) => {
      const config = getPluginConfigFromAny(sdk);
      await withSetup(sdk, config);
      return runMeshSettle(args, sdk, config);
    },
  },
  {
    name: 'mesh_peers',
    description: 'List known peers discovered on the MESH network',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async (args, sdk) => {
      const config = getPluginConfigFromAny(sdk);
      await withSetup(sdk, config);
      return runMeshPeers(args, sdk, config);
    },
  },
];

export async function onMessage(event, sdk) {
  const eventConfig = getPluginConfigFromAny(event);
  const config = eventConfig && Object.keys(eventConfig).length > 0
    ? eventConfig
    : getPluginConfigFromAny(sdk);

  await withSetup(sdk, config);

  const text = event?.text ?? event?.message?.text ?? '';
  const msg = parseMeshMessage(text);
  if (!msg) return null;

  const dedupe = await markProcessedMessage(sdk, buildInboundMessageMeta(event, msg, getOwnAddress(sdk, config) || 'unknown'));
  if (!dedupe.inserted) {
    return { duplicate: true, type: msg.type };
  }

  switch (msg.type) {
    case 'beacon':
      return handleBeacon(msg, sdk, config);
    case 'intent':
      return handleIntent(msg, sdk, config);
    case 'offer':
      return handleOffer(msg, sdk, config);
    case 'accept':
      return handleAccept(msg, sdk, config);
    case 'settle':
      return handleSettle(msg, sdk, config);
    default:
      return null;
  }
}

export async function start(ctx) {
  const sdk = ctx?.sdk || ctx;
  const config = getPluginConfigFromAny(ctx);
  assertProductionPrereqs(sdk, config);
  await withSetup(sdk, config);
  ensureDeadlineScheduler(sdk, config);

  const ownAddress = getOwnAddress(sdk, config);
  if (!ownAddress) {
    getLogger(sdk).warn?.('MESH start(): no wallet address configured; skipping beacon');
    return { ok: false, reason: 'missing_wallet_address' };
  }

  const repClient = getReputationClient(sdk, config);
  const existingRep = await repClient.getReputation(ownAddress);
  if (existingRep <= 0 && (config.autoRegisterOnStart ?? true)) {
    await repClient.registerAgent({ address: ownAddress, stake: toNum(config.stake ?? 1, 1) });
  }

  const { message, peerRecord } = await beaconFromConfigAndState(sdk, config);
  await upsertPeer(sdk, peerRecord);
  await postMeshMessage(sdk, config, message);

  return { ok: true, beacon: message };
}

export async function stop(ctx) {
  const sdk = ctx?.sdk || ctx;
  if (sdk?.__meshDeadlineScheduler) {
    clearInterval(sdk.__meshDeadlineScheduler);
    sdk.__meshDeadlineScheduler = null;
  }
  await closeRegistry(sdk);
  return { ok: true };
}

export default {
  manifest,
  migrate,
  tools,
  onMessage,
  start,
  stop,
};
