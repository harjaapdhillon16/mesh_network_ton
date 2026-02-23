# MESH Network Spec (Implemented Version)

This repository implements the MESH concept from `MESH_Network_Spec.docx` as:

- A Teleton-compatible plugin in `plugin/mesh/`
- A TON contract scaffold in `contract/`
- Demo/setup docs in `README.md` and `docs/DEMO.md`

## Implemented Protocol

All protocol messages are prefixed with `MESH:` and strict-parsed in `plugin/mesh/protocol.js`.

Supported message types:

- `beacon`
- `intent`
- `offer`
- `accept`
- `settle`
- `dispute`

## Plugin Tools

- `mesh_register`
- `mesh_broadcast`
- `mesh_offer`
- `mesh_settle`
- `mesh_peers`

## Autonomous Hooks

`onMessage()` handles protocol messages without LLM routing and supports:

- peer discovery via `beacon`
- auto-offer generation on matching `intent`
- offer persistence and auto-selection (`offer` -> `accept`)
- local state updates on `settle`

## Local Fallbacks (for end-to-end demo)

To make the project runnable before a live TON deployment, the plugin ships with:

- in-memory registry storage fallback (`registry.js`)
- in-memory reputation contract simulation (`reputation.js`)

The same modules expose integration points for real Teleton DB and TON raw client access.
