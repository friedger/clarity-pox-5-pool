// Resolve Stacks private keys from (in priority order):
//   1. an explicit hex key env (e.g. DEPLOYER_KEY / SIGNER_KEY)
//   2. DEPLOYER_MNEMONIC env
//   3. settings/Testnet.toml — the [accounts.deployer] mnemonic
// Mnemonic-derived keys use account `index` (m/44'/5757'/0'/0/index via
// @stacks/wallet-sdk): index 0 is the deployer (matches Clarinet), index 1 is
// the next account, etc.
import { readFileSync } from 'node:fs';
import { generateWallet, generateNewAccount } from '@stacks/wallet-sdk';

function mnemonicFromTestnetToml() {
  try {
    const m = readFileSync('settings/Testnet.toml', 'utf8').match(/mnemonic\s*=\s*"([^"]+)"/);
    if (m && !m[1].includes('YOUR PRIVATE')) return m[1];
  } catch { /* no file */ }
  return null;
}

export function getMnemonic() {
  const mnemonic = process.env.DEPLOYER_MNEMONIC ?? mnemonicFromTestnetToml();
  if (!mnemonic) {
    throw new Error(
      'No mnemonic. Set DEPLOYER_MNEMONIC or put the mnemonic in settings/Testnet.toml [accounts.deployer].',
    );
  }
  return mnemonic.trim();
}

// Private key for account `index` of the given mnemonic.
export async function keyAtIndex(mnemonic, index) {
  let wallet = await generateWallet({ secretKey: mnemonic.trim(), password: '' });
  for (let i = wallet.accounts.length; i <= index; i++) wallet = generateNewAccount(wallet);
  return wallet.accounts[index].stxPrivateKey; // 33-byte compressed (…'01')
}

// Deployer key: explicit DEPLOYER_KEY hex, else mnemonic account 0.
export async function resolveDeployerKey() {
  if (process.env.DEPLOYER_KEY) return process.env.DEPLOYER_KEY.replace(/^0x/, '');
  return (await keyAtIndex(getMnemonic(), 0)).replace(/^0x/, '');
}

// Key for a given account index: explicit `hexEnv` value wins, else mnemonic.
export async function resolveKeyAtIndex(index, hexEnv) {
  if (hexEnv) return hexEnv.replace(/^0x/, '');
  return (await keyAtIndex(getMnemonic(), index)).replace(/^0x/, '');
}
