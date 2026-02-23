import { Address, fromNano, toNano, Transaction } from '@ton/core';

type AddressLike = string | Address;

type TransactionsClientLike = {
  getTransactions(
    address: Address,
    opts: { limit: number; lt?: string; hash?: string; to_lt?: string; inclusive?: boolean; archival?: boolean },
  ): Promise<Transaction[]>;
};

export type VerifyTonPaymentArgs = {
  txHash: string;
  amount?: number | string | bigint;
  expectedRecipient?: string;
  expectedSender?: string | null;
  intentId?: string;
  network?: string;
  lookbackLimit?: number;
  maxTxAgeSeconds?: number;
};

export type TonPaymentVerifierOptions = {
  client: TransactionsClientLike;
  defaultLookbackLimit?: number;
  defaultMaxTxAgeSeconds?: number;
  allowAmountGreaterOrEqual?: boolean;
  nowSeconds?: () => number;
};

function nowSeconds(nowFn?: () => number) {
  const n = Number(nowFn ? nowFn() : Math.floor(Date.now() / 1000));
  return Number.isFinite(n) ? Math.floor(n) : Math.floor(Date.now() / 1000);
}

function normalizeHashHex(input: string) {
  const value = String(input || '').trim();
  if (!value) throw new Error('txHash is required');
  if (/^[0-9a-fA-F]{1,64}$/.test(value.replace(/^0x/i, ''))) {
    return value.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
  }
  return null;
}

function normalizeHashBase64(input: string) {
  const value = String(input || '').trim();
  if (!value) return null;
  try {
    // Support URL-safe base64 hashes that explorers often emit.
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(padded, 'base64');
    if (!buf.length) return null;
    return buf.toString('hex').toLowerCase();
  } catch {
    return null;
  }
}

function normalizeTxHashToHex(input: string) {
  const asHex = normalizeHashHex(input);
  if (asHex) return asHex;
  const asB64 = normalizeHashBase64(input);
  if (asB64) return asB64;
  throw new Error('txHash must be hex or base64');
}

function parseAddressMaybe(value: string | Address | null | undefined) {
  if (!value) return null;
  return value instanceof Address ? value : Address.parse(value);
}

function parseExpectedAmountNano(value: VerifyTonPaymentArgs['amount']) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('amount must be finite');
  }
  const text = String(value).trim();
  if (!text) return null;
  return toNano(text);
}

function txHashHex(tx: Transaction) {
  return tx.hash().toString('hex').toLowerCase();
}

function transactionNotAborted(tx: Transaction) {
  const desc = tx.description as unknown as { aborted?: boolean; computePhase?: { type?: string; success?: boolean } };
  if (typeof desc?.aborted === 'boolean' && desc.aborted) return false;
  if (desc?.computePhase?.type === 'vm' && desc.computePhase.success === false) return false;
  return true;
}

function extractInternalInbound(tx: Transaction) {
  const msg = tx.inMessage;
  if (!msg) return null;
  const info = msg.info;
  if (info.type !== 'internal') return null;
  return info;
}

function coinsMatch(actual: bigint, expected: bigint, allowGte: boolean) {
  return allowGte ? actual >= expected : actual === expected;
}

function txAgeOk(tx: Transaction, maxAgeSeconds: number | undefined, now: number) {
  if (!Number.isFinite(maxAgeSeconds) || !maxAgeSeconds || maxAgeSeconds <= 0) return true;
  return (now - Number(tx.now)) <= maxAgeSeconds;
}

export function createTonPaymentVerifier(options: TonPaymentVerifierOptions) {
  const defaultLookbackLimit = Math.max(1, Number(options.defaultLookbackLimit ?? 30));
  const allowGte = options.allowAmountGreaterOrEqual ?? true;

  return async function verifyTonPayment(args: VerifyTonPaymentArgs) {
    if (!args || typeof args !== 'object') {
      return { ok: false, reason: 'invalid_args' };
    }
    if (!args.txHash || typeof args.txHash !== 'string') {
      return { ok: false, reason: 'missing_tx_hash' };
    }
    if (!args.expectedRecipient) {
      return { ok: false, reason: 'missing_expected_recipient' };
    }

    let recipient: Address;
    let sender: Address | null = null;
    let expectedAmountNano: bigint | null = null;
    let targetHashHex: string;
    try {
      recipient = Address.parse(args.expectedRecipient);
      sender = parseAddressMaybe(args.expectedSender);
      expectedAmountNano = parseExpectedAmountNano(args.amount);
      targetHashHex = normalizeTxHashToHex(args.txHash);
    } catch (err) {
      return { ok: false, reason: 'invalid_verify_params', error: err instanceof Error ? err.message : String(err) };
    }

    const limit = Math.max(1, Number(args.lookbackLimit ?? defaultLookbackLimit));
    const maxAge = Number.isFinite(Number(args.maxTxAgeSeconds))
      ? Number(args.maxTxAgeSeconds)
      : options.defaultMaxTxAgeSeconds;

    let txs: Transaction[];
    try {
      txs = await options.client.getTransactions(recipient, { limit });
    } catch (err) {
      return { ok: false, reason: 'tx_lookup_failed', error: err instanceof Error ? err.message : String(err) };
    }

    const now = nowSeconds(options.nowSeconds);
    for (const tx of txs) {
      if (txHashHex(tx) !== targetHashHex) continue;

      const inbound = extractInternalInbound(tx);
      if (!inbound) {
        return { ok: false, reason: 'tx_has_no_internal_inbound', txHash: args.txHash };
      }
      if (!inbound.dest.equals(recipient)) {
        return { ok: false, reason: 'recipient_mismatch', txHash: args.txHash };
      }
      if (sender && !inbound.src.equals(sender)) {
        return { ok: false, reason: 'sender_mismatch', txHash: args.txHash };
      }
      if (expectedAmountNano != null && !coinsMatch(inbound.value.coins, expectedAmountNano, allowGte)) {
        return {
          ok: false,
          reason: 'amount_mismatch',
          txHash: args.txHash,
          expectedNano: expectedAmountNano.toString(),
          actualNano: inbound.value.coins.toString(),
        };
      }
      if (!txAgeOk(tx, maxAge, now)) {
        return { ok: false, reason: 'tx_too_old', txHash: args.txHash, txTime: tx.now };
      }
      if (!transactionNotAborted(tx)) {
        return { ok: false, reason: 'tx_failed', txHash: args.txHash };
      }

      return {
        ok: true,
        txHash: args.txHash,
        tx: {
          hashHex: txHashHex(tx),
          lt: tx.lt.toString(),
          now: tx.now,
          sender: inbound.src.toString(),
          recipient: inbound.dest.toString(),
          amountNano: inbound.value.coins.toString(),
          amountTon: Number(fromNano(inbound.value.coins)),
          intentId: args.intentId ?? null,
          network: args.network ?? null,
        },
      };
    }

    return {
      ok: false,
      reason: 'tx_not_found_in_recent_recipient_history',
      txHash: args.txHash,
      lookedAt: txs.length,
      recipient: recipient.toString(),
      limit,
    };
  };
}
