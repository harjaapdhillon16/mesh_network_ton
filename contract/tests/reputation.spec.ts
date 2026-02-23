import '@ton/test-utils';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { Reputation } from '../wrappers/Reputation';

describe('Reputation (MESH)', () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile('Reputation');
  });

  let blockchain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let agent: SandboxContract<TreasuryContract>;
  let outsider: SandboxContract<TreasuryContract>;
  let reputation: SandboxContract<Reputation>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();

    owner = await blockchain.treasury('owner');
    agent = await blockchain.treasury('agent');
    outsider = await blockchain.treasury('outsider');
    expect(owner.address.toString()).not.toBe(outsider.address.toString());

    reputation = blockchain.openContract(
      Reputation.createFromConfig(
        {
          owner: owner.address,
        },
        code,
      ),
    );

    const deployResult = await reputation.sendDeploy(owner.getSender(), toNano('0.05'));
    expect(deployResult.transactions).toHaveTransaction({
      from: owner.address,
      to: reputation.address,
      deploy: true,
      success: true,
    });

    const storedOwner = await reputation.getOwner();
    expect(storedOwner.workchain).toBe(BigInt(owner.address.workChain));
    expect(storedOwner.hash).toBe(BigInt(`0x${owner.address.hash.toString('hex')}`));
  });

  it('registers, records outcomes, slashes, and withdraws', async () => {
    const registerValue = toNano('1.5');

    const registerTx = await reputation.sendRegister(agent.getSender(), {
      value: registerValue,
    });
    expect(registerTx.transactions).toHaveTransaction({
      from: agent.address,
      to: reputation.address,
      success: true,
      op: 0x01,
    });

    expect(await reputation.getReputation(agent.address)).toBe(BigInt(100));
    expect(await reputation.getOwner()).toEqual({
      workchain: BigInt(owner.address.workChain),
      hash: BigInt(`0x${owner.address.hash.toString('hex')}`),
    });
    const stake1 = await reputation.getStake(agent.address);
    expect(stake1.stake).toBe(registerValue);
    expect(stake1.since).toBeGreaterThan(BigInt(0));

    const settleTx = await reputation.sendRecordOutcome(owner.getSender(), {
      value: toNano('0.05'),
      executor: agent.address,
      txHash: '0xabc123',
      rating: 9,
    });
    expect(settleTx.transactions).toHaveTransaction({
      from: owner.address,
      to: reputation.address,
      success: true,
      op: 0x02,
    });
    expect(await reputation.getReputation(agent.address)).toBe(BigInt(115));
    expect(await reputation.getOwner()).toEqual({
      workchain: BigInt(owner.address.workChain),
      hash: BigInt(`0x${owner.address.hash.toString('hex')}`),
    });

    const slashTx = await reputation.sendSlash(owner.getSender(), {
      value: toNano('0.05'),
      offender: agent.address,
    });
    expect(slashTx.transactions).toHaveTransaction({
      from: owner.address,
      to: reputation.address,
      success: true,
      op: 0x03,
    });

    expect(await reputation.getReputation(agent.address)).toBe(BigInt(65));
    expect(await reputation.getOwner()).toEqual({
      workchain: BigInt(owner.address.workChain),
      hash: BigInt(`0x${owner.address.hash.toString('hex')}`),
    });
    const stake2 = await reputation.getStake(agent.address);
    expect(stake2.stake).toBe(registerValue - (registerValue / BigInt(5)));

    const badSlashTx = await reputation.sendSlash(outsider.getSender(), {
      value: toNano('0.05'),
      offender: agent.address,
    });
    expect(badSlashTx.transactions).toHaveTransaction({
      to: reputation.address,
      success: false,
      op: 0x03,
      exitCode: 401,
    });
    expect(await reputation.getReputation(agent.address)).toBe(BigInt(65));

    const withdrawTx = await reputation.sendWithdrawStake(agent.getSender(), {
      value: toNano('0.05'),
    });
    expect(withdrawTx.transactions).toHaveTransaction({
      from: agent.address,
      to: reputation.address,
      success: true,
      op: 0x04,
    });
    expect(await reputation.getReputation(agent.address)).toBe(BigInt(0));
    const stake3 = await reputation.getStake(agent.address);
    expect(stake3.stake).toBe(BigInt(0));
  });

  it('rejects replayed record_outcome tx hashes', async () => {
    await reputation.sendRegister(agent.getSender(), { value: toNano('1.0') });

    const first = await reputation.sendRecordOutcome(owner.getSender(), {
      value: toNano('0.05'),
      executor: agent.address,
      txHash: '0xdeadbeef',
      rating: 8,
    });
    expect(first.transactions).toHaveTransaction({
      from: owner.address,
      to: reputation.address,
      success: true,
      op: 0x02,
    });

    const replay = await reputation.sendRecordOutcome(owner.getSender(), {
      value: toNano('0.05'),
      executor: agent.address,
      txHash: '0xdeadbeef',
      rating: 8,
    });
    expect(replay.transactions).toHaveTransaction({
      from: owner.address,
      to: reputation.address,
      success: false,
      op: 0x02,
    });
  });
});
