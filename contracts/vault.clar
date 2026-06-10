;; vault-1
;;
;; A per-signer custodial vault for the signer-agnostic sBTC liquid-staking pool.
;; Holds at most ONE pox-5 bond position (pox-5 keys a position by principal, so a
;; single principal can only stake under one signer at a time). Several copies of
;; this contract (vault-1, vault-2, ...) are pre-deployed; the router binds each to
;; one signer via `assign-vault`. Every state-changing op is gated to the router
;; (`only-pool`); the router is set once, after deploy, via `set-pool`.
;;
;; All pox-5 / sBTC interactions run inside `as-contract`, so the vault itself is
;; the pox-5 staker and the principal the endowment allowlists for the bond.

(use-trait signer-manager-trait .pox-5.signer-manager-trait)
(impl-trait .vault-trait.vault-trait)

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; captured at deploy time (tx-sender == deployer)
(define-constant DEPLOYER tx-sender)

(define-constant ERR_NOT_POOL (err u2000))
(define-constant ERR_NOT_DEPLOYER (err u2001))
(define-constant ERR_POOL_ALREADY_SET (err u2002))

;; The router contract authorised to drive this vault.
(define-data-var pool (optional principal) none)

;; One-time binding of the router that controls this vault.
(define-public (set-pool (router principal))
    (begin
        (asserts! (is-eq tx-sender DEPLOYER) ERR_NOT_DEPLOYER)
        (asserts! (is-none (var-get pool)) ERR_POOL_ALREADY_SET)
        (var-set pool (some router))
        (ok true)
    )
)

(define-private (only-pool)
    (ok (asserts! (is-eq (some contract-caller) (var-get pool)) ERR_NOT_POOL))
)

;; Register the aggregated cohort into pox-5 on the sBTC (L2) path. The vault must
;; already hold `sbtc` sats of sBTC and `ustx` microSTX (the router moved them in
;; at deposit time), and must be in the bond's endowment allowlist.
(define-public (register-bond
        (bond-index uint)
        (sm <signer-manager-trait>)
        (sbtc uint)
        (ustx uint)
        (signer-calldata (optional (buff 500)))
    )
    (begin
        (try! (only-pool))
        ;; `(err sbtc)` selects pox-5's sBTC leg of `btc-lockup` (the L1 BTC-proof
        ;; leg is the `ok` branch and is out of scope for this sBTC-only pool).
        ;; pox-5 custodies the vault's `sbtc` sats via an sBTC transfer out. The
        ;; inner `try!` keeps the as-contract? body a plain value (not a response).
        (try! (as-contract? ((with-ft SBTC "sbtc-token" sbtc))
            (begin
                (try! (contract-call? .pox-5 register-for-bond bond-index sm
                    ustx (err sbtc) signer-calldata
                ))
                true
            )
        ))
        (ok true)
    )
)

;; Unwind `amount` sats from the vault's pox-5 bond back into the vault balance.
(define-public (unstake-sbtc
        (sm <signer-manager-trait>)
        (amount uint)
    )
    (begin
        (try! (only-pool))
        ;; pox-5 returns sBTC INTO this vault; the vault sends nothing, so no
        ;; outgoing asset allowance is required.
        (let ((result (try! (as-contract? ()
                (try! (contract-call? .pox-5 unstake-sbtc sm amount))
            ))))
            (ok (get amount-withdrawn-sats result))
        )
    )
)

;; Pay sBTC sats and microSTX out of the vault to a user on withdrawal.
(define-public (payout
        (sbtc uint)
        (ustx uint)
        (to principal)
    )
    (begin
        (try! (only-pool))
        (if (> sbtc u0)
            (try! (as-contract? ((with-ft SBTC "sbtc-token" sbtc))
                (try! (contract-call? SBTC transfer sbtc tx-sender to none))
            ))
            true
        )
        (if (> ustx u0)
            (try! (as-contract? ((with-stx ustx))
                (try! (stx-transfer? ustx tx-sender to))
            ))
            true
        )
        (ok true)
    )
)

(define-read-only (get-pool)
    (var-get pool)
)
