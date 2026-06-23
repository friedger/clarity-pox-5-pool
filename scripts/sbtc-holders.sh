#!/usr/bin/env bash
#
# sbtc-holders.sh
#
# Dump every sBTC holder with their sBTC and STX balances and the sBTC/STX ratio,
# richest sBTC holders first, straight from the Stacks Blockchain API Postgres DB.
#
# It reads the `ft_balances` table the API maintains (migration
# 1720532894811_ft_balances.js): one row per (address, token) with the current
# balance. Fungible tokens are keyed by their asset id (`<contract>::<name>`) and
# STX is keyed by the literal token `'stx'`, so a single self-join gives both
# balances for every sBTC holder.
#
# Connection: set DATABASE_URL, or the standard PG* env vars (PGHOST, PGPORT,
# PGDATABASE, PGUSER, PGPASSWORD). This is the stacks-blockchain-api database.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/stacks_blockchain_api \
#     scripts/sbtc-holders.sh                 # all holders -> CSV on stdout
#   scripts/sbtc-holders.sh --limit 50        # just the 50 richest
#   scripts/sbtc-holders.sh --out holders.csv # write to a file
#
# Output columns (CSV):
#   rank, address, sbtc_sats, sbtc, stx_ustx, stx, sbtc_per_stx
#     sbtc_sats / stx_ustx : raw base units (sBTC = 8 decimals, STX = 6 decimals)
#     sbtc / stx           : human-readable amounts
#     sbtc_per_stx         : sBTC amount divided by STX amount (NULL if STX == 0)

set -euo pipefail

SBTC_ASSET='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token'

limit=""
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) limit="${2:?--limit needs a number}"; shift 2 ;;
    --out)   out="${2:?--out needs a path}"; shift 2 ;;
    -h|--help) sed -n '3,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

limit_clause=""
if [[ -n "$limit" ]]; then
  [[ "$limit" =~ ^[0-9]+$ ]] || { echo "--limit must be an integer" >&2; exit 2; }
  limit_clause="LIMIT $limit"
fi

read -r -d '' SQL <<SQL || true
WITH sbtc AS (
  SELECT address, balance
  FROM ft_balances
  WHERE token = '${SBTC_ASSET}'
    AND balance > 0
)
SELECT
  ROW_NUMBER() OVER (ORDER BY s.balance DESC)                AS rank,
  s.address                                                 AS address,
  s.balance                                                 AS sbtc_sats,
  round(s.balance / 1e8, 8)                                 AS sbtc,
  COALESCE(x.balance, 0)                                    AS stx_ustx,
  round(COALESCE(x.balance, 0) / 1e6, 6)                    AS stx,
  round((s.balance / 1e8) / NULLIF(COALESCE(x.balance, 0) / 1e6, 0), 8)
                                                            AS sbtc_per_stx
FROM sbtc s
LEFT JOIN ft_balances x
  ON x.address = s.address AND x.token = 'stx'
ORDER BY s.balance DESC
${limit_clause};
SQL

# Build the psql command. Prefer DATABASE_URL; otherwise fall back to PG* env.
psql_cmd=(psql --no-psqlrc --csv -v ON_ERROR_STOP=1)
if [[ -n "${DATABASE_URL:-}" ]]; then
  psql_cmd+=("$DATABASE_URL")
fi

if [[ -n "$out" ]]; then
  "${psql_cmd[@]}" -c "$SQL" > "$out"
  echo "wrote $(($(wc -l < "$out") - 1)) holders to $out" >&2
else
  "${psql_cmd[@]}" -c "$SQL"
fi
