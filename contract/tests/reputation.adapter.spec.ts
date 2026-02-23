import '@ton/test-utils';
import { Blockchain } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { Reputation } from '../wrappers/Reputation';
import { createMeshReputationAdapter } from '../wrappers/createMeshReputationAdapter';

describe('createMeshReputationAdapter', () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile('Reputation');
  });

  it('matches the plugin meshReputation hook contract for sandbox usage', async () => {
    const blockchain = await Blockchain.create();
    const owner = await blockchain.treasury('owner');
    const agent = await blockchain.treasury('agent');

    const reputation = blockchain.openContract(
      Reputation.createFromConfig(
        {
          owner: owner.address,
        },
        code,
      ),
    );

    await reputation.sendDeploy(owner.getSender(), toNano('0.05'));

    const adapter = createMeshReputationAdapter({
      defaultContractAddress: reputation.address,
      resolveContract: (address) => {
        expect(address.toString()).toBe(reputation.address.toString());
        return reputation;
      },
      resolveAgentSender: (address) => {
        if (!address.equals(agent.address)) {
          throw new Error(`Unexpected agent address ${address.toString()}`);
        }
        return agent.getSender();
      },
      resolveOwnerSender: () => owner.getSender(),
      nowSeconds: () => Math.floor(Date.now() / 1000),
    });

    const registered = await adapter.registerAgent({
      address: agent.address.toString(),
      stake: 1.5,
    });
    expect(registered.address).toBe(agent.address.toString());
    expect(registered.stake).toBeCloseTo(1.5, 6);
    expect(registered.reputation).toBe(100);
    expect(registered.registeredAt).toBeGreaterThan(0);

    const rep1 = await adapter.getReputation({
      address: agent.address.toString(),
    });
    expect(rep1).toBe(100);

    const stake1 = await adapter.getStakeInfo({
      address: agent.address.toString(),
    });
    expect(stake1.stake).toBeCloseTo(1.5, 6);
    expect(stake1.since).toBeGreaterThan(0);
    expect(stake1.ageSeconds).toBeGreaterThanOrEqual(0);

    const outcome = await adapter.recordOutcome({
      executorAddress: agent.address.toString(),
      txHash: '0xabc123',
      rating: 9,
    });
    expect(outcome.delta).toBe(15);
    expect(outcome.reputation).toBe(115);

    const slash = await adapter.slash({
      offenderAddress: agent.address.toString(),
      reason: 'test_dispute',
    });
    expect(slash.reason).toBe('test_dispute');
    expect(slash.slashedStake).toBeCloseTo(0.3, 6);
    expect(slash.remainingStake).toBeCloseTo(1.2, 6);
    expect(slash.reputation).toBe(65);

    const withdrawn = await adapter.withdrawStake({
      address: agent.address.toString(),
    });
    expect(withdrawn.amount).toBeCloseTo(1.2, 6);

    const rep2 = await adapter.getReputation({
      address: agent.address.toString(),
    });
    expect(rep2).toBe(0);

    const stake2 = await adapter.getStakeInfo({
      address: agent.address.toString(),
    });
    expect(stake2.stake).toBe(0);
  });

  it('rejects mismatched agent sender configuration before sending on-chain', async () => {
    const blockchain = await Blockchain.create();
    const owner = await blockchain.treasury('owner');
    const agent = await blockchain.treasury('agent');
    const wrong = await blockchain.treasury('wrong');

    const reputation = blockchain.openContract(
      Reputation.createFromConfig(
        {
          owner: owner.address,
        },
        code,
      ),
    );
    await reputation.sendDeploy(owner.getSender(), toNano('0.05'));

    const adapter = createMeshReputationAdapter({
      defaultContractAddress: reputation.address,
      resolveContract: () => reputation,
      resolveAgentSender: () => wrong.getSender(),
      resolveOwnerSender: () => owner.getSender(),
    });

    await expect(
      adapter.registerAgent({
        address: agent.address.toString(),
        stake: 1,
      }),
    ).rejects.toThrow(/sender address mismatch/i);

    expect(await reputation.getReputation(agent.address)).toBe(BigInt(0));
  });
});
