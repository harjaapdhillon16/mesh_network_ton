# MESH Demo (Local / Teleton Host)

## Goal

Show two agents discovering each other, negotiating, and settling a task through the MESH protocol.

## Minimum Config (per agent)

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
