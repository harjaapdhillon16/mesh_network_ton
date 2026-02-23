const MESH_PREFIX = 'MESH:';
const MESH_VERSION = '1.0';

const KNOWN_TYPES = new Set(['beacon', 'intent', 'offer', 'accept', 'settle', 'dispute']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > 0 ? s : null;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item) => typeof item === 'string');
  return items.length === value.length ? items : null;
}

function hasFields(obj, required) {
  return required.every((key) => obj[key] !== undefined && obj[key] !== null);
}

function normalizeBase(obj) {
  const v = asString(obj.v) ?? MESH_VERSION;
  const type = asString(obj.type);
  if (!type || !KNOWN_TYPES.has(type)) {
    return null;
  }
  return { v, type };
}

function sanitizeBeacon(obj) {
  if (!isObject(obj)) return null;
  const base = normalizeBase(obj);
  if (!base) return null;
  const msg = {
    ...base,
    from: asString(obj.from),
    skills: asStringArray(obj.skills),
    minFee: asString(obj.minFee),
    responseTime: asString(obj.responseTime),
    stake: asString(obj.stake),
    replyChat: typeof obj.replyChat === 'number' ? obj.replyChat : null,
  };
  return hasFields(msg, ['from', 'skills']) ? msg : null;
}

function sanitizeIntent(obj) {
  if (!isObject(obj)) return null;
  const base = normalizeBase(obj);
  if (!base) return null;
  const msg = {
    ...base,
    id: asString(obj.id),
    from: asString(obj.from),
    skill: asString(obj.skill),
    payload: isObject(obj.payload) || Array.isArray(obj.payload) ? obj.payload : {},
    budget: asString(obj.budget),
    deadline: asInteger(obj.deadline),
    minReputation: obj.minReputation == null ? 0 : asInteger(obj.minReputation),
  };
  if (msg.minReputation === null || msg.minReputation < 0) return null;
  if (msg.deadline === null || msg.deadline <= 0) return null;
  return hasFields(msg, ['id', 'from', 'skill', 'budget', 'deadline']) ? msg : null;
}

function sanitizeOffer(obj) {
  if (!isObject(obj)) return null;
  const base = normalizeBase(obj);
  if (!base) return null;
  const msg = {
    ...base,
    intentId: asString(obj.intentId),
    from: asString(obj.from),
    fee: asString(obj.fee),
    eta: asString(obj.eta),
    reputation: obj.reputation == null ? undefined : asInteger(obj.reputation),
    escrowAddress: obj.escrowAddress == null ? undefined : asString(obj.escrowAddress),
  };
  return hasFields(msg, ['intentId', 'from', 'fee', 'eta']) ? msg : null;
}

function sanitizeAccept(obj) {
  if (!isObject(obj)) return null;
  const base = normalizeBase(obj);
  if (!base) return null;
  const msg = {
    ...base,
    intentId: asString(obj.intentId),
    from: asString(obj.from),
    to: asString(obj.to),
    fee: asString(obj.fee),
    selectedAt: asInteger(obj.selectedAt) ?? Math.floor(Date.now() / 1000),
  };
  return hasFields(msg, ['intentId', 'from', 'to', 'fee']) ? msg : null;
}

function sanitizeSettle(obj) {
  if (!isObject(obj)) return null;
  const base = normalizeBase(obj);
  if (!base) return null;
  const msg = {
    ...base,
    intentId: asString(obj.intentId),
    from: asString(obj.from),
    txHash: asString(obj.txHash),
    outcome: asString(obj.outcome),
    rating: asInteger(obj.rating),
  };
  if (msg.rating == null || msg.rating < 1 || msg.rating > 10) return null;
  return hasFields(msg, ['intentId', 'from', 'txHash', 'outcome', 'rating']) ? msg : null;
}

function sanitizeDispute(obj) {
  if (!isObject(obj)) return null;
  const base = normalizeBase(obj);
  if (!base) return null;
  const msg = {
    ...base,
    intentId: asString(obj.intentId),
    from: asString(obj.from),
    against: asString(obj.against),
    reason: asString(obj.reason),
    evidenceTx: asString(obj.evidenceTx),
  };
  return hasFields(msg, ['intentId', 'from', 'against']) ? msg : null;
}

function sanitizeMessage(obj) {
  switch (obj?.type) {
    case 'beacon':
      return sanitizeBeacon(obj);
    case 'intent':
      return sanitizeIntent(obj);
    case 'offer':
      return sanitizeOffer(obj);
    case 'accept':
      return sanitizeAccept(obj);
    case 'settle':
      return sanitizeSettle(obj);
    case 'dispute':
      return sanitizeDispute(obj);
    default:
      return null;
  }
}

export function parseMeshMessage(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(MESH_PREFIX)) return null;
  const jsonText = trimmed.slice(MESH_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(jsonText);
    return sanitizeMessage(parsed);
  } catch {
    return null;
  }
}

export function serializeMeshMessage(message) {
  const sanitized = sanitizeMessage(message);
  if (!sanitized) {
    throw new Error('Invalid MESH message');
  }
  return `${MESH_PREFIX} ${JSON.stringify(sanitized)}`;
}

export function buildBeaconMessage({ from, skills, minFee = '0.1', responseTime = '< 5s', stake = '1.0', replyChat }) {
  return sanitizeBeacon({ v: MESH_VERSION, type: 'beacon', from, skills, minFee, responseTime, stake, replyChat });
}

export function buildIntentMessage({ id, from, skill, payload = {}, budget, deadline, minReputation = 0 }) {
  return sanitizeIntent({ v: MESH_VERSION, type: 'intent', id, from, skill, payload, budget, deadline, minReputation });
}

export function buildOfferMessage({ intentId, from, fee, eta, reputation, escrowAddress }) {
  return sanitizeOffer({ v: MESH_VERSION, type: 'offer', intentId, from, fee, eta, reputation, escrowAddress });
}

export function buildAcceptMessage({ intentId, from, to, fee, selectedAt = Math.floor(Date.now() / 1000) }) {
  return sanitizeAccept({ v: MESH_VERSION, type: 'accept', intentId, from, to, fee, selectedAt });
}

export function buildSettleMessage({ intentId, from, txHash, outcome, rating }) {
  return sanitizeSettle({ v: MESH_VERSION, type: 'settle', intentId, from, txHash, outcome, rating });
}

export function buildDisputeMessage({ intentId, from, against, reason, evidenceTx }) {
  return sanitizeDispute({ v: MESH_VERSION, type: 'dispute', intentId, from, against, reason, evidenceTx });
}

export function meshMessagePrefix() {
  return MESH_PREFIX;
}

export function meshVersion() {
  return MESH_VERSION;
}
