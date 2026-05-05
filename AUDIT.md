# MMM TOKEN — LAUNCH READINESS AUDIT REPORT

**Date:** 2026-05-09 (refreshed; original 2026-05-03)
**Auditor role:** Senior Solidity Security Engineer + Full-Stack Web3 Auditor
**Branch:** `main` (post-PR #7 + PR #8)
**Scope:** `contracts/`, `test/`, `scripts/`, `Frontend/`, `dashboard/`, `roadmap/`, `deployments/`

> **Note on tooling:** `npx hardhat compile` is blocked in the audit sandbox
> (solc binary download denied by host allowlist). All findings below come
> from static review of source + behavioral reasoning, not from a fresh test
> run. CI must reproduce these tests outside the sandbox before launch.

---

## OVERALL VERDICT: 🟡 CLOSE BUT NOT LAUNCH-READY

Economic exploits #2, #4, #5, #6, #7 and #8 (cap) are closed.
Emergency pause + guardian role and `Ownable2Step` on
owner-bearing contracts are now in place; tax bracket has a hard
`MAX_TAX_BPS` cap; `RewardVault` has a `distributionsEnabled` kill
switch; constructors reject EOA addresses for token references.
Test suite migrated onto `coreFixture`; broken `protocol.fixture.js`
removed.

**Still open / not in this branch:** owner-action timelock (24-48h
delay on `setTaxExempt`/`setPair`/`setRouter`), liquidity lock at
deploy time, frontend `claim` button real wiring, public BoostNFT
mint flow, an external audit pass. The deploy script for mainnet
still needs a parameterized run + verify step.

**Blocker count: 2 critical (operational) · 4 high · 4 medium · 4 low**
(was 7 critical — 5 closed by the 2026-05-03→2026-05-09 fix series)

---

## SECTION 1 — SMART CONTRACTS

Solidity `^0.8.24` ✅ (overflow-safe). Optimizer 200 runs ✅.
OpenZeppelin v5 ✅. `MMMToken` and `TaxVault` use `Ownable2Step`
(2026-05-09); `RewardVault` keeps plain `Ownable` because its
ownership is intentionally transferred once to `TaxVault`.
`ReentrancyGuard` used in vaults ✅. `Pausable` on `MMMToken` ✅
(2026-05-09).

### Known issues — verification

| # | Issue | Status | Evidence |
|---|---|---|---|
| 1 | Token inflation via double `_update` | ✅ **FIXED** | `MMMToken._update` paths conserve supply: Buy: pair→buyer (full) then buyer→taxVault (tax). Sell: from→taxVault (tax) then from→pair (amount-tax). |
| 2 | Integer division loss in `notifyRewardAmount` | ✅ **FIXED** (2026-05-04) | `RewardVault.notifyRemainder` carries `(amount * ACC_SCALE + prev) % denom` forward into the next notify. See Fix Log #3. |
| 3 | `syncRewardDebt` unprotected | 🟡 **PARTIAL** | `onlyOwner` enforced. Under production wiring ownership is on `TaxVault`, so the function is reachable only via a multisig action through `TaxVault` (or by an explicit ownership re-transfer). Mitigated by the new `preTransferHook`/`postTransferHook` keeping debt automatically in sync — manual `syncRewardDebt` is incident-response only. |
| 4 | Constructor missing contract validation | ✅ **FIXED** (2026-05-09) | `RewardVault` and `TaxVault` constructors now reject token references whose `code.length == 0`. Reverts with `NotAContract(address)`. |
| 5 | Reward debt desynchronization | ✅ **FIXED** (2026-05-03) | `MMMToken._update` brackets the transfer with `RewardVault.preTransferHook` / `postTransferHook`. `pre` crystallises pending into a `claimable` accumulator using OLD balance; `post` resyncs `rewardDebt` to NEW balance. See Fix Log #1. |
| 6 | Dust wallet hold-time bypass | ✅ **FIXED** (2026-05-03) | `_syncLastNonZero` removed; receivers go through balance-weighted timestamp `(prevBal*prevTs + amount*now) / newBal`. A 1-wei primer followed by 1M MMM snaps the clock to ≈ `now`. See Fix Log #2. |
| 7 | Retroactive reward claim by new holders | ✅ **FIXED** (2026-05-03) | Same fix as #5: a fresh receiver's `rewardDebt` is set to `newBalance * accRewardPerToken` in `postTransferHook`, so `pending()` returns 0 immediately after the buy. |
| 8 | O(n) gas DoS in `eligibleSupply` | 🟡 **MITIGATED** (2026-05-09) | `RewardVault.MAX_EXCLUDED = 32` caps the array. `addExcludedRewardAddress` reverts with `TooManyExcluded` on overflow. Per-notify gas now bounded. Removal helper still not implemented (append-only). See Fix Log #5. |
| 9 | Double `_update` calls / double `Transfer` events | ❌ **OPEN** (medium, by design) | Two events per taxed transfer. Required for the buy-side fix. Must be documented for indexers. |
| 10 | Hardcoded router exclusion | ✅ **FIXED** | `MMMToken._update` keys tax purely off `from == pair` / `to == pair`. Router not consulted. |
| 11 | No emergency pause / kill switch | ✅ **FIXED** (2026-05-09) | `MMMToken` is now `Pausable`. Owner OR `guardian` can `pause()`; only owner can `unpause()`. Mint/burn paths still allowed while paused so admin can rescue funds. `RewardVault.distributionsEnabled` adds an emissions kill switch that doesn't freeze already-earned `claimable`. See Fix Log #4. |
| 12 | No tax-rate cap | ✅ **CAPPED** (2026-05-09) | `MMMToken.MAX_TAX_BPS = 8000` is a constant ceiling. The current launch schedule sits at the cap during minute 0-10 (buy) and 0-20 (sell) — see "Tax peaks at 80%" below. |
| 13 | Single-step ownership | ✅ **FIXED** (2026-05-09) | `MMMToken` and `TaxVault` are `Ownable2Step`. Transfers stage a `pendingOwner`; receiver must `acceptOwnership`. `RewardVault` stays plain `Ownable` (one-time transfer to `TaxVault` contract — no typo risk). |
| 14 | No owner-action timelock | ❌ **OPEN** (critical, ops) | `setTaxExempt`/`setPair`/`setRouter` are still immediate `onlyOwner`. Mainnet plan: wrap the `MMMToken` and `TaxVault` owner in a 24-48h `TimelockController` + multisig BEFORE launch. Code change required only if we want on-chain enforcement; otherwise pure ops. |

### Critical sell-path UX trap (not in issues.txt)

`super._update(from, to, amount - tax)` on a sell sends only `amount - tax`
to the pair. Standard `swapExactTokensForTokens` will revert because the
pair's K invariant breaks. Users **must** call
`swapExactTokensForTokensSupportingFeeOnTransferTokens`. This is undocumented
in Frontend, dashboard, or any user-facing surface. **(Still open — doc
fix only, no contract change.)**

### Additional contract findings

- ✅ **[CRITICAL — FIXED 2026-05-09] Emergency pause / kill switch.**
  `MMMToken` is now `Pausable`. Owner or `guardian` can `pause()`;
  only owner can `unpause()`. Mint/burn paths still flow while
  paused so funds can be rescued. `RewardVault.distributionsEnabled`
  adds an emissions kill switch that does not freeze already-earned
  `claimable`. **Still pending:** delegate `guardian` to a 2-of-N
  Safe at deploy time.
- 🟡 **[CRITICAL — PARTIAL 2026-05-09] Tax cap + Ownable2Step.**
  Hard cap `MAX_TAX_BPS = 8000` on `MMMToken`. `MMMToken` and
  `TaxVault` are `Ownable2Step` — transfers stage a `pendingOwner`;
  receiver must `acceptOwnership`. **Still pending:** wrap owner
  in a 24-48h `TimelockController`. Single-key risk on
  `setTaxExempt`/`setPair`/`setRouter` remains until the timelock
  is in place.
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

3. ✅ **DONE (2026-05-09) — `Pausable` on `MMMToken` with guardian
   role.** Owner OR guardian can `pause()`; unpause is owner-only.
   Mint/burn paths bypass the pause so admin can still rescue funds.
   See Fix Log #4. **Operational follow-up:** delegate `guardian`
   to a 2-of-N Safe at deploy time.

4. 🟡 **PARTIAL (2026-05-09) — Lock down owner powers.**
   `MAX_TAX_BPS = 8000` constant cap on `MMMToken`.
   `Ownable2Step` on `MMMToken` and `TaxVault`. **Operational
   follow-up still required for launch:** wrap owner in 2-of-N Safe,
   place `setTaxExempt`/`setPair`/`setRouter` behind a 24-48h
   `TimelockController`. **Effort remaining: 0.5 day code +
   1 day ops** (deploy + transfer ownership to timelock+safe).

5. **[CRITICAL] Lock LP** via Unicrypt or Team.Finance, ≥6 month
   lock, before any public launch. **Effort: 1h ops.**

6. **[CRITICAL] Fix or delete `scripts/deploy-v1-locked-main.js`.**
   Standardize on `deploy-official-testnet.js` parameterized for
   mainnet. Add post-deploy assertion script + Etherscan verify.
   **Effort: 1 day.**

7. **[CRITICAL] Replace `Frontend/app.js` claim handler** with a
   real `RewardVault.claim()` call; show real `pending(user)` in
   the "Total Claimable" tile. **Effort: 0.5 day.**

8. 🟡 **PARTIAL (2026-05-09) — Bound `eligibleSupply` gas.**
   `MAX_EXCLUDED = 32` cap added; `addExcludedRewardAddress` reverts
   `TooManyExcluded` on overflow. Per-notify gas now bounded by 32
   `balanceOf` calls. **Still open:** running `excludedSupplySum`
   maintained on `_update` would make this O(1); plus
   `removeExcludedRewardAddress` for governance flexibility.
   **Effort remaining: 0.25 day.**

9. ✅ **DONE (2026-05-09) — `addr.code.length > 0` checks** in
   `TaxVault` and `RewardVault` constructors. **Resolves #4.**

10. **[HIGH] Single source of truth for addresses.** Generate
    `Frontend/config.js` and `dashboard/App.js` constants from
    `deployments/<network>/latest.json` at build time. **Effort: 0.5 day.**

11. **[HIGH] BoostNFT:** ship a public mint flow (price + cap +
    allowlist) OR descope from launch and move to v2. Today it
    delivers nothing user-visible. **Effort: 1-2 days, or 1h to descope.**

12. ✅ **DONE (2026-05-04) — Remainder accumulator** in
    `notifyRewardAmount` (`RewardVault.notifyRemainder`).
    **Resolves #2.**

13. ✅ **DONE (2026-05-09) — `distributionsEnabled` on
    `RewardVault`.** Toggle-able by owner; reverts notify with
    `DistributionsDisabled`. Existing `claimable` balances stay
    claimable while disabled — kill switch for emissions, not user
    funds.

14. **[MEDIUM] Wire RewardVault sync admin path through `TaxVault`**
    so `syncRewardDebt` is callable by the multisig in incident
    response. **Effort: 1h.** (Lower priority now that
    `pre/postTransferHook` keeps debt automatically synced — manual
    sync is purely incident-response.)

15. ✅ **DONE (2026-05-04 → 2026-05-09) — `test/unit/*` and
    `test/integration/*` migrated** onto `coreFixture`. Broken
    `protocol.fixture.js` removed. `test/security.*.test.js` adds
    explicit regression coverage for #5, #6, #7, plus the new
    pause/guardian/Ownable2Step/distributions/code-length features.
    **Coverage measurement still pending — add `solidity-coverage`
    to `hardhat.config.js` and verify >85% on
    `MMMToken`/`RewardVault`/`TaxVault`.**

16. **[MEDIUM] Roadmap honesty:** mark NFT/Boost as in-progress;
    remove "Reward gating verified" until #5/#6/#7 are fixed and
    tested. **Effort: 30m.**

17. **[LOW] Document the mandatory FoT-swap requirement** for sells
    in dashboard + Frontend; route swap calls accordingly.
    **Effort: 2h.**

18. **[LOW] Run `slither .` and triage.** Add to CI. **Effort: 0.5 day.**

19. **[HIGH] External audit prep document.** Single-file write-up
    that an external reviewer can pick up cold: protocol overview,
    invariants (supply conservation through `_update`, no-retroactive
    via `pre/postTransferHook`, hold-time weighted update,
    `eligibleSupply` ≤ totalSupply, `claimable[user]` only grows
    via `_crystallise`, only drains via `claim`), trust model
    (owner / guardian / TaxVault), known accepted trade-offs (FoT
    swap requirement, double `Transfer` events on taxed paths,
    append-only `excludedRewardAddresses` capped at 32). Should
    cite contract paths and line ranges. **Effort: 0.5 day.**

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
| Issue #2 — notify integer-division dust | ✅ CLOSED (2026-05-04 fix #3) |
| Issue #4 — constructor contract validation | ✅ CLOSED (2026-05-09 fix #5) |
| Issue #8 — eligibleSupply gas | 🟡 MITIGATED (2026-05-09 fix #5) |
| No emergency pause | ✅ CLOSED (2026-05-09 fix #4) |
| Tax-rate cap + Ownable2Step | ✅ CLOSED (2026-05-09 fix #4) |
| Owner-action timelock (24-48h) | ❌ OPEN — operational |
| Liquidity lock at deploy | ❌ OPEN — operational |
| Mainnet deploy script + verify step | ❌ OPEN — operational |
| Frontend has no functional claim | ❌ OPEN — out of contract scope |
| External security audit | ❌ OPEN — schedule before launch |
| `npx hardhat test` green on CI | ❓ UNVERIFIED — sandbox cannot run solc |

**Recommendation:** the protocol code is now substantially safer
than the 2026-05-03 baseline. **Remaining launch blockers are
operational** — timelock + multisig wrapping of owner powers, LP
lock, mainnet deploy script with post-deploy assertions and
Etherscan verification, and an external audit pass. Hold mainnet
until those are done, and run `npx hardhat test` locally on this
branch to confirm the new fixes pass before opening any deploy PR.

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

### Fix #3 — Notify integer-division dust accumulator (2026-05-04)

**Closes:** issues.txt #2 (Integer Division Loss in
`notifyRewardAmount`). Priority list item #12.

**Files changed:**
- `contracts/RewardVault.sol` — added `uint256 public notifyRemainder`.
  `notifyRewardAmount` now folds the previous remainder into the
  numerator: `numerator = amount * ACC_SCALE + notifyRemainder;
  accRewardPerToken += numerator / denom; notifyRemainder = numerator % denom;`.
  Per-notify dust no longer gets silently discarded — it rolls
  forward into the next distribution and eventually rounds up to a
  full unit increment of `accRewardPerToken`.
- `test/unit/RewardVault.test.js` — added the
  "carries the integer-division remainder forward" assertion.

**Closes also (same PR):** the `pending()` / `claim()` exclusion
hole (excluded addresses could compute pending against their own
balance and, in theory, claim). Both paths now early-return / revert
for `isExcludedFromRewards[user]`.

**Verification status:** code review only (sandbox blocks solc).

### Fix #4 — Pause + Ownable2Step + tax cap (2026-05-09)

**Closes:** AUDIT critical items "No emergency pause" and "No
tax-rate cap / single-step ownership". Priority list items #3, #4.

**Files changed:**
- `contracts/MMMToken.sol`:
  - Inherits `Ownable2Step` (was plain `Ownable`) and `Pausable`.
  - Adds `address public guardian` + `setGuardian(address)` (owner only).
  - Adds `pause()` callable by owner OR guardian; `unpause()` is
    owner only.
  - `_update` reverts with `EnforcedPause` while paused, except for
    mint/burn paths (`from == address(0)` or `to == address(0)`)
    so the admin can still rescue funds.
  - Adds `uint256 public constant MAX_TAX_BPS = 8000` as a hard
    code-level ceiling on any future tax setter.
- `contracts/TaxVault.sol`:
  - Inherits `Ownable2Step` (was plain `Ownable`).
  - Constructor now rejects EOA / non-contract token references with
    `NotAContract(address)`.
- `contracts/RewardVault.sol`:
  - Adds `bool public distributionsEnabled = true`,
    `setDistributionsEnabled(bool)` (owner only), and a
    `DistributionsDisabled` revert in `notifyRewardAmount`.
  - Adds `MAX_EXCLUDED = 32` cap on `excludedRewardAddresses`,
    revert `TooManyExcluded` on overflow.
  - Constructor rejects non-contract `_mmm` with `NotAContract`.
  - Completes the migration from `creditedRewards` /
    `syncOnTransfer` to `claimable[user]` / `preTransferHook` /
    `postTransferHook`. `claim()` now also explicitly settles
    `rewardDebt[user] = bal * acc` BEFORE the payout transfer, so
    the post-payout `preTransferHook` doesn't re-credit `claimable`
    (would otherwise be a one-shot double-spend).
  - `_crystallise` and `_resyncDebt` skip excluded addresses so
    `taxVault`/`pair`/`DEAD` don't accumulate dead `claimable`.
- `test/security.pauseAndGuardian.test.js` *(new)* — covers:
  non-owner non-guardian cannot pause; guardian can pause but not
  unpause; paused state reverts plain transfers; Ownable2Step
  staged transfer; `distributionsEnabled` toggle round-trip; and
  the `MAX_EXCLUDED` cap.
- `test/security.noRetroactive.test.js` — updated assertions to
  read from the new `claimable` mapping (was `creditedRewards`).
- `test/fixtures/core.fixture.js` — removed the duplicate
  `setRewardVaultOnce` call that would have reverted on the second
  invocation (`RewardVaultAlreadySet`).

**Verification status:** code review only (sandbox blocks solc
binary download). CI must run `npx hardhat test` locally on this
branch.

**Operational follow-ups (NOT in this PR):**
- Wrap `MMMToken` and `TaxVault` owner in a 2-of-N Safe at
  deployment.
- Place `setTaxExempt` / `setPair` / `setRouter` calls behind a
  24-48h `TimelockController`. Code change is optional (can be
  enforced purely operationally by transferring ownership to the
  timelock contract); on-chain enforcement would require a setter
  refactor.
- Delegate `MMMToken.guardian` to the same Safe (or a fast-response
  pager rota) so `pause()` is reachable in incident response.

### Fix #5 — Constructor contract checks + eligibleSupply gas cap (2026-05-09)

**Closes:** AUDIT issue #4 (constructor missing contract validation)
and partially issue #8 (O(n) gas in `eligibleSupply`). Priority
list items #8, #9.

**Files changed:**
- `contracts/RewardVault.sol`:
  - Constructor reverts with `NotAContract(_mmm)` if `_mmm.code.length == 0`.
  - `MAX_EXCLUDED = 32` constant; `addExcludedRewardAddress` reverts
    `TooManyExcluded` past the cap. Bounds per-notify
    `eligibleSupply` gas to 32 `balanceOf` calls.
- `contracts/TaxVault.sol`:
  - Constructor reverts with `NotAContract(addr)` if any of
    `mmmToken` / `usdcToken` / `wmonToken` is an EOA.

**Out of scope (still open):**
- Running `excludedSupplySum` maintained on `MMMToken._update`
  would make `eligibleSupply` O(1). Not implemented — the cap is
  enough to make per-notify gas predictable on mainnet.
- `removeExcludedRewardAddress` for governance flexibility (e.g.
  if a CEX delists). Append-only is acceptable for launch.
