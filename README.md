# MESH Network

MESH is an autonomous agent coordination layer for Teleton agents on TON. This repository implements the provided contest spec end-to-end with a working plugin and a TON contract scaffold.

## Repository Layout

- `plugin/mesh/` Teleton plugin (`manifest`, tools, hooks, router, protocol, reputation adapter)
- `contract/` TON Blueprint-style contract scaffold (`reputation.fc`, deploy script, tests)
- `docs/` spec summary and demo steps

## What Works Now

- `MESH:` protocol message parsing + schema sanitization
- Peer registry, intents, offers, deals with PostgreSQL support (Supabase-compatible) and in-memory fallback
- 5 plugin tools:
  - `mesh_register`
  - `mesh_broadcast`
  - `mesh_offer`
  - `mesh_settle`
  - `mesh_peers`
- Autonomous `onMessage` handlers for `beacon`, `intent`, `offer`, `accept`, `settle`
- Deterministic offer routing/scoring with live reputation fetch (via adapter)
- Idempotent inbound message processing (`processed_messages`) and atomic intent acceptance (Postgres)
- Deadline scheduler for pending intent selection/expiry
- Local reputation contract simulation for offline demos (disabled in production mode)
- Compiled TON Blueprint wrapper + sandbox-tested FunC reputation contract
- Reusable host adapter factory for `sdk.ton.meshReputation` (`contract/wrappers/createMeshReputationAdapter.ts`)

## Quick Start (Plugin)

1. Install dependencies:

```bash
cd plugin/mesh
npm install
```

2. Copy plugin into your Teleton plugins directory (or symlink it).

3. Initialize storage (choose one backend):

```bash
cd plugin/mesh
MESH_DATABASE_URL='postgresql://...' npm run migrate:pg
```

Or for Supabase REST mode (no direct DB socket / IPv4-safe):

1. Run `plugin/mesh/supabase/schema.sql` in Supabase SQL Editor
2. Verify schema over HTTPS:

```bash
cd plugin/mesh
MESH_SUPABASE_URL='https://PROJECT_REF.supabase.co' \
MESH_SUPABASE_SERVICE_ROLE_KEY='***' \
npm run supabase:verify
```

4. Add mesh config to Teleton config:

```yaml
plugins:
  mesh:
    address: "EQ...your_wallet"
    skills: ["swap", "analytics"]
    minFee: "0.1"
    stake: 5
    meshGroupId: -1001234567890
    # Choose ONE backend:
    databaseUrl: "${MESH_DATABASE_URL}"   # direct Postgres
    # supabaseUrl: "${MESH_SUPABASE_URL}" # HTTPS/PostgREST mode
    # supabaseServiceRoleKey: "${MESH_SUPABASE_SERVICE_ROLE_KEY}"
    contractAddress: "EQ...deployed_contract"
    mode: "testnet"                       # use "production" only with real chain adapter
    waitForDeadline: true
    enableScheduler: true
    schedulerIntervalMs: 1000
    sendRetries: 2
    sendRetryBaseMs: 150
    allowLocalReputationFallback: true    # set false in production
```

5. Start Teleton. The plugin `start()` hook auto-broadcasts a beacon and starts the deadline scheduler.

## Postgres (Supabase) Notes

- The plugin now supports direct Postgres access through `pg`.
- The plugin also supports Supabase REST/PostgREST over HTTPS (recommended if direct DB host is not IPv4 reachable).
- Use env vars for secrets (`MESH_DATABASE_URL`, `MESH_SUPABASE_SERVICE_ROLE_KEY`), not hardcoded values in repo files.
- Treat the Supabase `service_role` key as root-level backend secret; never ship it to clients.
- Health check:

```bash
cd plugin/mesh
MESH_DATABASE_URL='postgresql://...' npm run db:health
```

Supabase REST health check:

```bash
cd plugin/mesh
MESH_SUPABASE_URL='https://PROJECT_REF.supabase.co' \
MESH_SUPABASE_SERVICE_ROLE_KEY='***' \
npm run db:health
```

Tables required by the MESH storage schema:

- `peers`
- `intents`
- `offers`
- `deals`
- `processed_messages`

## Production Runtime Flags

- `mode=production` (or `mainnet`) enables strict startup checks
- `contractAddress` required in production mode
- `MESH_DATABASE_URL` OR (`MESH_SUPABASE_URL` + `MESH_SUPABASE_SERVICE_ROLE_KEY`) required in production mode
- `allowLocalReputationFallback=false` required in production mode

## TON Contract Integration (Production/Testnet)

The plugin exposes a stable adapter hook so the Teleton host can inject a real Blueprint wrapper:

- `sdk.ton.meshReputation.registerAgent(...)`
- `sdk.ton.meshReputation.getReputation(...)`
- `sdk.ton.meshReputation.getStakeInfo(...)`
- `sdk.ton.meshReputation.recordOutcome(...)`
- `sdk.ton.meshReputation.slash(...)`
- `sdk.ton.meshReputation.withdrawStake(...)`

This is the clean path to replace the local fallback. Concrete adapter helpers are included:

- `contract/wrappers/createMeshReputationAdapter.ts`
- `contract/wrappers/createTonPaymentVerifier.ts`
- `contract/wrappers/installTeletonMeshTestnet.ts`

Minimal host wiring (example):

```ts
import { Address } from '@ton/core';
import { TonClient } from '@ton/ton';
import { createMeshReputationAdapter } from './contract/wrappers/createMeshReputationAdapter';
import { Reputation } from './contract/wrappers/Reputation';

const client = new TonClient({ endpoint: process.env.TON_RPC_ENDPOINT! });
const contractAddress = Address.parse(process.env.MESH_CONTRACT_ADDRESS!);

sdk.ton.meshReputation = createMeshReputationAdapter({
  defaultContractAddress: contractAddress,
  resolveContract: (addr) => client.open(Reputation.createFromAddress(addr)),
  resolveAgentSender: async (agentAddr) => sdk.ton.getSenderForAddress(agentAddr.toString()),
  resolveOwnerSender: async () => sdk.ton.getOwnerSender(),
});
```

`recordOutcome` and `slash` require the contract owner sender (current contract policy).

### Live On TON Testnet (Teleton)

This repo now includes a one-call installer for Teleton hosts that wires both:

- `sdk.ton.meshReputation` (on-chain reputation contract calls)
- `sdk.ton.verifyPayment` (strict recipient tx verification using TON RPC history scan)

Example host setup:

```ts
import { TonClient } from '@ton/ton';
import { installTeletonMeshTestnet } from './contract/wrappers/installTeletonMeshTestnet';

const tonClient = new TonClient({
  endpoint: process.env.TON_RPC_ENDPOINT!,
  apiKey: process.env.TON_API_KEY,
});

installTeletonMeshTestnet({
  sdk,
  tonClient,
  meshContractAddress: process.env.MESH_CONTRACT_ADDRESS!,
  resolveAgentSender: async (agentAddr) => sdk.ton.getSenderForAddress(agentAddr.toString()),
  resolveOwnerSender: async () => sdk.ton.getOwnerSender(),
  payment: {
    defaultLookbackLimit: 50,
    defaultMaxTxAgeSeconds: 60 * 60,
  },
});
```

Recommended plugin config for testnet (fail closed if chain integration is missing):

```yaml
plugins:
  mesh:
    mode: "testnet"
    strictChain: true
    allowLocalReputationFallback: false
    contractAddress: "${MESH_CONTRACT_ADDRESS}"
    supabaseUrl: "${MESH_SUPABASE_URL}"
    supabaseServiceRoleKey: "${MESH_SUPABASE_SERVICE_ROLE_KEY}"
    meshGroupId: -1001234567890
    enableScheduler: true
```

`mesh_settle` now passes `expectedRecipient`, `expectedSender`, and `intentId` into `sdk.ton.verifyPayment(...)`, so the testnet verifier can reject spoofed tx hashes.

## Contract Notes

`contract/contracts/reputation.fc` and the Blueprint wrapper are implemented and sandbox-tested. Mainnet readiness still requires testnet deployment, real payment verification, message signing, and Teleton host integration.

## Next Steps

- Add integration tests against a Teleton host and TON testnet/mainnet canary
- Add message signing/auth verification for `MESH:` protocol messages
- Replace demo `verifyPayment` fallback with strict on-chain verification + finality checks
