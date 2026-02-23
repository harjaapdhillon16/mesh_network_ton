import { Address, beginCell, toNano, Transaction } from '@ton/core';
import { createTonPaymentVerifier } from '../wrappers/createTonPaymentVerifier';

function addr(byte: number) {
  return new Address(0, Buffer.alloc(32, byte));
}

function mockTx(args: {
  hashHex: string;
  sender: Address;
  recipient: Address;
  amountNano: bigint;
  now?: number;
  aborted?: boolean;
  computeSuccess?: boolean;
}): Transaction {
  return {
    address: BigInt(0),
    lt: BigInt(1),
    prevTransactionHash: BigInt(0),
    prevTransactionLt: BigInt(0),
    now: args.now ?? Math.floor(Date.now() / 1000),
    outMessagesCount: 0,
    oldStatus: 'active' as any,
    endStatus: 'active' as any,
    inMessage: {
      info: {
        type: 'internal',
        ihrDisabled: true,
        bounce: false,
        bounced: false,
        src: args.sender,
        dest: args.recipient,
        value: { coins: args.amountNano },
        ihrFee: BigInt(0),
        forwardFee: BigInt(0),
        createdLt: BigInt(1),
        createdAt: args.now ?? Math.floor(Date.now() / 1000),
      },
      body: beginCell().endCell(),
    } as any,
    outMessages: null as any,
    totalFees: { coins: BigInt(0) } as any,
    stateUpdate: {} as any,
    description: {
      type: 'generic',
      creditFirst: false,
      computePhase: {
        type: 'vm',
        success: args.computeSuccess ?? true,
      },
      aborted: args.aborted ?? false,
      destroyed: false,
    } as any,
    raw: beginCell().endCell(),
    hash: () => Buffer.from(args.hashHex.replace(/^0x/i, '').padStart(64, '0'), 'hex'),
  };
}

describe('createTonPaymentVerifier', () => {
  it('verifies recipient inbound tx by hash, sender, and amount', async () => {
    const sender = addr(0x11);
    const recipient = addr(0x22);
    const tx = mockTx({
      hashHex: '0xabc123',
      sender,
      recipient,
      amountNano: toNano('1.5'),
      now: 1_700_000_000,
    });

    const verifier = createTonPaymentVerifier({
      client: {
        getTransactions: async (address) => {
          expect(address.equals(recipient)).toBe(true);
          return [tx];
        },
      },
      defaultMaxTxAgeSeconds: 600,
      nowSeconds: () => 1_700_000_100,
    });

    const result = await verifier({
      txHash: '0xabc123',
      amount: 1.2,
      expectedRecipient: recipient.toString(),
      expectedSender: sender.toString(),
      intentId: 'intent-1',
      network: 'testnet',
    });

    expect(result.ok).toBe(true);
    expect((result as any).tx.sender).toBe(sender.toString());
    expect((result as any).tx.recipient).toBe(recipient.toString());
    expect((result as any).tx.intentId).toBe('intent-1');
  });

  it('rejects mismatched sender and missing recipient context', async () => {
    const sender = addr(0x11);
    const wrongSender = addr(0x33);
    const recipient = addr(0x22);
    const tx = mockTx({
      hashHex: '0xdeadbeef',
      sender,
      recipient,
      amountNano: toNano('2'),
      now: 1_700_000_000,
    });

    const verifier = createTonPaymentVerifier({
      client: {
        getTransactions: async () => [tx],
      },
      nowSeconds: () => 1_700_000_010,
    });

    const missingRecipient = await verifier({
      txHash: '0xdeadbeef',
      amount: 2,
    });
    expect(missingRecipient).toEqual(expect.objectContaining({ ok: false, reason: 'missing_expected_recipient' }));

    const mismatch = await verifier({
      txHash: '0xdeadbeef',
      amount: 2,
      expectedRecipient: recipient.toString(),
      expectedSender: wrongSender.toString(),
    });
    expect(mismatch).toEqual(expect.objectContaining({ ok: false, reason: 'sender_mismatch' }));
  });

  it('rejects too-old or failed txs', async () => {
    const sender = addr(0x44);
    const recipient = addr(0x55);

    const oldTx = mockTx({
      hashHex: '0xaaaa',
      sender,
      recipient,
      amountNano: toNano('1'),
      now: 1_700_000_000,
    });

    const failedTx = mockTx({
      hashHex: '0xbbbb',
      sender,
      recipient,
      amountNano: toNano('1'),
      now: 1_700_000_100,
      aborted: true,
    });

    const verifier = createTonPaymentVerifier({
      client: {
        getTransactions: async () => [oldTx, failedTx],
      },
      defaultMaxTxAgeSeconds: 30,
      nowSeconds: () => 1_700_000_200,
    });

    const oldRes = await verifier({
      txHash: '0xaaaa',
      amount: 1,
      expectedRecipient: recipient.toString(),
      expectedSender: sender.toString(),
    });
    expect(oldRes).toEqual(expect.objectContaining({ ok: false, reason: 'tx_too_old' }));

    const failedRes = await verifier({
      txHash: '0xbbbb',
      amount: 1,
      expectedRecipient: recipient.toString(),
      expectedSender: sender.toString(),
      maxTxAgeSeconds: 9999,
    });
    expect(failedRes).toEqual(expect.objectContaining({ ok: false, reason: 'tx_failed' }));
  });
});

