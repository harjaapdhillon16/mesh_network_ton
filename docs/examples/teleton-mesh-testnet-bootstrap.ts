// Drop-in example for a Teleton host startup file (testnet).
// Adjust imports/paths to your host project structure.

import { TonClient4 } from '@ton/ton';
import { installTeletonMeshTestnet } from '../../contract/wrappers/installTeletonMeshTestnet';

export function installMeshForTestnet(sdk: any) {
  const tonClient = new TonClient4({
    endpoint: process.env.TON_RPC_ENDPOINT || 'https://testnet-v4.tonhubapi.com',
  });

  return installTeletonMeshTestnet({
    sdk,
    tonClient,
    meshContractAddress:
      process.env.MESH_CONTRACT_ADDRESS ||
      'EQB1RGsEmXEEiLgzON-_tDx9GRf3FKPF4RxZ_u_N8sfb-x02',
    // Your Teleton host must resolve an agent sender for the given wallet address.
    resolveAgentSender: async (agentAddr) => sdk.ton.getSenderForAddress(agentAddr.toString()),
    // This must return the funded owner signer that deployed the contract (kQCl... / EQCl...).
    resolveOwnerSender: async () => sdk.ton.getOwnerSender(),
    payment: {
      defaultLookbackLimit: 50,
      defaultMaxTxAgeSeconds: 60 * 60,
      allowAmountGreaterOrEqual: true,
    },
  });
}

