#!/usr/bin/env node
//
// Deploy this project's contracts to the private Hiro node, which uses a CUSTOM
// Stacks chain id (256). Clarinet hard-codes testnet = 2147483648 and exposes no
// chain-id override, so we sign + broadcast with @stacks/transactions instead.
//
// Publishes, under the deployer and in order:
//   1. [[project.requirements]] — fetched-from-mainnet contracts (e.g. the
//      SIP-010 trait) that aren't on this node. Each is republished under the
//      deployer and its mainnet principal is remapped to the deployer in every
//      contract that references it (exactly what `clarinet deployments apply`
//      does). Source comes from .cache/requirements/<id>.clar.
//   2. [contracts.*] — this project's contracts (name, path, clarity_version).
// Idempotent: contracts already on the node are skipped (handy across the node's
// daily resets). pox-5 (boot) and sBTC are neither requirements nor [contracts],
// so they're never published here (resolved live on the node).
//
// Deployer key resolved from DEPLOYER_KEY (hex), DEPLOYER_MNEMONIC, or the
// mnemonic in settings/Testnet.toml (see scripts/_wallet.mjs).
//
// Env:
//   DEPLOYER_KEY / DEPLOYER_MNEMONIC   override the Testnet.toml mnemonic
//   API_URL        default https://api.private-1.hiro.so
//   CHAIN_ID       default 256
//   FEE            fixed fee (uSTX) per publish; default 1000000 (1 STX)
//   MANIFEST       default ./Clarinet.toml
//   MIN_USTX       faucet floor; default 50000000 (skip funding if >=)
//
// Usage:  ./scripts/deploy-testnet.sh   (mnemonic from settings/Testnet.toml)
//
import { readFileSync } from 'node:fs';
import {
  makeContractDeploy, broadcastTransaction, getAddressFromPrivateKey,
} from '@stacks/transactions';
import { STACKS_TESTNET } from '@stacks/network';
import { resolveDeployerKey } from './_wallet.mjs';

const API_URL = process.env.API_URL ?? 'https://api.private-1.hiro.so';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? '256');
const MANIFEST = process.env.MANIFEST ?? './Clarinet.toml';
const MIN_USTX = BigInt(process.env.MIN_USTX ?? '50000000');
const FEE = BigInt(process.env.FEE ?? '1000000'); // 1 STX/publish; override with FEE
const key = await resolveDeployerKey();

// chainId 256 for signing; transactionVersion stays testnet (ST/SN addresses).
const network = { ...STACKS_TESTNET, chainId: CHAIN_ID };
const client = { baseUrl: API_URL };
const deployer = getAddressFromPrivateKey(key, 'testnet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const contractExists = (name) =>
  fetch(`${API_URL}/v2/contracts/interface/${deployer}/${name}`).then((r) => r.ok).catch(() => false);

async function accountState() {
  const r = await fetch(`${API_URL}/v2/accounts/${deployer}?proof=0`).then((x) => x.json());
  return { nonce: Number(r.nonce), balance: BigInt(parseInt(r.balance, 16)) };
}

const toml = readFileSync(MANIFEST, 'utf8');

// [[project.requirements]] contract_id list (mainnet contracts)
function parseRequirements() {
  return [...toml.matchAll(/contract_id\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
}

// ordered [contracts.NAME] { path, clarity_version } from the manifest
function parseContracts() {
  const out = [];
  const re = /\[contracts\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|\s*$)/g;
  let m;
  while ((m = re.exec(toml))) {
    const path = (m[2].match(/path\s*=\s*"([^"]+)"/) || [])[1];
    const cv = Number((m[2].match(/clarity_version\s*=\s*(\d+)/) || [])[1] || 5);
    if (path) out.push({ name: m[1], path, clarityVersion: cv });
  }
  return out;
}

// Build the ordered publish list: requirements (remapped under the deployer)
// first, then local contracts (with requirement principals remapped).
function buildUnits() {
  const remap = {}; // mainnet principal -> deployer
  const reqUnits = parseRequirements().map((id) => {
    const [principal, name] = id.split('.');
    remap[principal] = deployer;
    const meta = JSON.parse(readFileSync(`.cache/requirements/${id}.json`, 'utf8'));
    return {
      name,
      source: readFileSync(`.cache/requirements/${id}.clar`, 'utf8'),
      clarityVersion: Number(String(meta.clarity_version).replace(/\D/g, '')) || 1,
    };
  });
  const applyRemap = (src) =>
    Object.entries(remap).reduce((s, [from, to]) => s.split(from).join(to), src);
  const localUnits = parseContracts().map((c) => ({
    name: c.name,
    source: applyRemap(readFileSync(c.path, 'utf8')),
    clarityVersion: c.clarityVersion,
  }));
  reqUnits.forEach((u) => { u.source = applyRemap(u.source); });
  return [...reqUnits, ...localUnits];
}

async function fund() {
  let { balance } = await accountState();
  for (let i = 0; balance < MIN_USTX && i < 8; i++) {
    console.log(`  faucet (${balance} < ${MIN_USTX}) ...`);
    await fetch(`${API_URL}/extended/v1/faucets/stx?address=${deployer}`, { method: 'POST' }).catch(() => {});
    await sleep(12000);
    ({ balance } = await accountState());
  }
  if (balance < MIN_USTX) { console.error('deployer underfunded after faucet'); process.exit(1); }
}

async function waitFor(name) {
  for (let i = 0; i < 60; i++) { if (await contractExists(name)) return true; await sleep(5000); }
  return false;
}

const units = buildUnits();
console.log(`deployer ${deployer} | chain ${CHAIN_ID} | node ${API_URL}`);
console.log(`publishing: ${units.map((u) => u.name).join(', ')}`);
await fund();

let { nonce } = await accountState();
for (const u of units) {
  if (await contractExists(u.name)) { console.log(`= ${u.name} exists, skip`); continue; }
  const tx = await makeContractDeploy({
    contractName: u.name,
    codeBody: u.source,
    clarityVersion: u.clarityVersion,
    senderKey: key,
    network, client, nonce, fee: FEE,
    postConditionMode: 'allow',
  });
  const res = await broadcastTransaction({ transaction: tx, network, client });
  if (res.error) { console.error(`x ${u.name}:`, JSON.stringify(res)); process.exit(1); }
  console.log(`-> ${u.name} clarity${u.clarityVersion} nonce ${nonce} txid 0x${res.txid}`);
  nonce++;
  if (!(await waitFor(u.name))) { console.error(`x ${u.name} not confirmed in time`); process.exit(1); }
  console.log(`   ok ${u.name}`);
}
console.log('deploy complete.');
