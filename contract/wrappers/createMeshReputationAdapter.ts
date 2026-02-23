import { Address, fromNano, Sender, toNano } from '@ton/core';
import { Reputation } from './Reputation';

type AddressLike = string | Address;

type MaybePromise<T> = T | Promise<T>;

export type MeshReputationAdapter = {
  registerAgent(args: {
    address: string;
    stake: number | string;
    contractAddress?: string;
  }): Promise<{
    address: string;
    stake: number;
    reputation: number;
    registeredAt: number;
    raw?: unknown;
  }>;
  getReputation(args: { address: string; contractAddress?: string }): Promise<number>;
  getStakeInfo(args: { address: string; contractAddress?: string }): Promise<{
    stake: number;
    since: number;
    ageSeconds: number;
  }>;
  recordOutcome(args: {
    executorAddress: string;
    txHash: string;
    rating: number;
    contractAddress?: string;
  }): Promise<{
    executorAddress: string;
    txHash: string;
    rating: number;
    delta: number;
    reputation: number;
    raw?: unknown;
  }>;
  slash(args: {
    offenderAddress: string;
    reason?: string;
    contractAddress?: string;
  }): Promise<{
    offenderAddress: string;
    reason: string;
    slashedStake: number;
    remainingStake: number;
    reputation: number;
    raw?: unknown;
  }>;
  withdrawStake(args: {
    address: string;
    contractAddress?: string;
  }): Promise<{
    address: string;
    amount: number;
    raw?: unknown;
  }>;
};

export type CreateMeshReputationAdapterOptions = {
  defaultContractAddress?: AddressLike;
  resolveContract: (contractAddress: Address) => MaybePromise<ReputationContractLike>;
  resolveAgentSender: (agentAddress: Address) => MaybePromise<Sender>;
  resolveOwnerSender: () => MaybePromise<Sender>;
  recordOutcomeValue?: bigint;
  slashValue?: bigint;
  withdrawValue?: bigint;
  nowSeconds?: () => number;
};

type ReputationContractLike = {
  sendRegister(
    via: Sender,
    opts: Parameters<Reputation['sendRegister']>[2],
  ): Promise<unknown>;
  getReputation(address: Address): Promise<bigint>;
  getStake(address: Address): Promise<{ stake: bigint; since: bigint }>;
  sendRecordOutcome(
    via: Sender,
    opts: Parameters<Reputation['sendRecordOutcome']>[2],
  ): Promise<unknown>;
  sendSlash(
    via: Sender,
    opts: Parameters<Reputation['sendSlash']>[2],
  ): Promise<unknown>;
  sendWithdrawStake(
    via: Sender,
    opts: Parameters<Reputation['sendWithdrawStake']>[2],
  ): Promise<unknown>;
};

function parseAddress(value: AddressLike): Address {
  return value instanceof Address ? value : Address.parse(value);
}

function normalizeContractAddress(
  value: string | undefined,
  fallback?: AddressLike,
): Address {
  if (value) return Address.parse(value);
  if (fallback) return parseAddress(fallback);
  throw new Error('contractAddress is required');
}

function tonNumber(value: bigint): number {
  const n = Number(fromNano(value));
  if (!Number.isFinite(n)) {
    throw new Error('TON amount is not representable as a number');
  }
  return n;
}

function unixNowSeconds(nowSeconds?: () => number): number {
  const n = Number(nowSeconds ? nowSeconds() : Math.floor(Date.now() / 1000));
  return Number.isFinite(n) ? Math.floor(n) : Math.floor(Date.now() / 1000);
}

function toNanoFromInput(value: number | string, label: string): bigint {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  const text = String(value).trim();
  if (!text) throw new Error(`${label} is required`);
  return toNano(text);
}

async function ensureSenderMatchesAddress(sender: Sender, expected: Address, op: string) {
  if (sender.address && !sender.address.equals(expected)) {
    throw new Error(`${op} sender address mismatch: expected ${expected.toString()} got ${sender.address.toString()}`);
  }
}

export function createMeshReputationAdapter(
  options: CreateMeshReputationAdapterOptions,
): MeshReputationAdapter {
  const recordOutcomeValue = options.recordOutcomeValue ?? toNano('0.05');
  const slashValue = options.slashValue ?? toNano('0.05');
  const withdrawValue = options.withdrawValue ?? toNano('0.05');

  async function open(contractAddress?: string) {
    const parsed = normalizeContractAddress(contractAddress, options.defaultContractAddress);
    const contract = await options.resolveContract(parsed);
    return { contract, contractAddress: parsed };
  }

  return {
    async registerAgent({ address, stake, contractAddress }) {
      const agentAddress = Address.parse(address);
      const sender = await options.resolveAgentSender(agentAddress);
      await ensureSenderMatchesAddress(sender, agentAddress, 'registerAgent');
      const stakeNano = toNanoFromInput(stake, 'stake');

      const { contract } = await open(contractAddress);
      const raw = await contract.sendRegister(sender, {
        value: stakeNano,
      });

      const reputation = Number(await contract.getReputation(agentAddress));
      const stakeInfo = await contract.getStake(agentAddress);

      return {
        address,
        stake: tonNumber(stakeInfo.stake),
        reputation,
        registeredAt: Number(stakeInfo.since),
        raw,
      };
    },

    async getReputation({ address, contractAddress }) {
      const { contract } = await open(contractAddress);
      const value = await contract.getReputation(Address.parse(address));
      return Number(value);
    },

    async getStakeInfo({ address, contractAddress }) {
      const { contract } = await open(contractAddress);
      const stakeInfo = await contract.getStake(Address.parse(address));
      const since = Number(stakeInfo.since);
      const now = unixNowSeconds(options.nowSeconds);
      return {
        stake: tonNumber(stakeInfo.stake),
        since,
        ageSeconds: Math.max(0, now - since),
      };
    },

    async recordOutcome({ executorAddress, txHash, rating, contractAddress }) {
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
        throw new Error('rating must be an integer between 1 and 10');
      }

      const { contract } = await open(contractAddress);
      const executor = Address.parse(executorAddress);
      const ownerSender = await options.resolveOwnerSender();
      const before = Number(await contract.getReputation(executor));
      const raw = await contract.sendRecordOutcome(ownerSender, {
        value: recordOutcomeValue,
        executor,
        txHash,
        rating,
      });
      const after = Number(await contract.getReputation(executor));

      return {
        executorAddress,
        txHash,
        rating,
        delta: after - before,
        reputation: after,
        raw,
      };
    },

    async slash({ offenderAddress, reason = 'dispute_confirmed', contractAddress }) {
      const { contract } = await open(contractAddress);
      const offender = Address.parse(offenderAddress);
      const ownerSender = await options.resolveOwnerSender();

      const beforeStake = await contract.getStake(offender);
      const raw = await contract.sendSlash(ownerSender, {
        value: slashValue,
        offender,
      });
      const afterStake = await contract.getStake(offender);
      const afterRep = Number(await contract.getReputation(offender));

      return {
        offenderAddress,
        reason,
        slashedStake: tonNumber(beforeStake.stake - afterStake.stake),
        remainingStake: tonNumber(afterStake.stake),
        reputation: afterRep,
        raw,
      };
    },

    async withdrawStake({ address, contractAddress }) {
      const agentAddress = Address.parse(address);
      const sender = await options.resolveAgentSender(agentAddress);
      await ensureSenderMatchesAddress(sender, agentAddress, 'withdrawStake');

      const { contract } = await open(contractAddress);
      const before = await contract.getStake(agentAddress);
      const raw = await contract.sendWithdrawStake(sender, {
        value: withdrawValue,
      });

      return {
        address,
        amount: tonNumber(before.stake),
        raw,
      };
    },
  };
}
