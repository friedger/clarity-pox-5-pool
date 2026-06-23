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
| `signer-manager.clar`, `signer-manager-2.clar` | copies of the reference signer manager — "the signer(s) you run" |
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

[pox5]: https://github.com/stacks-network/stacks-core/blob/pox-wf-integration/stackslib/src/chainstate/stacks/boot/pox-5.clar
