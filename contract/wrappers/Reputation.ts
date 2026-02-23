import {
  Address,
  beginCell,
  Cell,
  Contract,
  contractAddress,
  ContractProvider,
  Sender,
  SendMode,
  TupleBuilder,
} from '@ton/core';

export type ReputationConfig = {
  owner: Address;
};

export const ReputationOpcodes = {
  register: 0x01,
  recordOutcome: 0x02,
  slash: 0x03,
  withdrawStake: 0x04,
} as const;

export function reputationConfigToCell(config: ReputationConfig): Cell {
  return beginCell()
    .storeInt(config.owner.workChain, 8)
    .storeBuffer(config.owner.hash)
    .storeDict(null) // reputation_map
    .storeDict(null) // stake_map
    .storeDict(null) // stake_since_map
    .storeDict(null) // tx_seen
    .endCell();
}

function txHashToUint256(txHash: string | bigint | Buffer): bigint {
  if (typeof txHash === 'bigint') return txHash;
  if (typeof txHash === 'string') {
    const hex = txHash.startsWith('0x') ? txHash.slice(2) : txHash;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0 || hex.length > 64) {
      throw new Error('txHash must be hex (max 32 bytes)');
    }
    return BigInt(`0x${hex}`);
  }
  if (Buffer.isBuffer(txHash)) {
    if (txHash.length > 32) throw new Error('txHash buffer too long (max 32 bytes)');
    return BigInt(`0x${txHash.toString('hex') || '0'}`);
  }
  throw new Error('Unsupported txHash type');
}

export class Reputation implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromAddress(address: Address) {
    return new Reputation(address);
  }

  static createFromConfig(config: ReputationConfig, code: Cell, workchain = 0) {
    const data = reputationConfigToCell(config);
    const init = { code, data };
    return new Reputation(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendRegister(
    provider: ContractProvider,
    via: Sender,
    opts: { value: bigint; queryId?: bigint | number },
  ) {
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(ReputationOpcodes.register, 32)
        .storeUint(BigInt(opts.queryId ?? 0), 64)
        .endCell(),
    });
  }

  async sendRecordOutcome(
    provider: ContractProvider,
    via: Sender,
    opts: {
      value: bigint;
      executor: Address;
      txHash: string | bigint | Buffer;
      rating: number;
      queryId?: bigint | number;
    },
  ) {
    if (!Number.isInteger(opts.rating) || opts.rating < 1 || opts.rating > 10) {
      throw new Error('rating must be integer 1..10');
    }
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(ReputationOpcodes.recordOutcome, 32)
        .storeUint(BigInt(opts.queryId ?? 0), 64)
        .storeUint(txHashToUint256(opts.txHash), 256)
        .storeAddress(opts.executor)
        .storeUint(opts.rating, 8)
        .endCell(),
    });
  }

  async sendSlash(
    provider: ContractProvider,
    via: Sender,
    opts: { value: bigint; offender: Address; queryId?: bigint | number },
  ) {
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(ReputationOpcodes.slash, 32)
        .storeUint(BigInt(opts.queryId ?? 0), 64)
        .storeAddress(opts.offender)
        .endCell(),
    });
  }

  async sendWithdrawStake(
    provider: ContractProvider,
    via: Sender,
    opts: { value: bigint; queryId?: bigint | number },
  ) {
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(ReputationOpcodes.withdrawStake, 32)
        .storeUint(BigInt(opts.queryId ?? 0), 64)
        .endCell(),
    });
  }

  async getReputation(provider: ContractProvider, address: Address): Promise<bigint> {
    const tb = new TupleBuilder();
    tb.writeAddress(address);
    const result = await provider.get('get_reputation', tb.build());
    return BigInt(result.stack.readBigNumber().toString());
  }

  async getStake(provider: ContractProvider, address: Address): Promise<{ stake: bigint; since: bigint }> {
    const tb = new TupleBuilder();
    tb.writeAddress(address);
    const result = await provider.get('get_stake', tb.build());
    const stake = BigInt(result.stack.readBigNumber().toString());
    const since = BigInt(result.stack.readBigNumber().toString());
    return { stake, since };
  }

  async getOwner(provider: ContractProvider): Promise<{ workchain: bigint; hash: bigint }> {
    const result = await provider.get('get_owner', []);
    return {
      workchain: BigInt(result.stack.readBigNumber().toString()),
      hash: BigInt(result.stack.readBigNumber().toString()),
    };
  }
}
