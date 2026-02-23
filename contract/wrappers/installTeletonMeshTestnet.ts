import { Address } from '@ton/core';
import { Reputation } from './Reputation';
import { createMeshReputationAdapter } from './createMeshReputationAdapter';
import { createTonPaymentVerifier, TonPaymentVerifierOptions } from './createTonPaymentVerifier';

type AddressLike = string | Address;

type TonClientOpenLike = {
  open<T>(contract: T): any;
};

type TonTransactionsClientLike = TonPaymentVerifierOptions['client'];

type SenderResolver = (address: Address) => Promise<any> | any;
type OwnerSenderResolver = () => Promise<any> | any;

export type InstallTeletonMeshTestnetOptions = {
  sdk: any;
  tonClient: TonClientOpenLike & TonTransactionsClientLike;
  meshContractAddress: AddressLike;
  resolveAgentSender: SenderResolver;
  resolveOwnerSender: OwnerSenderResolver;
  payment?: Omit<TonPaymentVerifierOptions, 'client'>;
};

function parseAddress(value: AddressLike) {
  return value instanceof Address ? value : Address.parse(value);
}

export function installTeletonMeshTestnet(options: InstallTeletonMeshTestnetOptions) {
  if (!options?.sdk) throw new Error('sdk is required');
  if (!options.sdk.ton) options.sdk.ton = {};

  const contractAddress = parseAddress(options.meshContractAddress);

  options.sdk.ton.meshReputation = createMeshReputationAdapter({
    defaultContractAddress: contractAddress,
    resolveContract: (addr) => options.tonClient.open(Reputation.createFromAddress(addr)),
    resolveAgentSender: options.resolveAgentSender,
    resolveOwnerSender: options.resolveOwnerSender,
  });

  options.sdk.ton.verifyPayment = createTonPaymentVerifier({
    client: options.tonClient,
    ...options.payment,
  });

  return {
    contractAddress: contractAddress.toString(),
    meshReputation: options.sdk.ton.meshReputation,
    verifyPayment: options.sdk.ton.verifyPayment,
  };
}
