# Scaffold-HBAR Template Bounty: submission pack (Agent Bonds)

Form: https://docs.google.com/forms/d/e/1FAIpQLSfMrExu3tI95KP9WlwtS9JFka5iy3uWOi8vVK4JqpLbd0FTPA/viewform
Deadline: **Sunday 4 Oct 2026, 23:59 ET (5 Oct, 03:59 UTC)**

This is a **separate submission** from Agent Guardrails (one form per template). Fields marked **YOU** need your input; everything else is ready to paste.

---

## Page 1

| Field | Answer |
|---|---|
| Email | **YOU** (the address you registered with) |
| Bounty | Scaffold HBAR Template |

## Team Details

| Field | Answer |
|---|---|
| Team Size | **YOU** |
| Team Member Names | **YOU** (comma separated, include yourself) |
| Team Member Emails | **YOU** |
| Team Member X handles | **YOU** (optional) |
| Mainnet Account ID | **YOU**: your *mainnet* `0.0.x` account, where the prize is paid. Not a testnet account. |

## Submission Details

**Project Name**

```
Agent Bonds
```

**Project Description** (3 sentences max)

```
Agent Bonds is a Scaffold-HBAR template for hiring AI agents with skin in the game: agents stake an HBAR bond in a contract, clients pay them instantly, and every payment stays fully refundable from that bond during a dispute window, so bad work gets clawed back on-chain (instantly under a satisfaction guarantee, or split by an arbiter). Undisputed payments are released by a call the contract schedules for itself on the Hedera Schedule Service (HIP-1215, no keeper), agents publish work receipts to a Hedera Consensus Service topic whose hash the contract stores, and Chainlink HBAR/USD prices every payment so clients can cap what they pay in dollars. It ships a Hedera Agent Kit v4 plugin with a Claude procurement agent, a mirror-node-powered agent directory with hire/claw-back/arbitrate flows, a Hedera Harness recipe that passes on a fresh scaffold, and a recorded live testnet run of every outcome.
```

**Project GitHub URL**

```
https://github.com/nickthelegend/scaffold-hbar-agent-bonds
```

**Video demo** (< 5 min): https://agent-bonds-demo.vercel.app/agent-bonds-demo.mp4 (70 s; player page: https://agent-bonds-demo.vercel.app)

**Any other links**

```
Scaffold: npm create scaffold-hbar@latest -- --template nickthelegend/scaffold-hbar-agent-bonds
Live app (testnet): https://scaffold-hbar-agent-bonds.vercel.app
Bonded agent with real history (2 network releases, 1 clawback): https://scaffold-hbar-agent-bonds.vercel.app/agent/0x9A5B09b33fAd0B3e464fC24efAD65b8277eB10c5
Arbitrated agent (50/50 ruling): https://scaffold-hbar-agent-bonds.vercel.app/agent/0xDC08c23B8457ab052DD9659Cc6327d30Cd5D8afb
AgentBonds contract (Sourcify verified): https://hashscan.io/testnet/contract/0.0.10853651
Network-executed release (Hedera Schedule Service): https://hashscan.io/testnet/schedule/0.0.10853713
Clawback transaction: https://hashscan.io/testnet/transaction/0x1a0c1982a45f7638af6024e01fe1e63b50bb46ae4bb59f7d327139fa0787f8fc
Agent work receipts (HCS): https://hashscan.io/testnet/topic/0.0.10853654
Full proof table: https://github.com/nickthelegend/scaffold-hbar-agent-bonds#live-on-hedera-testnet
```

## Developer Experience

The 1–10 scores are your call. Suggested free-text answers, drawn from what actually happened while building:

**Biggest friction or blocker**

```
Hedera reports the start of the ~2s block as block.timestamp, which is not documented next to the Schedule Service: our first deployment scheduled each release exactly at the end of the dispute window, the network executed it on time, but inside a block that started 1.4s earlier, so the contract saw an earlier timestamp and reverted with TooEarly. We only found it by reading the mirror node's block and schedule records, and fixed it by scheduling 10s past every deadline. Separately, the JSON-RPC relay under-estimates gas for calls that create or delete schedules, and viem's EIP-1559 fee estimate on Hashio is near zero and gets rejected.
```

**One thing to improve**

```
Document, next to HIP-1215, how block.timestamp relates to a scheduled call's expiry second (and recommend a margin), who pays scheduled fees, and that relay gas estimates under-count system-contract work. A scheduled-call example contract with these patterns would save every builder the same debugging session.
```

**What worked especially well**

```
A contract scheduling its own future call is a unique primitive that removes the keeper every other chain needs for "release after N minutes". HCS topics with a submit key are a perfect, cheap receipt log for agents, and the mirror node made a backend-free app possible. Hedera Agent Kit v4's BaseTool lifecycle let the same plugin serve both the hiring agent and the hired agent, and create-scaffold-hbar's template.json outro plus the Hedera Harness made the template verifiable end to end.
```

---

## Eligibility gate: evidence

| Gate item | Status |
|---|---|
| Scaffolds via `npm create scaffold-hbar@latest -- --template nickthelegend/scaffold-hbar-agent-bonds` | ✅ Fresh scaffold verified on 4 Oct |
| `template.json` valid | ✅ Parsed by the CLI (capabilities and outro render) |
| `README.md` and `AGENTS.md` | ✅ |
| Install, lint, build clean from a fresh scaffold | ✅ Lint clean; 46 unit tests (21 Foundry, 20 agent, 5 frontend) plus a live Chainlink fork test; `next build` OK |
| App boots, routes OK | ✅ `/`, `/register`, `/agent/[address]`, `/api/health` return 200 (local and hosted) |
| Hedera services with a testnet tx and HashScan proof | ✅ Smart contracts, Schedule Service, HCS, plus Chainlink. See README "Live on Hedera testnet" |
| No secrets or `.env` committed | ✅ Keys live outside the repo; `.env` files are git-ignored |
| MIT licence, original work | ✅ |
| Harness spec and validators | ✅ `.harness/`: on a fresh scaffold `yarn harness:validate` reports `passed=true`, 0 findings (static, commands, Playwright gate on 4 routes) |

## Still to do

- [x] Record the demo video (< 5 min) and paste its URL into "Video demo".
- [ ] Fill in the **YOU** fields and submit before 03:59 UTC on 5 Oct.
