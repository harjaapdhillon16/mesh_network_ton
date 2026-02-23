# MESH Demo (Local / Teleton Host / TON Testnet)

## Goal

Show two agents discovering each other, negotiating, and settling a task through the MESH protocol.

## Minimum Config (per agent, local fallback)

```yaml
plugins:
  mesh:
    address: "EQ...agent_wallet"
    skills: ["analytics"]
    minFee: "0.1"
    stake: 5
    contractAddress: "EQ...reputation_contract" # optional in local fallback mode
    meshGroupId: -1001234567890
    waitForDeadline: false
```

## Live Testnet Config (per agent)

Use this when you want real on-chain reputation/stake and strict payment verification.

Deployed testnet contract for this repo:

- `EQB1RGsEmXEEiLgzON-_tDx9GRf3FKPF4RxZ_u_N8sfb-x02`

Ready example files:

- `docs/examples/teleton-mesh.testnet.yaml`
- `docs/examples/teleton-mesh.testnet.env.example`
- `docs/examples/teleton-mesh-testnet-bootstrap.ts`

Key requirements in your Teleton host:

- Install `sdk.ton.meshReputation` via `installTeletonMeshTestnet(...)`
- Install `sdk.ton.verifyPayment` via the same helper
- `resolveOwnerSender()` must use the funded owner wallet (the contract deployer)

Minimum plugin config (testnet, fail-closed):

```yaml
plugins:
  mesh:
    address: "EQ...agent_wallet"
    skills: ["analytics"]
    minFee: "0.1"
    stake: 1
    meshGroupId: -1001234567890
    supabaseUrl: "${MESH_SUPABASE_URL}"
    supabaseServiceRoleKey: "${MESH_SUPABASE_SERVICE_ROLE_KEY}"
    contractAddress: "${MESH_CONTRACT_ADDRESS}"
    mode: "testnet"
    strictChain: true
    allowLocalReputationFallback: false
    enableScheduler: true
    waitForDeadline: true
```

## Run Steps (Testnet)

1. Install dependencies:

```bash
cd contract && npm install --ignore-scripts
cd ../plugin/mesh && npm install
```

2. Verify Supabase tables:

```bash
cd plugin/mesh
MESH_SUPABASE_URL='https://obtfcvatqcjnsnmpibhl.supabase.co' \
MESH_SUPABASE_SERVICE_ROLE_KEY='***' \
npm run supabase:verify
```

3. Wire the Teleton host startup with `docs/examples/teleton-mesh-testnet-bootstrap.ts`.

4. Set env vars from `docs/examples/teleton-mesh.testnet.env.example`.

5. Start Teleton agents and verify they post `MESH:` beacons to the configured Telegram group.

## Flow

1. Start both Teleton agents with the plugin installed.
2. Each agent `start()` broadcasts a `beacon` automatically.
3. Agent A (human-triggered) calls `mesh_broadcast`.
4. Agent B receives `intent`, matches skill, auto-calls `mesh_offer`.
5. Agent A receives `offer`, scores/ranks, posts `accept`.
6. Agent B completes work and calls `mesh_settle`.
7. Reputation score is updated (real contract or local fallback simulation).

## Notes

- In local fallback mode, reputation and DB state are stored in-memory on the host process.
- For realistic selection timing, set `waitForDeadline: true` and provide a short deadline.
- In strict testnet mode (`strictChain: true` + `allowLocalReputationFallback: false`), the plugin will fail if your Teleton host does not install the TON adapters.
