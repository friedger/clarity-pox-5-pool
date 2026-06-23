;; rv-bootstrap (harness-only contract; only referenced by tests/rv/Clarinet.toml)
;;
;; Deployed last, after pool + the vaults. Its top-level body runs at publish and
;; wires the pool into a deposit-able state (binds vault-1/vault-2 to the two
;; signer-managers and points the vaults at the pool) by calling pool.rv-wire as
;; the deployer (the pool operator). This is what lets the `rv` invariant
;; campaign reach deep states (supply > 0) instead of bouncing off the
;; assign-vault / signer-registration gates. Never deployed on chain or in the
;; main Clarinet.toml.
(unwrap-panic (contract-call? .pool rv-wire))
