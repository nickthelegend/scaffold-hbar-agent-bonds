# Agent Bonds — product requirements

## Problem
Paying an AI agent is a leap of faith: once the HBAR is sent, a client has no recourse if the agent hallucinates,
plagiarises or does nothing. Escrow fixes recourse but makes agents wait to be paid. Clients need refunds the chain
enforces, and agents need to be paid at once.

## Users
- **Agent operator** (wallet or process holding the agent's ECDSA key): registers the agent, posts and withdraws
  its bond, publishes work receipts.
- **Client** (human or AI agent): hires agents, disputes bad work inside the window.
- **Arbiter** (optional address chosen by the agent): splits disputed payments.

## Requirements
1. `register(name, arbiter, disputeWindow, receiptTopic)` registers `msg.sender` as an agent; `msg.value` is its
   bond. `arbiter == 0` means a satisfaction guarantee (any dispute refunds in full). The arbiter can't be the agent.
2. `pay(agent, jobHash, maxUsd)` requires the agent's **free bond** (bond minus locked) to cover `msg.value`, locks
   that much bond, sends `msg.value - RELEASE_FEE` to the agent immediately, and reverts if the Chainlink USD value
   exceeds `maxUsd` (when set). It schedules `release(id)` on the Hedera Schedule Service (0x16b) at
   `disputeUntil + SCHEDULE_DELAY`, funded by `RELEASE_FEE`.
3. `dispute(id, reasonHash)` (client only, inside the window) refunds the client from the bond at once under a
   guarantee, or moves the payment to `Disputed` for the arbiter, and deletes the pending schedule.
4. `resolve(id, refundBps)` (arbiter) refunds any share; `resolveExpired(id)` refunds in full once the arbitration
   period lapses. `release(id)` is permissionless after the window as a fallback.
5. Bond withdrawals wait one dispute window and can only take free bond, so locked coverage can't be pulled out.
6. Solvency: the contract always holds at least `totalBonded`.
7. Agents publish receipts to an HCS topic whose submit key is the agent's key; the contract stores
   `keccak256(message)` and the dashboard shows "verified on HCS" when they match.
8. `@sh/agent` ships a Hedera Agent Kit v4 plugin (`bonds_*` tools), a scripted demo, a Claude chat agent and a
   bootstrap CLI. The Next.js app has an agent directory, agent profiles with hire/dispute/resolve, and registration.

## Out of scope
HTS token bonds and payments, reputation scores beyond raw counts, mainnet deployment.
