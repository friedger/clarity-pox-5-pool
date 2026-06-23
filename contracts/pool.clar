;; pool
;;
;; A signer-agnostic sBTC liquid-staking pool on top of pox-5.
;;
;; Users deposit sBTC (+ the STX collateral a pox-5 bond requires) and receive a
;; single global SIP-010 liquid token (`pool-sbtc`) whose redemption rate rises as
;; sBTC rewards are folded in. Each user chooses which signer to delegate to; the
;; pool routes their funds into the per-signer vault bound to that signer, so the
;; pool is signer-agnostic. Signers opt into a discovery registry via `list-signer`.
;;
;; WHY VAULTS: pox-5 keys a bond position by principal and only allowlisted
;; principals (whitelisted by the endowment) may register, so the pool cannot let
;; each user be their own staker. Instead a fixed set of pre-deployed vault
;; contracts each hold one signer's position; the operator binds them with
;; `assign-vault`.
;;
;; COHORTS: pox-5 has no "increase a bond" call and registration is one-shot before
;; a bond starts, so deposits accumulate in a vault during an open window and are
;; registered once via `register-cohort`, then locked for the bond term.
;;
;; v1 SCOPE / LIMITATIONS:
;;   - Each user uses one vault (signer) at a time until they fully exit.
;;   - The liquid token prices sBTC only; STX is tracked as a separate per-user
;;     principal ledger and returned pro-rata to the depositor on withdraw.
;;   - Transferring the liquid token does NOT move the STX ledger entry, so STX is
;;     always returned to the original depositor (documented behaviour).
;;   - `fold-rewards` is operator-driven: it records sBTC rewards already delivered
;;     to a vault (claimed out-of-band via the signer-manager's permissionless
;;     claim functions). Fully trustless on-chain reward collection is deferred.

(impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(use-trait signer-manager-trait .pox-5.signer-manager-trait)
(use-trait vault-trait .vault-trait.vault-trait)

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant MAX_BIPS u10000)

(define-constant ERR_NOT_OPERATOR (err u3000))
(define-constant ERR_SIGNER_NOT_REGISTERED (err u3001))
(define-constant ERR_INVALID_FEE (err u3002))
(define-constant ERR_NOT_LISTER (err u3003))
(define-constant ERR_NOT_LISTED (err u3004))
(define-constant ERR_VAULT_NOT_ASSIGNED (err u3005))
(define-constant ERR_ZERO_AMOUNT (err u3006))
(define-constant ERR_DIFFERENT_VAULT (err u3007))
(define-constant ERR_VAULT_MISMATCH (err u3008))
(define-constant ERR_NO_PENDING (err u3009))
(define-constant ERR_VAULT_ALREADY_ASSIGNED (err u3010))
(define-constant ERR_INSUFFICIENT_SHARES (err u3011))
(define-constant ERR_NO_SHARES (err u3013))
(define-constant ERR_NOT_TOKEN_OWNER (err u3012))

;; ---------------------------------------------------------------------------
;; Liquid token (SIP-010)
;; ---------------------------------------------------------------------------
(define-fungible-token pool-sbtc)

(define-data-var token-uri (optional (string-utf8 256)) none)

;; ---------------------------------------------------------------------------
;; Pool state
;; ---------------------------------------------------------------------------

;; Total sBTC (sats) backing the liquid token: staked principal across all vaults
;; plus folded rewards. The redemption rate is `total-sbtc / total-supply`.
(define-data-var total-sbtc uint u0)

;; The operator (deployer) may bind vaults and drive cohort lifecycle ops.
(define-data-var operator principal tx-sender)

;; Opt-in signer registry (discovery only; deposits accept any assigned signer).
(define-map listed-signers
    principal
    {
        listed-by: principal,
        name: (string-utf8 64),
        fee-bips: uint,
        active: bool,
    }
)

;; vault principal -> its single signer-manager principal. Keyed by vault, so a
;; vault maps to exactly ONE signer (matching pox-5, which keys a bond position
;; by principal and asserts the signer on unstake) while a signer can own MANY
;; vaults (many vault-keys pointing to the same signer) for overlapping bond
;; periods. Enumerating a signer's vaults is done off-chain via assign-vault events.
(define-map vault-signer principal principal)

;; Per-user STX principal supplied (microSTX), returned pro-rata on withdraw.
(define-map stx-principal principal uint)

;; Per-user liquid-token shares minted to them at deposit time. Tracked
;; separately from ft balance so the STX ledger survives token transfers.
(define-map deposit-shares principal uint)

;; The vault (signer) a user is currently deposited into. One at a time in v1.
(define-map user-vault principal principal)

;; Pending (not-yet-registered) cohort amounts accumulating in each vault.
(define-map vault-pending
    principal
    {
        sbtc: uint,
        ustx: uint,
    }
)

;; ---------------------------------------------------------------------------
;; Internal helpers
;; ---------------------------------------------------------------------------

(define-private (is-operator) ;; TODO: gate on contract-caller (not tx-sender), and make operator a multisig?
    (ok (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR))
)

;; Shares minted for a given sBTC amount at the current exchange rate.
(define-read-only (shares-for-sbtc (sbtc uint))
    (let (
            (supply (ft-get-supply pool-sbtc))
            (assets (var-get total-sbtc))
        )
        (if (or (is-eq supply u0) (is-eq assets u0))
            sbtc
            (/ (* sbtc supply) assets)
        )
    )
)

;; sBTC redeemable for a given share amount at the current exchange rate.
(define-read-only (sbtc-for-shares (shares uint))
    (let ((supply (ft-get-supply pool-sbtc)))
        (if (is-eq supply u0)
            u0
            (/ (* shares (var-get total-sbtc)) supply)
        )
    )
)

(define-private (get-pending (vault principal))
    (default-to { sbtc: u0, ustx: u0 } (map-get? vault-pending vault))
)

;; ---------------------------------------------------------------------------
;; Signer registry (opt-in) + vault binding
;; ---------------------------------------------------------------------------

;; A signer indicates it wants to be listed. Verified against pox-5: the
;; signer-manager must already be a registered signer.
(define-public (list-signer
        (sm <signer-manager-trait>)
        (name (string-utf8 64))
        (fee-bips uint)
    )
    (let ((signer (contract-of sm)))
        (asserts! (is-some (contract-call? .pox-5 get-signer-info signer))
            ERR_SIGNER_NOT_REGISTERED
        )
        (asserts! (<= fee-bips MAX_BIPS) ERR_INVALID_FEE)
        (map-set listed-signers signer {
            listed-by: tx-sender,
            name: name,
            fee-bips: fee-bips,
            active: true,
        })
        (print {
            topic: "list-signer",
            signer: signer,
            listed-by: tx-sender,
            name: name,
            fee-bips: fee-bips,
        })
        (ok true)
    )
)

(define-public (update-listing
        (signer principal)
        (name (string-utf8 64))
        (fee-bips uint)
        (active bool)
    )
    (let ((listing (unwrap! (map-get? listed-signers signer) ERR_NOT_LISTED)))
        (asserts! (is-eq tx-sender (get listed-by listing)) ERR_NOT_LISTER)
        (asserts! (<= fee-bips MAX_BIPS) ERR_INVALID_FEE)
        (map-set listed-signers signer
            (merge listing {
                name: name,
                fee-bips: fee-bips,
                active: active,
            })
        )
        (print {
            topic: "update-listing",
            signer: signer,
            listed-by: tx-sender,
            name: name,
            fee-bips: fee-bips,
        })
        (ok true)
    )
)

(define-public (delist (signer principal))
    (let ((listing (unwrap! (map-get? listed-signers signer) ERR_NOT_LISTED)))
        (asserts! (is-eq tx-sender (get listed-by listing)) ERR_NOT_LISTER)
        (map-delete listed-signers signer)
        (print {
            topic: "delist",
            signer: signer,
            listed-by: tx-sender,
        })
        (ok true)
    )
)

;; Operator binds a pre-deployed vault to a signer. Deposits for that signer route
;; into this vault.
(define-public (assign-vault
        (signer principal)
        (vault <vault-trait>)
    )
    (begin
        (try! (is-operator))
        ;; Fail fast: reject binding a vault to a signer that isn't a live pox-5
        ;; signer. Mirrors pox-5's own gate (registered + active key grant) that
        ;; register-for-bond enforces later, so the operator can't strand future
        ;; depositors in a vault that could never stake. Point-in-time only -- a
        ;; grant can still be revoked before register-cohort, where pox-5 is final.
        (try! (contract-call? .pox-5 verify-signer-key-grant signer
            (unwrap! (contract-call? .pox-5 get-signer-info signer) ERR_SIGNER_NOT_REGISTERED)))
        ;; A vault belongs to exactly one signer (pox-5: one position per
        ;; principal). Reject rebinding it to a different signer.
        (asserts!
            (match (map-get? vault-signer (contract-of vault))
                existing (is-eq existing signer)
                true
            )
            ERR_VAULT_ALREADY_ASSIGNED
        )
        (map-set vault-signer (contract-of vault) signer)
        (print {
            topic: "assign-vault",
            signer: signer,
            vault: (contract-of vault),
        })
        (ok true)
    )
)

;; ---------------------------------------------------------------------------
;; Deposit (open window)
;; ---------------------------------------------------------------------------

;; Deposit `sbtc` sats and `ustx` microSTX, delegating to the signer `sm`. Funds
;; move into the vault bound to `sm`; the caller is minted liquid tokens.
(define-public (deposit
        (sm <signer-manager-trait>)
        (vault <vault-trait>)
        (sbtc uint)
        (ustx uint)
    )
    (let (
            (signer (contract-of sm))
            (v (contract-of vault))
            (user tx-sender)
            (shares (shares-for-sbtc sbtc))
            (pending (get-pending v))
        )
        (asserts! (> sbtc u0) ERR_ZERO_AMOUNT)
        ;; vault must be bound to the chosen signer
        (asserts! (is-eq (some signer) (map-get? vault-signer v))
            ERR_VAULT_NOT_ASSIGNED
        )
        ;; one vault (signer) per user until full exit
        ;; TODO: global pooled position instead of per-user vault binding? (see #2)
        (asserts!
            (match (map-get? user-vault user)
                current (is-eq current v)
                true
            )
            ERR_DIFFERENT_VAULT
        )

        ;; move the user's sBTC + STX into the vault
        (try! (contract-call? SBTC transfer sbtc user v none))
        (and (> ustx u0) (try! (stx-transfer? ustx user v)))

        ;; mint liquid tokens
        (try! (ft-mint? pool-sbtc shares user))

        ;; accounting
        (var-set total-sbtc (+ (var-get total-sbtc) sbtc))
        (map-set deposit-shares user
            (+ (default-to u0 (map-get? deposit-shares user)) shares)
        )
        (map-set stx-principal user
            (+ (default-to u0 (map-get? stx-principal user)) ustx)
        )
        (map-set user-vault user v)
        (map-set vault-pending v {
            sbtc: (+ (get sbtc pending) sbtc),
            ustx: (+ (get ustx pending) ustx),
        })

        (print {
            topic: "deposit",
            user: user,
            signer: signer,
            vault: v,
            sbtc: sbtc,
            ustx: ustx,
            shares: shares,
        })
        (ok shares)
    )
)

;; ---------------------------------------------------------------------------
;; Cohort lifecycle (operator)
;; ---------------------------------------------------------------------------

;; Register the aggregated pending cohort of `vault` into pox-5 under `sm`. Must
;; run before the bond starts; the vault must be in the bond's endowment allowlist.
(define-public (register-cohort
        (vault <vault-trait>)
        (bond-index uint)
        (sm <signer-manager-trait>)
        (signer-calldata (optional (buff 500)))
    )
    (let (
            (v (contract-of vault))
            (signer (contract-of sm))
            (pending (get-pending v))
        )
        (try! (is-operator))
        (asserts! (is-eq (some signer) (map-get? vault-signer v)) ERR_VAULT_MISMATCH)
        (asserts! (> (get sbtc pending) u0) ERR_NO_PENDING)
        (try! (contract-call? vault register-bond bond-index sm
            (get sbtc pending) (get ustx pending) signer-calldata
        ))
        ;; cohort is now locked in pox-5; clear the pending accumulator
        (map-delete vault-pending v)
        (print {
            topic: "register-cohort",
            vault: v,
            signer: signer,
            bond-index: bond-index,
            sbtc: (get sbtc pending),
            ustx: (get ustx pending),
        })
        (ok true)
    )
)

;; Fold `amount` sats of sBTC rewards into the pool, raising the redemption rate
;; for all liquid-token holders. The operator sources the sBTC from the
;; signer-manager's permissionless reward claims; `fold-rewards` then moves it
;; into the vault ATOMICALLY (rather than trusting an earlier out-of-band
;; delivery), so the liquid token's backing is always real.
(define-public (fold-rewards
        (vault <vault-trait>)
        (amount uint)
    )
    (begin
        (try! (is-operator))
        (asserts! (> amount u0) ERR_ZERO_AMOUNT)
        ;; Rewards may only be folded when shares exist to receive them.
        ;; Folding into an empty pool would strand the sBTC (no holder could ever
        ;; redeem it) and break the supply/asset coupling. (Found by rv fuzzing.)
        (asserts! (> (ft-get-supply pool-sbtc) u0) ERR_NO_SHARES)
        ;; Pull the reward sBTC into the vault now, so `total-sbtc` can never
        ;; exceed the sBTC actually reachable (solvency). Folding without real
        ;; delivery would break invariant-solvency. (Found by rv fuzzing.)
        (try! (contract-call? SBTC transfer amount tx-sender (contract-of vault) none))
        (var-set total-sbtc (+ (var-get total-sbtc) amount))
        (print {
            topic: "fold-rewards",
            vault: (contract-of vault),
            amount: amount,
        })
        (ok true)
    )
)

;; Unwind `amount` sats from a vault's pox-5 bond at term, returning the sBTC to
;; the vault so it is available for withdrawals.
(define-public (unstake-cohort
        (vault <vault-trait>)
        (sm <signer-manager-trait>)
        (amount uint)
    )
    (begin
        (try! (is-operator))
        (let ((withdrawn (try! (contract-call? vault unstake-sbtc sm amount))))
            (print {
                topic: "unstake-cohort",
                vault: (contract-of vault),
                amount: withdrawn,
            })
            (ok withdrawn)
        )
    )
)

;; ---------------------------------------------------------------------------
;; Withdraw
;; ---------------------------------------------------------------------------

;; Burn `shares` liquid tokens and receive the proportional sBTC plus the
;; proportional share of the caller's STX principal. The cohort's sBTC must have
;; been unwound first (`unstake-cohort`) so the vault holds it.
(define-public (withdraw
        (vault <vault-trait>)
        (shares uint)
    )
    (let (
            (user tx-sender)
            (v (contract-of vault))
            (user-shares (default-to u0 (map-get? deposit-shares user)))
            (user-stx (default-to u0 (map-get? stx-principal user)))
            (sbtc-out (sbtc-for-shares shares))
            (stx-out (if (is-eq user-shares u0)
                u0
                (/ (* user-stx shares) user-shares)
            ))
        )
        (asserts! (> shares u0) ERR_ZERO_AMOUNT)
        (asserts! (is-eq (some v) (map-get? user-vault user)) ERR_VAULT_MISMATCH)
        (asserts! (<= shares user-shares) ERR_INSUFFICIENT_SHARES)

        ;; burn shares and update accounting before paying out
        (try! (ft-burn? pool-sbtc shares user))
        (var-set total-sbtc (- (var-get total-sbtc) sbtc-out))
        (map-set deposit-shares user (- user-shares shares))
        (map-set stx-principal user (- user-stx stx-out))
        (if (is-eq (- user-shares shares) u0)
            (begin
                (map-delete user-vault user)
                (map-delete stx-principal user)
                (map-delete deposit-shares user)
                true
            )
            true
        )

        ;; pay sBTC + STX out of the vault to the user
        (try! (contract-call? vault payout sbtc-out stx-out user))

        (print {
            topic: "withdraw",
            user: user,
            vault: v,
            shares: shares,
            sbtc-out: sbtc-out,
            stx-out: stx-out,
        })
        (ok {
            sbtc: sbtc-out,
            stx: stx-out,
        })
    )
)

;; ---------------------------------------------------------------------------
;; Admin
;; ---------------------------------------------------------------------------

(define-public (set-operator (new-operator principal))
    (begin
        (try! (is-operator))
        (var-set operator new-operator)
        (ok true)
    )
)

(define-public (set-token-uri (uri (optional (string-utf8 256))))
    (begin
        (try! (is-operator))
        (var-set token-uri uri)
        (ok true)
    )
)

;; ---------------------------------------------------------------------------
;; Read-only views
;; ---------------------------------------------------------------------------

(define-read-only (get-listing (signer principal))
    (map-get? listed-signers signer)
)

;; Each vault has exactly one signer; return it (none if unassigned).
(define-read-only (get-vault-signer (vault principal))
    (map-get? vault-signer vault)
)

(define-read-only (get-total-sbtc)
    (var-get total-sbtc)
)

(define-read-only (get-user-position (user principal))
    {
        shares: (default-to u0 (map-get? deposit-shares user)),
        stx-principal: (default-to u0 (map-get? stx-principal user)),
        vault: (map-get? user-vault user),
    }
)

(define-read-only (get-vault-pending (vault principal))
    (get-pending vault)
)

(define-read-only (get-operator)
    (var-get operator)
)

;; ---------------------------------------------------------------------------
;; SIP-010 standard interface
;; ---------------------------------------------------------------------------

(define-public (transfer
        (amount uint)
        (sender principal)
        (recipient principal)
        (memo (optional (buff 34)))
    )
    (begin
        (asserts! (is-eq tx-sender sender) ERR_NOT_TOKEN_OWNER)
        (try! (ft-transfer? pool-sbtc amount sender recipient))
        (match memo to-print (print to-print) 0x)
        (ok true)
    )
)

(define-read-only (get-name)
    (ok "Pool sBTC")
)

(define-read-only (get-symbol)
    (ok "poolsBTC")
)

(define-read-only (get-decimals)
    (ok u8)
)

(define-read-only (get-balance (who principal))
    (ok (ft-get-balance pool-sbtc who))
)

(define-read-only (get-total-supply)
    (ok (ft-get-supply pool-sbtc))
)

(define-read-only (get-token-uri)
    (ok (var-get token-uri))
)

;; ---------------------------------------------------------------------------
;; Rendezvous (rv) invariants + properties
;;
;; These functions are annotated `#[env(simnet)]` so they exist only in the
;; simnet fuzzing environment and are stripped from real deployments. Run:
;;   npx rv . pool test       --runs 500   ;; pure share-math properties
;;   npx rv . pool invariant  --runs 500   ;; stateful solvency / coupling
;; ---------------------------------------------------------------------------

;; Rendezvous call-count context. rv calls `update-context` after each successful
;; public call so invariants can branch on how often a function has run.
(define-map context (string-ascii 100) { called: uint })

;; #[env(simnet)]
(define-private (update-context (function-name (string-ascii 100)) (called uint))
    (ok (map-set context function-name { called: called }))
)

;; Bootstrap a deposit-able state for the rv CLI campaign. Invoked once by the
;; harness deployment plan (tests/rv/deployments) via an `emulated-contract-call`
;; as the operator, so the fuzzer starts from real depth (supply > 0) instead of
;; bouncing off the assign-vault / signer-registration gates. Seeds the
;; vault->signer bindings directly (skipping the pox-5 signer check, which is
;; orthogonal to the pool accounting being fuzzed) and points the vaults at this
;; pool. Idempotent (tolerates already-wired) so the fuzzer re-calling it is
;; harmless. simnet-only; stripped from on-chain deployments.
;; #[env(simnet)]
(define-public (rv-wire)
    (let ((self (unwrap-panic (as-contract? () tx-sender))))
        (try! (is-operator))
        (map-set vault-signer .vault-1 .signer-manager)
        (map-set vault-signer .vault-2 .signer-manager-2)
        (match (contract-call? .vault-1 set-pool self) ok-1 true err-1 true)
        (match (contract-call? .vault-2 set-pool self) ok-2 true err-2 true)
        (ok true)
    )
)

;; The pre-deployed vaults the pool routes into.
(define-constant RV_VAULTS (list .vault-1 .vault-2))

;; sBTC reachable through a vault = its liquid sBTC balance + the sats it has
;; staked into pox-5 (bond membership). The literal sBTC principal is used (not
;; the SBTC constant) so the analyzer can prove this stays read-only.
(define-read-only (rv-vault-reachable-sbtc (vault principal))
    (+
        (unwrap-panic (contract-call?
            'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance vault
        ))
        (match (contract-call? .pox-5 get-bond-membership vault)
            m (get amount-sats m)
            u0
        )
    )
)

(define-read-only (rv-add-reachable (vault principal) (acc uint))
    (+ acc (rv-vault-reachable-sbtc vault))
)

(define-read-only (rv-total-reachable-sbtc)
    (fold rv-add-reachable RV_VAULTS u0)
)

;; SOLVENCY: the sBTC backing the liquid token never exceeds the sBTC actually
;; reachable across the pool's vaults.
;; #[env(simnet)]
(define-read-only (invariant-solvency)
    (<= (var-get total-sbtc) (rv-total-reachable-sbtc))
)

;; SUPPLY/ASSET COUPLING: liquid-token supply is zero exactly when the backing is
;; zero. Catches phantom supply (shares without assets) and stranded assets
;; (rewards folded into an empty pool that nobody can redeem).
;; #[env(simnet)]
(define-read-only (invariant-supply-assets-coupled)
    (is-eq
        (is-eq (ft-get-supply pool-sbtc) u0)
        (is-eq (var-get total-sbtc) u0)
    )
)

;; NO VALUE CREATION: sBTC -> shares -> sBTC never returns more than you started
;; with (rounding must favour the pool).
;; #[env(simnet)]
(define-private (test-sbtc-roundtrip-no-gain (sbtc uint))
    (begin
        (asserts! (<= (sbtc-for-shares (shares-for-sbtc sbtc)) sbtc) (err u9001))
        (ok true)
    )
)

;; NO SHARE INFLATION: shares -> sBTC -> shares never returns more shares.
;; #[env(simnet)]
(define-private (test-shares-roundtrip-no-gain (shares uint))
    (begin
        (asserts! (<= (shares-for-sbtc (sbtc-for-shares shares)) shares) (err u9002))
        (ok true)
    )
)
