function ensureState(sdk) {
  if (!sdk.__meshReputation) {
    sdk.__meshReputation = {
      scores: new Map(),
      stakes: new Map(),
      stakeSince: new Map(),
      txSeen: new Set(),
    };
  }
  return sdk.__meshReputation;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function reputationDeltaForRating(rating) {
  if (rating >= 9) return 15;
  if (rating >= 7) return 8;
  if (rating >= 5) return 2;
  if (rating >= 3) return -10;
  return -25;
}

export function slashPenalty(currentStake) {
  return currentStake * 0.2;
}

async function getRawClientMaybe(sdk) {
  try {
    if (sdk?.ton?.getRawClient) {
      return await sdk.ton.getRawClient();
    }
  } catch {
    // Fall back to local simulation.
  }
  return null;
}

function modeOf(config = {}) {
  return String(config.mode || process.env.MESH_MODE || '').toLowerCase();
}

function isStrictChainMode(config = {}) {
  if (typeof config.strictChain === 'boolean') return config.strictChain;
  const mode = modeOf(config);
  return mode === 'production' || mode === 'mainnet';
}

function allowLocalFallback(config = {}) {
  if (typeof config.allowLocalReputationFallback === 'boolean') {
    return config.allowLocalReputationFallback;
  }
  return !isStrictChainMode(config);
}

export class MeshReputationClient {
  constructor(sdk, config = {}) {
    this.sdk = sdk;
    this.config = config;
    this.strictChain = isStrictChainMode(config);
    this.localFallbackAllowed = allowLocalFallback(config);
  }

  async requireRawClient(capability) {
    const raw = await getRawClientMaybe(this.sdk);
    if (!this.strictChain) return raw;
    if (!raw) {
      throw new Error(`TON raw client unavailable (${capability}) in strictChain mode`);
    }
    return raw;
  }

  ensureFallbackAllowed(op) {
    if (!this.localFallbackAllowed) {
      throw new Error(`Local reputation fallback is disabled in strictChain mode (${op})`);
    }
  }

  get hostAdapter() {
    return this.sdk?.ton?.meshReputation || null;
  }

  async registerAgent({ address, stake }) {
    const amount = toNum(stake);
    if (amount < 1) {
      throw new Error('Minimum stake is 1 TON');
    }

    if (this.hostAdapter?.registerAgent) {
      return this.hostAdapter.registerAgent({ address, stake: amount, contractAddress: this.config.contractAddress });
    }

    const raw = await this.requireRawClient('registerAgent');
    if (raw && this.config.contractAddress && raw.sendInternalMessage) {
      // Host-specific TON bindings vary. This branch is intentionally minimal.
      // In strictChain mode we refuse to continue without a concrete wrapper path.
      if (this.strictChain) {
        throw new Error('registerAgent on-chain path not implemented: provide Blueprint wrapper integration');
      }
    }

    this.ensureFallbackAllowed('registerAgent');
    const state = ensureState(this.sdk);
    if (!state.scores.has(address)) {
      state.scores.set(address, 100);
      state.stakeSince.set(address, now());
    }
    state.stakes.set(address, amount);

    return {
      address,
      stake: amount,
      reputation: state.scores.get(address),
      registeredAt: state.stakeSince.get(address),
    };
  }

  async getReputation(address) {
    if (this.hostAdapter?.getReputation) {
      return this.hostAdapter.getReputation({ address, contractAddress: this.config.contractAddress });
    }

    const raw = await this.requireRawClient('getReputation');
    if (raw && this.config.contractAddress && raw.runMethod) {
      // Optional host integration hook; safely ignore errors and fall back.
      try {
        const result = await raw.runMethod(this.config.contractAddress, 'get_reputation', [address]);
        const value = Number(result?.stack?.[0]?.value ?? result?.value);
        if (Number.isFinite(value)) return value;
      } catch {
        if (this.strictChain) throw new Error('getReputation failed via TON raw client');
      }
    }

    this.ensureFallbackAllowed('getReputation');
    const state = ensureState(this.sdk);
    return state.scores.get(address) ?? 0;
  }

  async getStakeInfo(address) {
    if (this.hostAdapter?.getStakeInfo) {
      return this.hostAdapter.getStakeInfo({ address, contractAddress: this.config.contractAddress });
    }

    const raw = await this.requireRawClient('getStakeInfo');
    if (raw && this.config.contractAddress && raw.runMethod) {
      try {
        const result = await raw.runMethod(this.config.contractAddress, 'get_stake', [address]);
        const stake = Number(result?.stack?.[0]?.value ?? result?.value ?? 0);
        const since = Number(result?.stack?.[1]?.value ?? now());
        if (Number.isFinite(stake)) {
          return {
            stake,
            since: Number.isFinite(since) ? since : now(),
            ageSeconds: Math.max(0, now() - (Number.isFinite(since) ? since : now())),
          };
        }
      } catch {
        if (this.strictChain) {
          throw new Error('getStakeInfo failed via TON raw client');
        }
      }
    }

    if (this.strictChain) {
      throw new Error('getStakeInfo on-chain path not implemented in strictChain mode');
    }
    this.ensureFallbackAllowed('getStakeInfo');
    const state = ensureState(this.sdk);
    const amount = state.stakes.get(address) ?? 0;
    const since = state.stakeSince.get(address) ?? now();
    return {
      stake: amount,
      since,
      ageSeconds: Math.max(0, now() - since),
    };
  }

  async recordOutcome({ executorAddress, txHash, rating }) {
    if (this.hostAdapter?.recordOutcome) {
      return this.hostAdapter.recordOutcome({
        executorAddress,
        txHash,
        rating,
        contractAddress: this.config.contractAddress,
      });
    }
    if (this.strictChain) {
      // Requires wrapper encoding for record_outcome op + tx hash payload.
      throw new Error('recordOutcome on-chain path not implemented in strictChain mode');
    }
    this.ensureFallbackAllowed('recordOutcome');
    const state = ensureState(this.sdk);
    if (state.txSeen.has(txHash)) {
      throw new Error('Replay detected: txHash already processed');
    }
    state.txSeen.add(txHash);

    const current = state.scores.get(executorAddress) ?? 100;
    const delta = reputationDeltaForRating(Number(rating));
    const next = Math.max(0, current + delta);
    state.scores.set(executorAddress, next);

    return {
      executorAddress,
      txHash,
      rating: Number(rating),
      delta,
      reputation: next,
    };
  }

  async slash({ offenderAddress, reason = 'dispute_confirmed' }) {
    if (this.hostAdapter?.slash) {
      return this.hostAdapter.slash({ offenderAddress, reason, contractAddress: this.config.contractAddress });
    }
    if (this.strictChain) {
      throw new Error('slash on-chain path not implemented in strictChain mode');
    }
    this.ensureFallbackAllowed('slash');
    const state = ensureState(this.sdk);
    const currentStake = state.stakes.get(offenderAddress) ?? 0;
    const slashAmt = slashPenalty(currentStake);
    state.stakes.set(offenderAddress, Math.max(0, currentStake - slashAmt));

    const currentRep = state.scores.get(offenderAddress) ?? 100;
    const nextRep = Math.max(0, currentRep - 50);
    state.scores.set(offenderAddress, nextRep);

    return {
      offenderAddress,
      reason,
      slashedStake: slashAmt,
      remainingStake: state.stakes.get(offenderAddress),
      reputation: nextRep,
    };
  }

  async withdrawStake({ address }) {
    if (this.hostAdapter?.withdrawStake) {
      return this.hostAdapter.withdrawStake({ address, contractAddress: this.config.contractAddress });
    }
    if (this.strictChain) {
      throw new Error('withdrawStake on-chain path not implemented in strictChain mode');
    }
    this.ensureFallbackAllowed('withdrawStake');
    const state = ensureState(this.sdk);
    const amount = state.stakes.get(address) ?? 0;
    state.stakes.delete(address);
    state.scores.delete(address);
    state.stakeSince.delete(address);
    return { address, amount };
  }

  async verifyPayment(args = {}) {
    const { txHash, amount } = args;
    // Local demo fallback: treat any non-empty tx hash as valid.
    if (!txHash || typeof txHash !== 'string') {
      return { ok: false, reason: 'missing_tx_hash' };
    }

    try {
      if (this.sdk?.ton?.verifyPayment) {
        const result = await this.sdk.ton.verifyPayment({ ...args, txHash, amount });
        return { ok: !!(result?.ok ?? result), raw: result };
      }
    } catch {
      if (this.strictChain) {
        return { ok: false, reason: 'ton_verify_payment_failed' };
      }
    }

    if (!this.localFallbackAllowed) {
      return { ok: false, reason: 'local_payment_fallback_disabled' };
    }
    return { ok: true, local: true };
  }
}

export function createReputationClient(sdk, config) {
  return new MeshReputationClient(sdk, config);
}
