#!/usr/bin/env node
//
// Poll for vault-1 (SM=1) becoming allowlisted on any pox-5 bond (setup-bond
// allowlists are one-shot and admin-controlled — we can't add ourselves), and
// as soon as one is found with its registration window still open
// (burn-block-height < bond-start-height), run `register-cohort` for it.
//
// Caches closed/nonexistent bonds across iterations so each poll only
// re-checks bonds that are still open, plus one new index beyond the
// highest one seen so far — cheap instead of re-probing a wide range.
//
// Env: SM (default 1), POLL_MS (default 30000).
//
import { execFileSync } from 'node:child_process';
import { Cl, serializeCV, deserializeCV, cvToValue, getAddressFromPrivateKey } from '@stacks/transactions';
import { resolveDeployerKey } from './_wallet.mjs';

const API_URL = process.env.API_URL ?? 'https://api.private-1.hiro.so';
const POX5 = 'ST000000000000000000002AMW42H';
const SM = process.env.SM ?? '1';
const POLL_MS = Number(process.env.POLL_MS ?? '30000');
const PAIRS = { 1: 'vault-1', 2: 'vault-2' };

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callRead(deployer, fn, argCVs) {
  const body = JSON.stringify({ sender: deployer, arguments: argCVs.map((cv) => `0x${serializeCV(cv)}`) });
  const r = await fetch(`${API_URL}/v2/contracts/call-read/${POX5}/pox-5/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  }).then((x) => x.json());
  if (!r.okay) throw new Error(`call-read ${fn}: ${JSON.stringify(r)}`);
  return cvToValue(deserializeCV(r.result), true);
}

async function main() {
  const deployerKey = await resolveDeployerKey();
  const deployer = getAddressFromPrivateKey(deployerKey, 'testnet');
  const vault = `${deployer}.${PAIRS[SM]}`;
  const vaultPrincipal = Cl.principal(vault);

  log(`watching for ${vault} to appear on a bond allowlist with an open window`);

  // index -> 'unset' | { startHt: bigint }  (only bonds worth re-checking each loop)
  const openBonds = new Map();
  let nextUnprobed = Number(process.env.SEED_START ?? '0');

  for (;;) {
    const burn = BigInt((await fetch(`${API_URL}/v2/pox`).then((r) => r.json())).current_burnchain_block_height);

    // Drop bonds whose window has closed since last check — never revisit them.
    for (const [i, info] of openBonds) {
      if (burn >= info.startHt) { log(`bond ${i}: window closed (start ${info.startHt}), dropping from watch`); openBonds.delete(i); }
    }

    // Probe exactly one new index beyond the highest bond seen so far (bonds
    // are created sequentially by the admin), so we notice new ones without
    // re-scanning a wide range every loop.
    const bond = await callRead(deployer, 'get-protocol-bond', [Cl.uint(BigInt(nextUnprobed))]).catch(() => null);
    if (bond !== null) {
      const startHt = BigInt(await callRead(deployer, 'bond-period-to-burn-height', [Cl.uint(BigInt(nextUnprobed))]));
      if (burn < startHt) { openBonds.set(nextUnprobed, { startHt }); log(`bond ${nextUnprobed}: new, window open until burn ${startHt}`); }
      nextUnprobed++;
    }

    for (const [i, info] of openBonds) {
      const allowance = await callRead(deployer, 'get-bond-allowance', [Cl.uint(BigInt(i)), vaultPrincipal]).catch(() => null);
      if (allowance === null) continue;

      log(`FOUND: ${vault} allowlisted on bond ${i} (max ${allowance} sats), window open until burn ${info.startHt} (now ${burn}) — registering cohort`);
      try {
        const out = execFileSync('node', ['scripts/bootstrap.mjs', 'register-cohort'], {
          env: { ...process.env, SM, BOND_INDEX: String(i) },
          encoding: 'utf8',
        });
        log(out.trim());
        log('register-cohort submitted — done watching');
        return;
      } catch (e) {
        log('register-cohort FAILED:', e.stdout ?? String(e));
        // keep watching in case it was transient
      }
    }

    log(`burn ${burn}: watching bonds [${[...openBonds.keys()].join(',') || '-'}], next unprobed index ${nextUnprobed}`);
    await sleep(POLL_MS);
  }
}

main().catch((e) => { log('FATAL', e); process.exit(1); });
