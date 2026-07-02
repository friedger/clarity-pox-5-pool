#!/usr/bin/env bash
#
# Deploy this project's contracts to the private Hiro node (chain id 256).
#
# Clarinet hard-codes the testnet chain id (2147483648) and has no override, so
# `clarinet deployments apply` is rejected by this node with a SignatureValidation
# "invalid chain ID" error. We sign + broadcast with @stacks/transactions via
# scripts/deploy.mjs (chainId 256), which faucet-funds the deployer and is
# idempotent across the node's daily resets.
#
# The deployer key is taken from the mnemonic in settings/Testnet.toml, or from
# DEPLOYER_MNEMONIC / DEPLOYER_KEY if set. Fees are hardcoded (override with FEE).
#
# Usage:  ./scripts/deploy-testnet.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/deploy.mjs
