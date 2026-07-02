;; vault-trait
;;
;; The interface the pool router uses to drive a per-signer vault. Each vault is
;; its own principal and therefore holds exactly ONE pox-5 bond position (pox-5
;; keys a position by principal). The router routes a depositor's sBTC + STX into
;; the vault bound to the signer the depositor chose, then asks the vault to:
;;   - register the aggregated cohort into pox-5 (`register-bond`),
;;   - unwind sBTC at term (`unstake-sbtc`),
;;   - pay sBTC + STX back out to a withdrawing user (`payout`).
;;
;; The vault performs every pox-5 / sBTC call via `as-contract`, so the vault is
;; the pox-5 staker (tx-sender == contract-caller == vault), which both satisfies
;; pox-5's `check-caller-allowed` and means the vault is the allowlisted principal
;; the endowment whitelists for a bond.

(use-trait signer-manager-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)

(define-trait vault-trait (
    ;; Register the aggregated cohort (sbtc sats + ustx) into pox-5 under `sm`,
    ;; for the given bond-index, on the sBTC (L2) path.
    (register-bond
        (uint <signer-manager-trait> uint uint (optional (buff 500)))
        (response bool uint)
    )
    ;; Unwind `amount` sats of sBTC from the vault's pox-5 bond back into the
    ;; vault's own balance. Returns the sats actually withdrawn.
    (unstake-sbtc
        (<signer-manager-trait> uint)
        (response uint uint)
    )
    ;; Pay `sbtc` sats and `ustx` microSTX out of the vault to `to`.
    (payout
        (uint uint principal)
        (response bool uint)
    )
))
