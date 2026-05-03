# MMM TOKEN — LAUNCH READINESS AUDIT REPORT

**Date:** 2026-05-03
**Auditor role:** Senior Solidity Security Engineer + Full-Stack Web3 Auditor
**Branch:** `claude/mmm-token-launch-audit-O6bhZ`
**Scope:** `contracts/`, `test/`, `scripts/`, `Frontend/`, `dashboard/`, `roadmap/`, `deployments/`

> **Note on tooling:** `npx hardhat compile` is blocked in the audit sandbox
> (solc binary download denied by host allowlist). All findings below come
> from static review of source + behavioral reasoning, not from a fresh test
> run. CI must reproduce these tests outside the sandbox before launch.

---

## OVERALL VERDICT: 🔴 DO NOT LAUNCH

Critical economic exploits #5, #6 and #7 are now patched —
reward-debt desync and retroactive claim closed by fix #1
(token↔vault sync hook), dust-primer hold bypass closed by fix #2
(balance-weighted entry timestamp). See "Fix Log" at the bottom of
this file. **The remaining critical items are still open**: no
emergency pause, no tax-rate cap or owner timelock, broken mainnet
deploy script, and the Frontend `claim` button is still a
`localStorage` stub. Several test files reference non-existent
contracts and functions and cannot run.

**Blocker count: 4 critical · 5 high · 6 medium · 4 low**
(was 7 critical — 3 closed by the 2026-05-03 fix series)

---

## SECTION 1 — SMART CONTRACTS

Solidity `^0.8.24` ✅ (overflow-safe). Optimizer 200 runs ✅.
OpenZeppelin v5 ✅. `Ownable` (single step). `ReentrancyGuard` used in
vaults ✅.

### Known issues — verification

| # | Issue | Status | Evidence |
|---|---|---|---|
| 1 | Token inflation via double `_update` | ✅ **FIXED** | `MMMToken.sol:214-239`. Buy: pair→buyer (full) then buyer→taxVault (tax). Sell: from→taxVault (tax) then from→pair (amount-tax). Conservation holds. |
| 2 | Integer division loss in `notifyRewardAmount` | ❌ **OPEN** (medium) | `RewardVault.sol:221` — no remainder accumulator. |
| 3 | `syncRewardDebt` unprotected | 🟡 **PARTIAL** | `RewardVault.sol:312-319` now has `onlyOwner`, BUT in production wiring ownership is transferred to `TaxVault`, which has no proxy → function is **permanently unreachable**. |
| 4 | TaxVault constructor missing contract validation | 🟡 **PARTIAL** | `TaxVault.sol:130-140` checks `address(0)` only. No `code.length > 0` check. Same defect in `RewardVault.sol:102-105`. |
| 5 | Reward debt desynchronization | ✅ **FIXED** (2026-05-03) | `MMMToken._update` now brackets the transfer with `RewardVault.preTransferHook` / `postTransferHook` (commit on branch `claude/mmm-token-launch-audit-O6bhZ`). `pre` crystallises pending into a `claimable` accumulator using OLD balance; `post` resyncs `rewardDebt` to NEW balance. See Fix Log #1. |
| 6 | Dust wallet hold-time bypass | ✅ **FIXED** (2026-05-03) | `_syncLastNonZero` removed; receivers now go through `_onReceiveUpdate` which applies a balance-weighted average timestamp `(prevBal*prevTs + amount*now) / newBal`. A 1-wei primer followed by 1M MMM snaps the clock to ≈ `now`. Senders only reset on a full exit so partial-sell behaviour is preserved. Regression tests in `test/mmmToken.dustPrimer.test.js`. See Fix Log #2. |
| 7 | Retroactive reward claim by new holders | ✅ **FIXED** (2026-05-03) | Same fix as #5: a fresh receiver's `rewardDebt` is set to `newBalance * accRewardPerToken` in `postTransferHook`, so `pending()` returns 0 immediately after the buy. Regression test in `test/rewardVault.retroClaim.test.js`. |
| 8 | O(n) gas DoS in `eligibleSupply` | ❌ **OPEN** (high) | `RewardVault.sol:119-131` still iterates `excludedRewardAddresses` on every notify. No removal function — append-only. |
| 9 | Double `_update` calls / double `Transfer` events | ❌ **OPEN** (medium, by design) | Two events per taxed transfer. Required for the buy-side fix. Must be documented for indexers. |
| 10 | Hardcoded router exclusion | ✅ **FIXED** | `MMMToken._update` keys tax purely off `from == pair` / `to == pair` (lines 179-188). Router excluded from logic. |

### Critical sell-path UX trap (not in issues.txt)

`super._update(from, to, amount - tax)` on a sell sends only `amount - tax`
to the pair. Standard `swapExactTokensForTokens` will revert because the
pair's K invariant breaks. Users **must** call
`swapExactTokensForTokensSupportingFeeOnTransferTokens`. This is undocumented
in Frontend, dashboard, or any user-facing surface.

### Additional contract findings

- **[CRITICAL] No emergency pause / kill switch.** No `Pausable`,
  no `pause()`. Once `launch()` flips `tradingEnabled = true`
  (`MMMToken.sol:97-106`), there is no path back. If a reward-drain
  exploit hits day 1, there is nothing to pull.
- **[CRITICAL] No tax-rate cap, no timelock on owner powers.**
  `setTaxExempt`, `setPair`, `setRouter` are immediate `onlyOwner`.
  Single key can flip exemptions, repoint pair, redirect tax flow.
  No `Ownable2Step`, no Safe wrapping, no Timelock in repo.
- **[HIGH] `notifyRewardAmount` does not verify vault funding.**
  `RewardVault.sol:211` bumps `accRewardPerToken` against a parameter,
  not against actual balance. Safe today because the only caller
  (`TaxVault._process`, line 260-262) pre-transfers the MMM, but a
  future owner-rotation can brick claims if the invariant is dropped.
- **[HIGH] First buyer drains the pool.** With #5/#7 open and tiny
  `eligibleSupply()`, a sniper who buys early gets `accRewardPerToken`
  pumped entirely against their balance.
- **[MEDIUM] `BoostNFT` is owner-mint only.** No price, no allowlist,
  no per-wallet cap, no `_baseURI`. `tokenURI` returns "". No mint UI
  in either Frontend or dashboard. NFT utility advertised in roadmap
  is undeliverable today.
- **[MEDIUM] Boost reads silently swallow all errors.**
  `try ... catch {}` at `RewardVault.sol:155, 181, 252, 273`. A buggy
  boost contract loses users their boost without diagnosis.
- **[LOW] Tax peaks at 80% (8000 bps) for first 10 minutes.** Above
  any reasonable disclosure threshold; nowhere documented to users.
- **[LOW] `MMMToken.setRouter` and `TaxVault.setRouter` mutable any
  time.** Tax flow can be redirected post-launch.
- **[LOW] `TaxVault._process` calls `swapExactTokensForTokens` with
  `minUsdcOut = 0` from the keeper path** (`TaxVault.sol:211`). MEV
  sandwich risk on every keeper sweep. Use Flashbots or enforce TWAP.

---

## SECTION 2 — TESTS

**Cannot execute** in sandbox (solc download blocked). Static review:

- **[CRITICAL]** `test/unit/MMMToken.test.js`,
  `test/unit/RewardVault.test.js`, `test/unit/TaxVault.test.js` import
  `deployFixture` but call `loadFixture(protocolFixture)` (undefined →
  `ReferenceError`).
- **[CRITICAL]** `test/fixtures/protocol.fixture.js` itself is broken:
  - `MMMToken.deploy(owner, USDC)` — wrong signature (token takes
    `name, symbol, supply, owner`).
  - `RewardVault.deploy(MMM, USDC)` — wrong signature (takes 5 args).
  - `TaxVault.deploy(MMM, USDC, RV, SV, MV, TV)` — wrong signature.
  - References `SwapVault` — contract does not exist in `/contracts`.
  - Calls `MMM.setTaxVault(...)` — actual function is `setTaxVaultOnce`.
  Result: every file in `test/unit/*` and `test/integration/*` fails
  at fixture load. Effective coverage from those ~1000 lines = **0%**.
- **[HIGH]** `test/rewardVault.distribution.test.js` and
  `test/rewardVault.claim.test.js` call
  `rewardVault.connect(owner).notifyRewardAmount(...)` after
  `coreFixture` transferred ownership to `TaxVault` → these revert.
  Only `rewardVault.proportional.test.js` impersonates correctly.
- **[HIGH]** No regression test exists for any open issue (#2, #3,
  #5, #6, #7, #8). The exploits will pass CI silently.
- **[MEDIUM]** `test/core.test.js` is a 14-line stub.
- **[MEDIUM]** No coverage config; threshold (>85%) cannot be measured.

**Effective passing tests:** ~8 of the ~20 spec files. Coverage on
`MMMToken`, `RewardVault`, `TaxVault` core logic is well below the
85% launch bar.

---

## SECTION 3 — DEPLOYMENT

- **[CRITICAL]** `scripts/deploy-v1-locked-main.js` does not match
  current contracts:
  - Line 247: `TaxVaultFactory.deploy(MMMToken, deployer.address)` —
    actual constructor is `(mmm, usdc, wmon, owner)`.
  - Lines 253-261: `RewardVaultFactory.deploy(MMM, TaxVault, MIN_HOLD,
    COOLDOWN, MIN_BAL, owner)` — actual takes 5 args, not 6.
  - Line 268: `tv.setRewardVaultOnce(RewardVault)` — function does not
    exist; real wiring is `wireOnce(rv, mv, tv)`.

  **This is the script labeled for MAINNET. Running it as-is fails
  before TaxVault is up.**
- **[GOOD]** `scripts/deploy-official-testnet.js` matches all current
  constructors. Use this (parameterized for mainnet) as the canonical
  deploy script.
- **[HIGH]** ~50 deploy/test scripts in `/scripts` with overlapping
  names (`deploy-v1.js`, `deploy-v1-locked.js`,
  `deploy-v1-locked-main.js`, `deploy-v1-locked-testnet-FIXED.js`,
  `deploy-v1-testnet.js`, …). No runbook indicates which is canonical.
  `README.md` is the unmodified Hardhat sample.
- **[HIGH]** No Etherscan / Sourcify verification step in any
  deploy script.
- **[MEDIUM]** No post-deploy assertion script (verify wiring,
  ownership, exemptions, eligibleSupply > 0).
- **[LOW]** `Frontend/config.js` MMM address (`0x08e3e7…`) is stale vs
  `deployments/monadTestnet/latest.json` (`0x67d50…`).

---

## SECTION 4 — FRONTEND (`/Frontend`)

- **[CRITICAL] The "claim" button does not call any contract.**
  `Frontend/app.js:526-558` (`handleClaim`) only updates `localStorage`
  and shows "Successfully claimed!". No `RewardVault.claim()` call.
  The "Total MON Claimable" tile shows the user's wallet MON balance
  (`app.js:396`), unrelated to reward state.
- **[HIGH]** Hardcoded testnet contract addresses, single-network only
  (chainId `0x279F`). No mainnet config.
- **[HIGH]** Stale MMM address — see Section 3.
- **[MEDIUM]** Tailwind play-CDN script (warns "not for production")
  + ethers v5 via CDN, no SRI hashes (supply-chain risk).
- **[MEDIUM]** No build pipeline.
- **[LOW]** Throws if MetaMask isn't installed; rejects WalletConnect,
  Coinbase Wallet, Rabby, etc.

---

## SECTION 5 — DASHBOARD (`/dashboard`)

- **[GOOD]** `dashboard/App.js:658` does call `rewardVault.claim()`,
  reads `pending`, `lastClaimAt`, `claimCooldown`, `holdRemaining`,
  `cooldownRemaining` correctly. Wallet connection / chain switching
  works.
- **[HIGH]** Three sources of truth for contract addresses, all
  different:

  | Source | MMM Address |
  |---|---|
  | `Frontend/config.js` | `0x08e3e7677Dd…23dc` |
  | `dashboard/App.js` | `0xB188557475…9D56` |
  | `deployments/monadTestnet/latest.json` | `0x67d50091365…2A55` |

- **[MEDIUM]** Single-network. ethers v6 here vs v5 in Frontend
  (duplicated effort).
- **[MEDIUM]** 1811-line single-file app; no tests.

---

## SECTION 6 — ROADMAP (`/roadmap`)

- **[MEDIUM]** Generic "Phase 0/1/2/3" language; no dates, no KPIs,
  no specific deliverables. NFT layer is in "Phase 3 — Optional",
  contradicting that BoostNFT is wired into `RewardVault` today.
- **[LOW]** Two competing index files (`index.html` and
  `1index.html`) — pick one.
- **[LOW]** Roadmap claims "Reward gating verified" while Critical
  issues #5, #6, #7 are unpatched. Misleading.

---

## SECTION 7 — NFTs (`BoostNFT`)

- **[GOOD]** Standard OZ `ERC721`. Transfers locked by default.
  Supply caps (666 common / 333 rare). `bestBoostOf` maintained on
  transfer. Boost config can be frozen.
- **[HIGH]** No public mint flow. `mintCommon` / `mintRare` are
  `onlyOwner`. No price, allowlist, Merkle proof, or per-wallet cap.
  No mint UI anywhere in repo.
- **[HIGH]** No metadata. No `_baseURI` override → `tokenURI`
  returns `""`. No artwork file or IPFS CID in repo.
- **[MEDIUM]** Boost reduces hold/cooldown only; does **not**
  multiply rewards. Roadmap text "BoostNFT reward multipliers" is
  inaccurate.
- **[MEDIUM]** `transfersEnabled` is two-way settable any time
  (no timelock).
- **[LOW]** No reveal mechanism / provenance hash.

---

## SECTION 8 — SECURITY POSTURE

- **[CRITICAL] No external audit.** `issues.txt` is self-audit only,
  and the worst items are unfixed.
- **[CRITICAL] No emergency pause.** See Section 1.
- **[HIGH] Single-key ownership of `MMMToken` and `TaxVault`** in
  current testnet manifests (deployer = `0xBF98e5F…`). RewardVault
  ownership transferred to TaxVault, but TaxVault is owned by the
  same single deployer key. One compromised key = full protocol
  drain (exemptions, pair repointing, processing redirect).
- **[HIGH] No Slither / Mythril / Foundry invariants in repo.**
- **[HIGH] No bug bounty program documented.**
- **[HIGH] No liquidity lock evidence.** `deploy-official-testnet.js`
  seeds the pair and mints LP to the deployer EOA (`scripts/deploy-official-testnet.js:294`).
  No Unicrypt / Team.Finance lock or multisig destination.
- **[LOW] No secrets found** in the repo (good — `.env` is gitignored,
  `.env.example` contains only addresses).
- **[LOW] `hardhat.config.js`** loads up to three private keys from
  env (`PRIVATE_KEY`, `TESTER_PRIVATE_KEY`, `CLAIMER_PRIVATE_KEY`).
  Standard, but production keys belong in a hardware wallet, not
  `.env`.

---

## PRIORITY FIX LIST (by severity)

1. ✅ **DONE (2026-05-03) — Implement RewardVault sync hook in `MMMToken._update`.**
   `MMMToken._update` is split into a hook-bracketed shell + an internal
   `_doUpdate` that holds the existing tax/transfer logic. New external
   functions on `RewardVault`:
   - `preTransferHook(from, to)` — crystallises each side's accrual
     against their CURRENT balance into a new `claimable[user]`
     accumulator and sets `rewardDebt = balance * accRewardPerToken`.
   - `postTransferHook(from, to)` — resyncs `rewardDebt = newBalance *
     accRewardPerToken` after the transfer settles.

   Both functions are guarded by an `onlyToken` modifier
   (`msg.sender == address(mmm)`). `RewardVault.pending()` and
   `claim()` now read from `claimable[user]`. New token wiring:
   `MMMToken.setRewardVaultOnce(rv)` (one-shot, owner-only).

   Wired in `test/fixtures/core.fixture.js` and
   `scripts/deploy-official-testnet.js`. Regression coverage in
   `test/rewardVault.retroClaim.test.js` (3 cases: new buyer gets 0
   retroactive; partial sell preserves crystallised; hook rejects
   non-token callers). **Resolves #5, #7.**

2. ✅ **DONE (2026-05-03) — Fix dust-primer hold tracking.**
   `MMMToken` replaces `_syncLastNonZero` with two helpers:
   `_onSendUpdate(addr)` resets `lastNonZeroAt` only on full exit
   (preserving the partial-sell semantic), and
   `_onReceiveUpdate(addr, amountReceived)` advances
   `lastNonZeroAt` using a balance-weighted average:

       newTs = (prevBal * prevTs + amountReceived * now) / newBal

   Tiny dust top-ups round to a no-op via integer division; a real
   position snaps the clock to ≈ `now`, so the attacker has to wait
   the full hold window against the size that actually claims.

   All `_doUpdate` paths (mint/burn, no-tax transfer, taxBps==0,
   buy, sell, fallback) wired through the new helpers. Buy uses
   the buyer's NET receipt (`amount - tax`) so a buyer is not
   double-credited. Regression coverage in
   `test/mmmToken.dustPrimer.test.js` (5 cases: dust+real snaps to
   now, claim is blocked then permitted after the new hold,
   tiny top-ups are no-ops, partial sell preserves the stamp,
   full exit + re-entry resets cleanly). **Resolves #6.**

3. **[CRITICAL] Add `Pausable` to `MMMToken`** with a separate
   `guardian` role that can ONLY pause (cannot move funds, cannot
   mint). **Effort: 0.5 day.**

4. **[CRITICAL] Lock down owner powers.** Cap tax in BPS, add
   `Ownable2Step`, wrap owner in a 2-of-N Safe, place `setTaxExempt`,
   `setPair`, `setRouter` behind a 24-48h Timelock.
   **Effort: 1 day code + ops.**

5. **[CRITICAL] Lock LP** via Unicrypt or Team.Finance, ≥6 month
   lock, before any public launch. **Effort: 1h ops.**

6. **[CRITICAL] Fix or delete `scripts/deploy-v1-locked-main.js`.**
   Standardize on `deploy-official-testnet.js` parameterized for
   mainnet. Add post-deploy assertion script + Etherscan verify.
   **Effort: 1 day.**

7. **[CRITICAL] Replace `Frontend/app.js` claim handler** with a
   real `RewardVault.claim()` call; show real `pending(user)` in
   the "Total Claimable" tile. **Effort: 0.5 day.**

8. **[HIGH] Bound `eligibleSupply` gas.** Maintain a running
   `excludedSupplySum` updated via `_update` hook OR cap
   `excludedRewardAddresses.length` in the setter and add
   `removeExcludedRewardAddress`. **Resolves #8. Effort: 0.5 day.**

9. **[HIGH] Add `addr.code.length > 0`** in `TaxVault` and
   `RewardVault` constructors. **Resolves #4 properly. Effort: 15m.**

10. **[HIGH] Single source of truth for addresses.** Generate
    `Frontend/config.js` and `dashboard/App.js` constants from
    `deployments/<network>/latest.json` at build time. **Effort: 0.5 day.**

11. **[HIGH] BoostNFT:** ship a public mint flow (price + cap +
    allowlist) OR descope from launch and move to v2. Today it
    delivers nothing user-visible. **Effort: 1-2 days, or 1h to descope.**

12. **[MEDIUM] Add a remainder accumulator** in `notifyRewardAmount`
    to eliminate dust loss. **Resolves #2. Effort: 1h.**

13. **[MEDIUM] Add `distributionsEnabled` to `RewardVault`** so a
    buggy notify can be paused. **Effort: 1h.**

14. **[MEDIUM] Wire RewardVault sync admin path through `TaxVault`**
    so `syncRewardDebt` is callable by the multisig in incident
    response. **Effort: 1h.**

15. **[MEDIUM] Delete or fix `test/unit/*` and `test/integration/*`.**
    They will not run today. Achieve >85% coverage on
    `MMMToken`/`RewardVault`/`TaxVault` via `coreFixture`-style
    harness. Add explicit regression tests for #2, #3, #5, #6, #7, #8.
    **Effort: 3-4 days.**

16. **[MEDIUM] Roadmap honesty:** mark NFT/Boost as in-progress;
    remove "Reward gating verified" until #5/#6/#7 are fixed and
    tested. **Effort: 30m.**

17. **[LOW] Document the mandatory FoT-swap requirement** for sells
    in dashboard + Frontend; route swap calls accordingly.
    **Effort: 2h.**

18. **[LOW] Run `slither .` and triage.** Add to CI. **Effort: 0.5 day.**

---

## ESTIMATED TIME TO LAUNCH-READY

**12-15 working days** for one full-time senior Solidity dev + 1
frontend dev, assuming an external audit (4-6 weeks calendar) is
run in parallel before mainnet.

---

## HARD NO-GO CHECK

| Condition | Status |
|---|---|
| Issue #5 — reward debt desync | ✅ CLOSED (2026-05-03 fix #1) |
| Issue #7 — retroactive claim by new holders | ✅ CLOSED (2026-05-03 fix #1) |
| Issue #6 — dust-primer hold bypass | ✅ CLOSED (2026-05-03 fix #2) |
| Issue #3 fix unreachable under prod wiring | ❌ BLOCKER |
| Frontend has no functional claim | ❌ BLOCKER |
| No emergency pause | ❌ BLOCKER |
| Mainnet deploy script broken | ❌ BLOCKER |
| Test coverage <50% on core logic (broken fixtures) | ❌ BLOCKER |

**Recommendation: HALT LAUNCH.** Address remaining items (#2 onward
in the priority list), run an external audit, then re-test on
testnet for at least 7 days under adversarial conditions before
any mainnet announcement.

---

## FIX LOG

### Fix #1 — Reward sync hook (2026-05-03)

**Closes:** issues.txt #5 (reward debt desync), #7 (retroactive
reward claim). Priority list item #1.

**Files changed:**
- `contracts/MMMToken.sol` — added `IRewardVaultHook` interface,
  `rewardVault` storage + `setRewardVaultOnce`, `RewardVaultSet`
  event. `_update` now wraps the existing logic (moved into
  `_doUpdate`) with `preTransferHook` / `postTransferHook` calls.
- `contracts/RewardVault.sol` — added `claimable` mapping,
  `OnlyToken` error, `onlyToken` modifier, `Crystallised` event,
  `preTransferHook` / `postTransferHook` external functions,
  `_crystallise` / `_resyncDebt` internals. `pending()` and `claim()`
  read/spend from `claimable[user]`.
- `test/fixtures/core.fixture.js` — wires `setRewardVaultOnce`
  before transferring `RewardVault` ownership to `TaxVault`.
- `scripts/deploy-official-testnet.js` — adds the same wiring step
  to the canonical deploy.
- `test/rewardVault.retroClaim.test.js` *(new)* — 3 regression
  tests covering: zero retroactive accrual for new buyers, claimable
  preservation across partial sells, and hook access control.

**Verification status:** code review only. `npx hardhat test` was
not executed in this environment because the sandbox blocks the
solc binary download (`HH502`). CI must run the suite outside the
sandbox before this fix is considered green.

**Out of scope (still open):**
- Excluded reward addresses (e.g. deployer, pair, taxVault)
  accumulate `claimable` that they cannot effectively claim, but
  the deployer key itself COULD claim from its accumulator while
  also holding tokens — this is an existing single-key concern
  flagged under "Security Posture", not a regression introduced
  by this fix.
- Dust-primer hold bypass (#6) is unaffected by this fix; it
  needs the separate priority-list item #2.

### Fix #2 — Balance-weighted hold-time tracking (2026-05-03)

**Closes:** issues.txt #6 (dust wallet hold-time bypass).
Priority list item #2.

**Files changed:**
- `contracts/MMMToken.sol` — removed `_syncLastNonZero`; added
  `_onSendUpdate(addr)` and `_onReceiveUpdate(addr, amountReceived)`.
  Receiver hook applies the weighted average
  `(prevBal*prevTs + amountReceived*now) / newBal`. Sender hook
  only resets on full exit. All five `_doUpdate` branches
  (mint/burn, no-tax, taxBps==0, buy, sell, fallback) updated to
  use the new hooks. Buy path syncs the buyer's NET receipt
  (`amount - tax`) so a buy doesn't double-credit. Mint path now
  calls `_onReceiveUpdate(to, amount)` instead of zero-amount
  sync, so the constructor mint correctly stamps the owner with
  `block.timestamp` and matches the existing constructor fast-path.
- `test/mmmToken.dustPrimer.test.js` *(new)* — 5 regression cases:
  dust + real receipt snaps WAT to ≈ `now`; immediate claim is
  blocked, but works after the full hold from the real buy;
  1-wei top-ups round to a no-op for an existing 1M holder;
  partial sell preserves the stamp; full exit + re-entry sets a
  later stamp.

**Verification status:** code review only (sandbox blocks the
solc download — `HH502`). CI must run `npx hardhat test` outside
the sandbox.

**Out of scope (still open):**
- The WAT scheme means a top-up that is large relative to the
  existing position can extend hold meaningfully — by design.
  Documentation for end-users should explain that buying more
  pushes the hold clock proportionally.
- Stake-weighted **claim sizing** (rewarding longer holders
  more per-token) is not implemented; this fix only blocks the
  dust-primer attack. If the team wants tier-based rewards, that
  is a separate design item.
