import { toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { Reputation } from '../wrappers/Reputation';

export async function run(provider: NetworkProvider) {
  const sender = provider.sender();
  if (!sender.address) {
    throw new Error('Provider sender has no address');
  }

  const code = await compile('Reputation');
  const reputation = provider.open(
    Reputation.createFromConfig(
      {
        owner: sender.address,
      },
      code,
    ),
  );

  provider.ui().write(`Deploying Reputation contract at: ${reputation.address.toString()}`);
  provider.ui().write(`Owner: ${sender.address.toString()}`);

  await reputation.sendDeploy(sender, toNano('0.05'));
  await provider.waitForDeploy(reputation.address);

  const owner = await reputation.getOwner();
  provider.ui().write(`Deployed. Stored owner wc=${owner.workchain.toString()} hash=${owner.hash.toString(16)}`);
}
