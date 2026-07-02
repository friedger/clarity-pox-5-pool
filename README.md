# clarity-pox-5-pool

A **signer-agnostic sBTC liquid-staking pool** built on top of [pox-5][pox5] (the
WIP next-generation Stacks Proof-of-Transfer boot contract).

Users deposit **sBTC** (plus the STX collateral a pox-5 bond requires) and receive a
single global **SIP-010 liquid token** (`pool-sbtc`). Each user picks **which signer**
they delegate to; the pool routes their funds to the per-signer vault bound to that
signer, so the pool is **signer-agnostic**. Signers opt into a discovery registry.

## How pox-5 shapes the design

pox-5 is not pox-4-style delegation. A staker locks **STX + sBTC together**, rewards
are paid in **sBTC**, and a "signer" is a *contract* implementing
`signer-manager-trait`. Three facts forced the architecture:

1. **Endowment allowlist** – only principals the bond admin allowlists in `setup-bond`
   may `register-for-bond`. Users can't be allowlisted at scale, so positions are held
   by **pool-controlled principals** (custodial).
2. **One position per principal** – `protocol-bond-memberships` is keyed by principal,
   so one principal can stake under only one signer. Clarity can't deploy contracts
   dynamically, so multiple signers need **pre-deployed per-signer vaults**.
3. **One-shot registration** – there is no "increase a bond" call and
   `register-for-bond` must run once, before the bond starts. So deposits accumulate in
   an **open window** and are registered as a **cohort**, then locked for the term.

```
pool            router + global SIP-010 liquid token + signer registry + accounting
 ├─ vault-1     holds one signer's pox-5 bond position (allowlisted by the endowment)
 └─ vault-2     holds another signer's position
```

## Contracts

| contract | role |
| --- | --- |
| `pox-5.clar` | vendored pox-5 boot contract (see shim note below) |
| `signer-manager.clar` | copy of the reference signer manager — "the signer(s) you run" |
| `vault-trait.clar` | interface the router uses to drive a vault |
| `vault-1.clar`, `vault-2.clar` | pre-deployed per-signer custodial vaults |
| `pool.clar` | the router + liquid token + signer registry (**main deliverable**) |

External mainnet contracts are pulled via Clarinet `requirements` (sBTC token /
registry / withdrawal, and the SIP-010 trait) — no mocks, no ref-rewriting.

## Lifecycle

1. **Run a signer** – deploy a `signer-manager`, then register it on pox-5 with
   `register-self(signer-manager, signer-key, auth-id, signer-sig)` (the signature is a
   secp256k1 signature over `pox-5.get-signer-grant-message-hash`).
2. **List** (optional) – the signer calls `pool.list-signer` to appear in the registry.
3. **Bind** – the operator calls `pool.assign-vault(signer, vault)` and the vault's
   `set-pool(pool)`.
4. **Deposit** – `pool.deposit(signer-manager, vault, sbtc, ustx)` moves the user's
   sBTC+STX into the vault and mints `pool-sbtc` at the current redemption rate.
5. **Register cohort** – `pool.register-cohort(vault, bond-index, signer-manager, …)`
   stakes the aggregated cohort into pox-5 (vault must be allowlisted for the bond).
6. **Rewards** – sBTC rewards delivered to a vault are folded into the redemption rate
   with `pool.fold-rewards(vault, amount)`.
7. **Exit** – `pool.unstake-cohort(...)` unwinds sBTC back to the vault, then
   `pool.withdraw(vault, shares)` burns the liquid token and returns the proportional
   sBTC plus the depositor's STX.

## Run it

```bash
npm install
clarinet check          # type-check all contracts
npm test                # run the vitest suite (tests/pool.test.ts)
```

Requires **Clarinet ≥ 3.19**. All contracts target **Clarity 5 / epoch 3.4** (pox-5
needs `as-contract?`; the vaults use it with `with-ft` / `with-stx` post-conditions).

## Fuzzing (Rendezvous / `rv`)

`pool.clar` carries Rendezvous invariants and properties, annotated `#[env(simnet)]`
so they are **stripped from on-chain deployments**:

- `invariant-solvency` — sBTC backing the liquid token never exceeds the sBTC
  actually reachable across the vaults.
- `invariant-supply-assets-coupled` — supply is zero exactly when backing is zero.
- `test-sbtc-roundtrip-no-gain` / `test-shares-roundtrip-no-gain` — the share math
  never lets value/shares be created by rounding.

Run it:

```bash
npm run rv:test         # fuzz the test-* properties
npm run rv:invariant    # random call sequences, checking invariant-* after each
npm test                # vitest: lifecycle tests also assert the invariants over deep state
```

**Bootstrapped harness (`tests/rv/`).** A plain `rv` run starts from an empty pool, so
the fuzzer bounces off the `assign-vault` / signer-registration gates and never reaches
`supply > 0`. To start *bootstrapped*, the harness uses a **custom Clarinet manifest**
(`tests/rv/Clarinet.toml`) that adds one harness-only contract, `rv-bootstrap.clar`,
whose top-level body runs at publish and calls the `#[env(simnet)]` `pool.rv-wire` —
binding the vaults to the signers and pointing them at the pool. With that, the campaign
actually deposits, folds rewards, and withdraws. The harness is isolated in its own
directory (own manifest + deployment plan) so it never affects `npm test` or
`clarinet check`. `tests/rv/run.mjs` drives it (the `rv` bin has a flaky
`epoch field invalid` crash on epoch-3.4 plans; invoking Rendezvous' `main()` via import,
after clearing the stale plan, avoids it).

**rv patch.** Rendezvous' `extractProjectTraitImplementations` calls `getContractAST` on
every deployed contract, and clarinet's wasm throws for the mainnet sBTC **requirement**
contracts (their AST isn't retained in the simnet), crashing the run. A one-line guard
(skip contracts whose AST can't load — a requirement contract can't implement a
project-local trait anyway) is shipped as `patches/@stacks+rendezvous+1.0.0.patch` and
auto-applied via the `postinstall` (`patch-package`) hook.

**Bugs this caught:**
- `fold-rewards` on an empty pool (`supply == 0`) created backing with no shares,
  stranding the sBTC. Fixed by requiring `supply > 0`.
- Once *bootstrapped* (deep state), the campaign found `fold-rewards` broke
  `invariant-solvency`: it raised `total-sbtc` while only *trusting* the operator had
  delivered the reward sBTC. Fixed by making `fold-rewards` **pull** the sBTC into the
  vault atomically, so backing is always real.

## v1 scope & caveats

- **One vault (signer) per user** until a full exit; switching signers mid-position is
  deferred (pox-5 supports it via `update-bond-registration`).
- The liquid token prices **sBTC only**; STX is a separate per-depositor ledger,
  returned pro-rata on withdraw. Transferring the liquid token does **not** move the STX
  ledger entry.
- `fold-rewards` is operator-driven (rewards claimed out-of-band via the signer
  manager's permissionless claim path); fully trustless on-chain collection is deferred.
- **Testing**: the vendored pox-5 is a regular contract, not the node's boot pox
  contract, so node-side **STX locking** and **real reward distribution** don't fire in
  simnet. Tests assert pox-5 bookkeeping + the liquid token + sBTC transfers. The **L1
  BTC-lockup proof path is not exercised**; deposits use pox-5's sBTC (L2) leg.
- **pox-5 shim**: released clarity-vm/clarinet lacks two WIP natives
  (`get-bitcoin-tx-output?`, `verify-merkle-proof`) used only by pox-5's L1 lockup path.
  `contracts/pox-5.clar` stubs them (clearly marked) so it compiles for local testing.
  These **must be restored** before using pox-5 for anything touching the L1 path.

## Testnet deployment (private Hiro node, `api.private-1.hiro.so`)

This network runs the **canonical** boot pox-5 at
`ST000000000000000000002AMW42H.pox-5` (verified: per-staker reward model — the
`signer-manager-trait` is just `validate-stake!`, and `unstake-sbtc` returns
`amount-withdrawn-sats`) and the sBTC suite at
`SN3R84XZYA63QS28932XQF3G1J8R9PC3W76P9CSQS.sbtc-*`. The pool, vaults, and
signer-managers reference those addresses **directly** (the deployer-relative
`.pox-5` is gone), so the local `pox-5.clar` vendoring is no longer used for
testnet — only the simnet test harness still relies on it.

All six contracts are **Clarity 6 / epoch 4.0**, matching the node
(`stacks-node 4.0.0.0.0`).

### remote_data + the SIP-010 requirement

The boot pox-5 and the sBTC suite can't be pulled via `[[project.requirements]]`
(requirements fetch from **mainnet** only, and Clarinet's default testnet sBTC
remap target `ST1F7QA2...` doesn't exist on this node), so the manifest resolves
them with

```toml
[repl.remote_data]
enabled = true
api_url = "https://api.private-1.hiro.so"
```

so `clarinet console`, the test session, and **single-file** `clarinet check
contracts/<x>.clar` resolve against the **live** boot bytecode.

The **SIP-010 trait** that `pool.clar` implements is a `[[project.requirements]]`
(`SP3FBR2…sip-010-trait-ft-standard`, fetched from mainnet). `pool.clar`
references that mainnet principal, so single-file check / simnet resolve it at
the requirement's principal. The node has no SIP-010 trait, so at deploy time
`scripts/deploy.mjs` republishes the trait **under the deployer** and remaps the
mainnet principal to the deployer in `pool.clar` — exactly what `clarinet
deployments apply` does (we can't use Clarinet here; see the chain-id note).

The deploy therefore publishes the SIP-010 trait (republished under the deployer)
followed by the 6 local contracts — and never pox-5 or any sBTC contract:

```
sip-010-trait-ft-standard, signer-manager-1, signer-manager-2,
vault-trait, vault-1, vault-2, pool
```

> **`clarinet check` (whole-project) caveat.** The batch project check does
> **not** apply `[repl.remote_data]` for cross-contract type resolution — it
> falls back to Clarinet's *bundled* boot pox-5, whose `unstake-sbtc` returns a
> 3-field tuple (no `amount-withdrawn-sats`) and which knows nothing of the
> `SN3R84...sbtc-token` principal. So the whole-project check reports false
> positives (`cannot find field 'amount-withdrawn-sats'`, `unresolved contract
> SN3R84...sbtc-token`) plus the same benign `get-earned-staker-rewards`
> read-only warning fastpool-pox-5 sees. To type-check against the **live** node,
> check each contract individually — all pass:
> ```sh
> for c in vault-trait vault signer-manager pool; do
>   clarinet check contracts/$c.clar
> done
> ```
> `clarinet deployments generate --testnet` and `apply` use the real node and are
> unaffected.

> **Chain id 256 — do NOT use `clarinet deployments apply`.** This node runs a
> custom Stacks chain id (256); Clarinet hard-codes the testnet chain id
> (2147483648) with no override, so its txs are rejected
> (`SignatureValidation: invalid chain ID`). Deployment goes through
> `@stacks/transactions` (`scripts/deploy.mjs`), which signs with `chainId: 256`.
> Bootstrap calls (register-self, assign-vault, deposit, …) must likewise be
> signed with `chainId: 256`, and `register-self`'s SIP-018 grant signature must
> use `chain-id: 256` in its domain (see step (a)).

### Daily run (the node resets ~daily — re-run all of this)

Everything is signed with `@stacks/transactions` at **chain id 256** (Clarinet
can't). Keys come from the `settings/Testnet.toml` mnemonic, by account index:

| acct | role |
| --- | --- |
| 0 | operator / each signer-manager admin / vault deployer (`set-pool`) |
| 1, 2 | the pox **signer** keys for `signer-manager-1`, `signer-manager-2` |
| 3, 4 | **depositors** routed to `vault-1`, `vault-2` |

**One-time prerequisites** (not part of the daily loop):
- Put the deployer mnemonic in `settings/Testnet.toml` (gitignored).
- The pox-5 **bond admin** must `setup-bond` with `<deployer>.vault-1` and
  `<deployer>.vault-2` in its allowlist — required for `register-cohort` (the
  deployer is *not* the bond admin; ask the endowment). Re-do if a reset clears it.

**Each day**, after the reset wipes contracts and balances:

```sh
cd clarity-pox-5-pool

# 1 — deploy: faucet-funds the operator, then publishes the SIP-010 trait
#     requirement + the 6 contracts (chain 256, dependency order, idempotent)
./scripts/deploy-testnet.sh

# 2 — register both signers on pox-5, bind both vaults to the pool
node scripts/bootstrap.mjs register     # register-self for signer-manager-1 & -2
node scripts/bootstrap.mjs bind         # assign-vault + vault.set-pool (both pairs)
node scripts/bootstrap.mjs list         # optional: list-signer in the registry

# 3 — fund the depositors (accts 3 & 4): sBTC (0.05/call) + STX (fees + collateral)
SM=1 node scripts/bootstrap.mjs fund-sbtc      # sBTC -> depositor acct 3 (vault-1)
SM=2 node scripts/bootstrap.mjs fund-sbtc      # sBTC -> depositor acct 4 (vault-2)
#     STX for each depositor (address is printed by fund-sbtc):
curl -X POST "https://api.private-1.hiro.so/extended/v1/faucets/stx?address=<depositor>"

# 4 — per signer/vault (SM=1 or 2): deposit, then register the cohort
#     (register-cohort needs the allowlisted bond from the prerequisite above)
SM=1 SBTC_SATS=1000000 USTX=<collateral> node scripts/bootstrap.mjs deposit
SM=1 BOND_INDEX=<n>                      node scripts/bootstrap.mjs register-cohort

# 5 — claim & distribute rewards (sBTC), once the bond has paid a cycle:
SM=1 REWARD_CYCLE=<cycle> node scripts/bootstrap.mjs claim-rewards         # signer pulls its sBTC
SM=1 REWARD_CYCLE=<cycle> node scripts/bootstrap.mjs claim-staker-rewards  # pay the vault its share
SM=1 AMOUNT_SATS=<sats>   node scripts/bootstrap.mjs fold-rewards          # record sBTC into redemption rate

# 6 — exit: unwind the bond's sBTC, then depositors redeem:
SM=1 AMOUNT_SATS=<sats> node scripts/bootstrap.mjs unstake-cohort
SM=1 SHARES=<shares>    node scripts/bootstrap.mjs withdraw               # signed by the depositor (acct 3/4)
```

`register`/`bind`/`list` cover **both** pairs in one run; everything else acts on
the pair selected by `SM=1|2`. The faucets are **per-IP rate-limited** — if
`fund-sbtc` or the STX faucet returns "Too many requests", space the calls out or
run them from a different IP. The per-call signatures are in (a)–(e) below.

Reference — the calls each bootstrap command makes (`<...>` args are contract
principals):

   **(a) Register each signer with pox-5** — as the signer-manager admin:
   ```
   signer-manager.register-self(
       signer-manager: <signer-manager-trait>,   ;; the signer-manager itself
       signer-key:     (buff 33),                 ;; the pox signer's 33-byte compressed pubkey
       auth-id:        uint,                       ;; unique per grant; bump on re-register
       signer-sig:     (buff 65))                  ;; SIP-018 grant-authorization signature
   ```
   `signer-sig` is a **SIP-018** signature produced by the *signer* key (not the
   deployer) over
   `domain  = { name: "pox-5-signer", version: "1.0.0", chain-id }` and
   `message = { topic: "grant-authorization", signer-manager, auth-id }` — the
   same scheme as `fastpool-pox-5/scripts/bootstrap.mjs` (`signStructuredData`).

   **(b) Bind each vault to its signer** — operator calls `assign-vault`, and the
   vault deployer wires the vault back to the pool with `set-pool`:
   ```
   pool.assign-vault(signer: principal, vault: <vault-trait>)
   vault.set-pool(router: principal)              ;; router == the pool contract principal
   ```

   **(c) Deposit** sBTC (+ STX collateral), routing to the chosen signer's vault:
   ```
   pool.deposit(
       sm:    <signer-manager-trait>,
       vault: <vault-trait>,
       sbtc:  uint,                                ;; sats
       ustx:  uint)                                ;; microSTX collateral
   ```

   **(d) Register the cohort** into pox-5 once the window is full (before the bond
   starts; the vault must be allowlisted in the bond's endowment):
   ```
   pool.register-cohort(
       vault:          <vault-trait>,
       bond-index:     uint,
       sm:             <signer-manager-trait>,
       signer-calldata:(optional (buff 500)))      ;; none, or a {pox-addr,max-fee} consensus buff
   ```

   **(e) Exit** at term — unwind the cohort's sBTC back into the vault, then burn
   liquid tokens to redeem:
   ```
   pool.unstake-cohort(
       vault:  <vault-trait>,
       sm:     <signer-manager-trait>,
       amount: uint)                               ;; sats to unwind
   pool.withdraw(
       vault:  <vault-trait>,
       shares: uint)                               ;; pool-sbtc shares to burn
   ```

4. Rewards (between deposit and exit): after the node pays sBTC for a cycle,
   crystallize/claim via `signer-manager.claim-rewards(bond-periods, reward-cycle)`
   and `signer-manager.claim-staker-rewards(staker, reward-cycle, bond-index)`,
   then fold the delivered sBTC into the redemption rate with
   `pool.fold-rewards(vault, amount)`.

[pox5]: https://github.com/stacks-network/stacks-core/blob/pox-wf-integration/stackslib/src/chainstate/stacks/boot/pox-5.clar
