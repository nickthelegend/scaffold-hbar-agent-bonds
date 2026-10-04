# Agent instructions

Briefing for coding agents (Claude Code, Cursor, Codex) working in an **Agent Bonds** project. Claude Code loads it through `CLAUDE.md`.

The project lets clients hire AI agents that stake an HBAR bond in `AgentBonds`. Clients pay agents instantly and claw HBAR back from the bond if the work is bad. Read `README.md` → "How it works" before changing contract logic.

## Packages

| Path | What | Toolchain |
|---|---|---|
| `packages/foundry` | `AgentBonds`, deploy script, tests | Foundry (`forge`) |
| `packages/agent` | `@sh/agent`: Hedera Agent Kit plugin, Claude toolkit, `setup`/`demo`/`chat` CLIs | TypeScript, tsx, vitest |
| `packages/nextjs` | Agent directory, profiles, hire/dispute/resolve, registration | Next.js App Router, RainbowKit, wagmi, viem, DaisyUI |

The app imports the ABI, receipt hashing, unit conversions and network constants from `@sh/agent` (`/abi`, `/messages`, `/units`, `/bonds`, `/network`, `/mirror`). Never duplicate the ABI or the message encoding in the frontend. `utils/bonds/format.ts` holds display-only formatting.

## Commands

```bash
yarn install
yarn lint                 # ESLint + forge fmt --check + prettier + tsc
yarn test                 # foundry + agent + frontend unit tests

yarn foundry:compile
yarn foundry:test                                     # unit + fuzz
yarn foundry:test:testnet --match-path "test/fork/*"  # live Chainlink feed
yarn foundry:deploy --network hedera_testnet          # regenerates packages/nextjs/contracts/deployedContracts.ts

yarn workspace @sh/agent sync-abi   # after changing contracts: copy the ABI into packages/agent/src/abi.ts
yarn agent:test
yarn agent:setup          # needs OWNER_PRIVATE_KEY=0x... (funded testnet ECDSA)
yarn agent:demo --wait
yarn agent:chat           # needs ANTHROPIC_API_KEY or `ant auth login`

yarn next:dev             # http://localhost:3000
yarn next:test
yarn next:build
```

After any contract change run, in order: `yarn foundry:test`, `yarn workspace @sh/agent sync-abi`, `yarn agent:test`, `yarn next:check-types`.

## Invariants you must preserve

1. **Units.** `AgentBonds` amounts are **tinybars** (8 decimals); USD values are **6-decimal** fixed point, rounded up. JSON-RPC transaction `value` and `eth_getBalance` are **weibars** (18 decimals). Use the helpers in `packages/agent/src/units.ts` (`hbarToWeibars`, `hbarToTinybars`, …); never hand-roll decimal conversions.
2. **Solvency.** The contract always holds at least `totalBonded`. Every payment is covered by the agent's **free bond** (`bond - locked`) at the moment it is made; a clawback takes from that bond, never from the contract's other funds. `testFuzz_alwaysSolventAndFullyCovered` must keep passing.
3. **Locked coverage can't be withdrawn.** Withdrawals take only free bond and wait one dispute window, so an agent can't front-run a dispute by pulling its bond.
4. **Only the payment's client disputes, only inside the window.** `arbiter == address(0)` means a satisfaction guarantee: refund in full at once. With an arbiter, the payment goes to `Disputed`; the arbiter's `resolve` picks any refund share, and `resolveExpired` refunds in full after `ARBITRATION_PERIOD` so an absent arbiter can't trap funds. The arbiter can never be the agent.
5. **State before transfers.** Every external entry point is `nonReentrant`, and status, `locked` and `bond` are updated before any HBAR moves.
6. **Scheduling is best effort.** A failed or missing Schedule Service must not revert `pay`; `release` stays permissionless after `disputeUntil`. Releases are scheduled at `disputeUntil + SCHEDULE_DELAY`, never exactly at `disputeUntil`: Hedera's `block.timestamp` is the start of the ~2 s block, so a call at second T can observe T-2 and revert `TooEarly`. `RELEASE_FEE` is kept from each payment to pay for that scheduled transaction.
7. **Message encoding is canonical.** `encodeReceipt` / `encodeDisputeReason` key order and formatting are part of the on-chain hash. Changing them breaks verification of existing HCS messages, so bump `v` instead.
8. **`quoteUsd` never reverts.** Oracle problems return `ok = false`; `pay` with a `maxUsd` then reverts with `PriceUnavailable`, and without one it proceeds unpriced.

## Layout

- Contract: `packages/foundry/contracts/AgentBonds.sol` (`interfaces/` holds the Schedule Service and Chainlink interfaces)
- Contract tests: `packages/foundry/test/AgentBonds.t.sol`; mocks in `test/mocks/` are etched at the system address (`0x16b`); live fork test in `test/fork/`
- Plugin tools: `packages/agent/src/plugin/index.ts` (extend `BaseQueryTool` for reads; transaction tools build in `coreAction` and submit in `secondaryAction` so Agent Kit hooks can inspect them first)
- Contract gateway: `packages/agent/src/bonds.ts` (`RpcBondsGateway` simulates, then sends with twice the gas estimate)
- Claude adapter: `packages/agent/src/claude-toolkit.ts`
- App: `packages/nextjs/app/page.tsx` (directory), `app/agent/[address]/page.tsx`, `app/register/page.tsx`, `components/bonds/`, `hooks/bonds/`, `utils/bonds/`

## Frontend conventions

- `AgentBonds` lives in `deployedContracts.ts`, so reads use `useScaffoldReadContract`. Writes go through `useBondsWrite` from `~~/hooks/bonds`, which sends twice the gas estimate and takes `value` in weibars.
- History comes from the mirror node (`utils/bonds/activity.ts`). It pages through the full history and sorts by consensus timestamp and then log index, because the mirror node returns newest first. Keep decoding logic pure and unit-tested in `packages/nextjs/test/`.
- Use DaisyUI classes (`btn`, `badge`, `card`, `join`) before raw Tailwind. Imports use the `~~` alias. Add `"use client"` to pages that use hooks.
- Scaffold's abitype config types addresses as `string`. Cast to viem's `Address` at the boundary.

## Extending

- **HTS token bonds and payments (e.g. USDC):** add token-denominated `bond`/`locked` per token, associate the contract with the token, and price stablecoins 1:1.
- **Reputation:** the per-agent `payments`, `disputes` and `clawbacks` counters are on-chain; a score belongs in the frontend or an indexer, not in the contract.
- **Another agent framework:** the plugin already works with every Agent Kit adapter; pass `createAgentBondsPlugin(...)` in `configuration.plugins`.

## Style

| Style | Use |
|---|---|
| `UpperCamelCase` | types, components, contracts |
| `lowerCamelCase` | variables, functions |
| `CONSTANT_CASE` | constants |

Solidity: custom errors (no `require` strings), NatSpec on external functions, `forge fmt`. TypeScript: prefer `type` over `interface` except for implementable contracts (`BondsGateway`, `MessagePublisher`), let inference work, and write comments that add information.
