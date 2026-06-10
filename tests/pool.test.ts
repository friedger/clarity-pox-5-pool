import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import {
  signMessageHashRsv,
  privateKeyToPublic,
  compressPublicKey,
  publicKeyToHex,
} from "@stacks/transactions";

/*
 * End-to-end tests for the signer-agnostic sBTC liquid-staking pool on pox-5.
 *
 * TESTING CAVEATS (see pool.clar / plan):
 *  - The vendored pox-5 is a regular contract here, not the node's boot pox
 *    contract, so the node-side STX *lock* never fires. STX balances are real and
 *    pox-5 bookkeeping (memberships, totals) is exercised, but we assert on that
 *    bookkeeping + the liquid token + sBTC transfers, not on L1 STX-lock state.
 *  - The L1 BTC-lockup proof path is not exercised; deposits use pox-5's sBTC
 *    (err-branch) leg of `btc-lockup`.
 *  - Real pox-5 reward distribution needs the node; rewards are simulated by
 *    delivering sBTC to a vault and folding it in via `fold-rewards`.
 */

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;

const POX5 = `${deployer}.pox-5`;
const SIGNER_MGR = `${deployer}.signer-manager`;
const SIGNER_MGR_2 = `${deployer}.signer-manager-2`;
const POOL = `${deployer}.pool`;
const VAULT1 = `${deployer}.vault-1`;
const VAULT2 = `${deployer}.vault-2`;
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// The initial bond-admin in pox-5 is the boot address; we transfer it to the
// deployer by impersonating the boot principal.
const BOOT_ADMIN = "SP000000000000000000002Q6VF78";

// burnchain params chosen so bond-index 1 is set-up-able and registrable at the
// simnet's initial burn height (see plan timing math).
const REWARD_CYCLE_LEN = 10;
const PREPARE_LEN = 2;
const BEGIN_CYCLE = 0;
const BOND_INDEX = 1;
const STX_VALUE_RATIO = 100; // ustx per 100 sats
const MIN_USTX_RATIO = 100; // bips

// Two signer keypairs (private keys -> compressed pubkeys used as signer keys).
const SIGNER1_PRIV = "11".repeat(32);
const SIGNER2_PRIV = "22".repeat(32);

function signerKeyHex(priv: string): string {
  return publicKeyToHex(compressPublicKey(privateKeyToPublic(priv)));
}

function bufHex(cv: any): string {
  // BufferCV value is a Uint8Array; convert to hex string (no 0x).
  const v = cv.value;
  if (v instanceof Uint8Array) {
    return Array.from(v)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return String(v).replace(/^0x/, "");
}

// Register `signerMgr` as a pox-5 signer using `priv` (admin = deployer).
function registerSigner(signerMgr: string, priv: string, authId: number) {
  const signerKey = signerKeyHex(priv);
  const hashRes = simnet.callReadOnlyFn(
    POX5,
    "get-signer-grant-message-hash",
    [Cl.principal(signerMgr), Cl.uint(authId)],
    deployer,
  );
  const messageHash = bufHex(hashRes.result);
  const sig = signMessageHashRsv({ messageHash, privateKey: priv });
  const sigHex = (sig as any).data ?? sig;

  return simnet.callPublicFn(
    signerMgr,
    "register-self",
    [
      Cl.principal(signerMgr),
      Cl.bufferFromHex(signerKey),
      Cl.uint(authId),
      Cl.bufferFromHex(String(sigHex).replace(/^0x/, "")),
    ],
    deployer,
  );
}

// Full bootstrap: configure pox-5, set up a bond, register both signers, bind
// each vault to a signer, and point both vaults at the pool.
function bootstrap() {
  const firstBurn = simnet.burnBlockHeight;

  expect(
    simnet.callPublicFn(
      POX5,
      "set-burnchain-parameters",
      [
        Cl.uint(firstBurn),
        Cl.uint(PREPARE_LEN),
        Cl.uint(REWARD_CYCLE_LEN),
        Cl.uint(BEGIN_CYCLE),
      ],
      deployer,
    ).result,
  ).toBeOk(Cl.bool(true));

  // move bond-admin from the boot principal to the deployer
  simnet.callPublicFn(
    POX5,
    "set-bond-admin",
    [Cl.principal(deployer)],
    BOOT_ADMIN,
  );

  // register both signers
  expect(registerSigner(SIGNER_MGR, SIGNER1_PRIV, 1).result).toBeOk(
    Cl.tuple({
      "signer-key": Cl.bufferFromHex(
        "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
      ),
      signer: Cl.principal(SIGNER_MGR),
    }),
  );
  expect(registerSigner(SIGNER_MGR_2, SIGNER2_PRIV, 1).result).toBeOk(
    Cl.tuple({
      "signer-key": Cl.bufferFromHex(
        "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
      ),
      signer: Cl.principal(SIGNER_MGR_2),
    }),
  );

  // set up bond-index 1 with both vaults allowlisted
  const allow = Cl.list([
    Cl.tuple({
      staker: Cl.principal(VAULT1),
      "max-sats": Cl.uint(1_000_000_000),
    }),
    Cl.tuple({
      staker: Cl.principal(VAULT2),
      "max-sats": Cl.uint(1_000_000_000),
    }),
  ]);
  expect(
    simnet.callPublicFn(
      POX5,
      "setup-bond",
      [
        Cl.uint(BOND_INDEX),
        Cl.uint(500),
        Cl.uint(STX_VALUE_RATIO),
        Cl.uint(MIN_USTX_RATIO),
        Cl.bufferFromHex("00"),
        allow,
      ],
      deployer,
    ).result,
  ).toBeOk(Cl.tuple({
   "bond-index": Cl.uint(1),
   "early-unlock-bytes": Cl.bufferFromHex("00"),
   "max-allocation-sats": Cl.uint(2_000_000_000),
   "min-ustx-ratio": Cl.uint(100),
   "stx-value-ratio": Cl.uint(100),
   "target-rate": Cl.uint(500)
 }));

  // point vaults at the pool router
  simnet.callPublicFn(VAULT1, "set-pool", [Cl.principal(POOL)], deployer);
  simnet.callPublicFn(VAULT2, "set-pool", [Cl.principal(POOL)], deployer);

  // bind vault-1 -> signer-1, vault-2 -> signer-2
  expect(
    simnet.callPublicFn(
      POOL,
      "assign-vault",
      [Cl.principal(SIGNER_MGR), Cl.principal(VAULT1)],
      deployer,
    ).result,
  ).toBeOk(Cl.bool(true));
  expect(
    simnet.callPublicFn(
      POOL,
      "assign-vault",
      [Cl.principal(SIGNER_MGR_2), Cl.principal(VAULT2)],
      deployer,
    ).result,
  ).toBeOk(Cl.bool(true));
}

function sbtcBalance(who: string): bigint {
  const r = simnet.callReadOnlyFn(
    SBTC,
    "get-balance",
    [Cl.principal(who)],
    deployer,
  );
  return (r.result as any).value.value as bigint;
}

function poolBalance(who: string): bigint {
  const r = simnet.callReadOnlyFn(
    POOL,
    "get-balance",
    [Cl.principal(who)],
    deployer,
  );
  return (r.result as any).value.value as bigint;
}

describe("signer registry", () => {
  beforeEach(() => bootstrap());

  it("a registered signer can be listed and read back", () => {
    const res = simnet.callPublicFn(
      POOL,
      "list-signer",
      [Cl.principal(SIGNER_MGR), Cl.stringUtf8("Alice Signer"), Cl.uint(250)],
      wallet1,
    );
    expect(res.result).toBeOk(Cl.bool(true));

    const listing = simnet.callReadOnlyFn(
      POOL,
      "get-listing",
      [Cl.principal(SIGNER_MGR)],
      deployer,
    );
    expect(listing.result).toBeSome(
      Cl.tuple({
        "listed-by": Cl.principal(wallet1),
        name: Cl.stringUtf8("Alice Signer"),
        "fee-bips": Cl.uint(250),
        active: Cl.bool(true),
      }),
    );
  });

  it("rejects listing an unregistered signer", () => {
    // pox-5 has no signer registered at this principal (vault-1 is not a signer)
    const res = simnet.callPublicFn(
      POOL,
      "list-signer",
      [Cl.principal(VAULT1), Cl.stringUtf8("Nope"), Cl.uint(0)],
      wallet1,
    );
    expect(res.result).toBeErr(Cl.uint(3001)); // ERR_SIGNER_NOT_REGISTERED
  });

  it("only the original lister can delist", () => {
    simnet.callPublicFn(
      POOL,
      "list-signer",
      [Cl.principal(SIGNER_MGR), Cl.stringUtf8("Alice"), Cl.uint(0)],
      wallet1,
    );
    expect(
      simnet.callPublicFn(POOL, "delist", [Cl.principal(SIGNER_MGR)], wallet2)
        .result,
    ).toBeErr(Cl.uint(3003)); // ERR_NOT_LISTER
    expect(
      simnet.callPublicFn(POOL, "delist", [Cl.principal(SIGNER_MGR)], wallet1)
        .result,
    ).toBeOk(Cl.bool(true));
  });
});

describe("deposit + cohort lifecycle", () => {
  beforeEach(() => bootstrap());

  it("deposit mints liquid tokens 1:1 on first deposit and moves funds to the vault", () => {
    const sbtc = 100_000n;
    const ustx = 100_000n;
    const vaultBefore = sbtcBalance(VAULT1);

    const res = simnet.callPublicFn(
      POOL,
      "deposit",
      [
        Cl.principal(SIGNER_MGR),
        Cl.principal(VAULT1),
        Cl.uint(sbtc),
        Cl.uint(ustx),
      ],
      wallet1,
    );
    expect(res.result).toBeOk(Cl.uint(sbtc)); // first deposit: shares == sats

    expect(poolBalance(wallet1)).toBe(sbtc);
    expect(sbtcBalance(VAULT1)).toBe(vaultBefore + sbtc);

    const pending = simnet.callReadOnlyFn(
      POOL,
      "get-vault-pending",
      [Cl.principal(VAULT1)],
      deployer,
    );
    expect(pending.result).toBeTuple({
      sbtc: Cl.uint(sbtc),
      ustx: Cl.uint(ustx),
    });
  });

  it("deposit into a vault not bound to the chosen signer is rejected", () => {
    const res = simnet.callPublicFn(
      POOL,
      "deposit",
      [
        Cl.principal(SIGNER_MGR),
        Cl.principal(VAULT2),
        Cl.uint(1000),
        Cl.uint(1000),
      ],
      wallet1,
    );
    expect(res.result).toBeErr(Cl.uint(3005)); // ERR_VAULT_NOT_ASSIGNED
  });

  it("register-cohort stakes the aggregated funds into pox-5 under the chosen signer", () => {
    simnet.callPublicFn(
      POOL,
      "deposit",
      [
        Cl.principal(SIGNER_MGR),
        Cl.principal(VAULT1),
        Cl.uint(200_000),
        Cl.uint(200_000),
      ],
      wallet1,
    );
    simnet.callPublicFn(
      POOL,
      "deposit",
      [
        Cl.principal(SIGNER_MGR),
        Cl.principal(VAULT1),
        Cl.uint(300_000),
        Cl.uint(300_000),
      ],
      wallet2,
    );

    const reg = simnet.callPublicFn(
      POOL,
      "register-cohort",
      [
        Cl.principal(VAULT1),
        Cl.uint(BOND_INDEX),
        Cl.principal(SIGNER_MGR),
        Cl.none(),
      ],
      deployer,
    );
    expect(reg.result).toBeOk(Cl.bool(true));

    // pox-5 now shows the vault as a bond member under signer-1 with the aggregate
    const membership = simnet.callReadOnlyFn(
      POX5,
      "get-bond-membership",
      [Cl.principal(VAULT1)],
      deployer,
    );
    expect(membership.result).toBeSome(
      Cl.tuple({
        "bond-index": Cl.uint(BOND_INDEX),
        "amount-ustx": Cl.uint(500_000),
        signer: Cl.principal(SIGNER_MGR),
        "is-l1-lock": Cl.bool(false),
        "amount-sats": Cl.uint(500_000),
      }),
    );

    // pending cleared
    expect(
      simnet.callReadOnlyFn(
        POOL,
        "get-vault-pending",
        [Cl.principal(VAULT1)],
        deployer,
      ).result,
    ).toBeTuple({ sbtc: Cl.uint(0), ustx: Cl.uint(0) });
  });

  it("fold-rewards raises the redemption rate for existing holders", () => {
    simnet.callPublicFn(
      POOL,
      "deposit",
      [
        Cl.principal(SIGNER_MGR),
        Cl.principal(VAULT1),
        Cl.uint(100_000),
        Cl.uint(100_000),
      ],
      wallet1,
    );
    // 100k shares back 100k sBTC -> 1.0 rate
    expect(
      (
        simnet.callReadOnlyFn(
          POOL,
          "sbtc-for-shares",
          [Cl.uint(100_000)],
          deployer,
        ).result as any
      ).value,
    ).toBe(100_000n);

    // deliver 50k sBTC of "rewards" to the vault and fold it in
    simnet.callPublicFn(
      SBTC,
      "transfer",
      [
        Cl.uint(50_000),
        Cl.principal(deployer),
        Cl.principal(VAULT1),
        Cl.none(),
      ],
      deployer,
    );
    expect(
      simnet.callPublicFn(
        POOL,
        "fold-rewards",
        [Cl.principal(VAULT1), Cl.uint(50_000)],
        deployer,
      ).result,
    ).toBeOk(Cl.bool(true));

    // now 100k shares redeem 150k sBTC
    expect(
      (
        simnet.callReadOnlyFn(
          POOL,
          "sbtc-for-shares",
          [Cl.uint(100_000)],
          deployer,
        ).result as any
      ).value,
    ).toBe(150_000n);
  });

  it("full lifecycle: deposit -> register -> rewards -> unstake -> withdraw returns sBTC + STX", () => {
    const sbtc = 400_000n;
    const ustx = 400_000n;

    simnet.callPublicFn(
      POOL,
      "deposit",
      [
        Cl.principal(SIGNER_MGR),
        Cl.principal(VAULT1),
        Cl.uint(sbtc),
        Cl.uint(ustx),
      ],
      wallet1,
    );
    simnet.callPublicFn(
      POOL,
      "register-cohort",
      [
        Cl.principal(VAULT1),
        Cl.uint(BOND_INDEX),
        Cl.principal(SIGNER_MGR),
        Cl.none(),
      ],
      deployer,
    );

    // simulate rewards: 40k sBTC delivered to the vault + folded in
    simnet.callPublicFn(
      SBTC,
      "transfer",
      [
        Cl.uint(40_000),
        Cl.principal(deployer),
        Cl.principal(VAULT1),
        Cl.none(),
      ],
      deployer,
    );
    simnet.callPublicFn(
      POOL,
      "fold-rewards",
      [Cl.principal(VAULT1), Cl.uint(40_000)],
      deployer,
    );

    // unwind the staked sBTC back into the vault so it can be withdrawn
    expect(
      simnet.callPublicFn(
        POOL,
        "unstake-cohort",
        [Cl.principal(VAULT1), Cl.principal(SIGNER_MGR), Cl.uint(sbtc)],
        deployer,
      ).result,
    ).toBeOk(Cl.uint(sbtc));

    const sbtcBefore = sbtcBalance(wallet1);

    // withdraw all shares -> proportional sBTC (principal + reward) + all STX
    const wd = simnet.callPublicFn(
      POOL,
      "withdraw",
      [Cl.principal(VAULT1), Cl.uint(sbtc)],
      wallet1,
    );
    expect(wd.result).toBeOk(
      Cl.tuple({ sbtc: Cl.uint(440_000), stx: Cl.uint(ustx) }),
    );

    // user received principal + reward sBTC
    expect(sbtcBalance(wallet1)).toBe(sbtcBefore + 440_000n);
    // liquid tokens burned
    expect(poolBalance(wallet1)).toBe(0n);
    // position cleared
    expect(
      simnet.callReadOnlyFn(POOL, "get-total-sbtc", [], deployer).result as any,
    ).toBeUint(0);
  });
});

describe("signer-agnostic", () => {
  beforeEach(() => bootstrap());

  it("two users delegate to two different signers via two vaults simultaneously", () => {
    // wallet1 -> signer-1/vault-1, wallet2 -> signer-2/vault-2
    simnet.callPublicFn(
      POOL,
      "deposit",
      [
        Cl.principal(SIGNER_MGR),
        Cl.principal(VAULT1),
        Cl.uint(150_000),
        Cl.uint(150_000),
      ],
      wallet1,
    );
    simnet.callPublicFn(
      POOL,
      "deposit",
      [
        Cl.principal(SIGNER_MGR_2),
        Cl.principal(VAULT2),
        Cl.uint(250_000),
        Cl.uint(250_000),
      ],
      wallet2,
    );

    simnet.callPublicFn(
      POOL,
      "register-cohort",
      [
        Cl.principal(VAULT1),
        Cl.uint(BOND_INDEX),
        Cl.principal(SIGNER_MGR),
        Cl.none(),
      ],
      deployer,
    );
    simnet.callPublicFn(
      POOL,
      "register-cohort",
      [
        Cl.principal(VAULT2),
        Cl.uint(BOND_INDEX),
        Cl.principal(SIGNER_MGR_2),
        Cl.none(),
      ],
      deployer,
    );

    // both vaults hold positions under their respective (distinct) signers
    const m1 = simnet.callReadOnlyFn(
      POX5,
      "get-bond-membership",
      [Cl.principal(VAULT1)],
      deployer,
    );
    const m2 = simnet.callReadOnlyFn(
      POX5,
      "get-bond-membership",
      [Cl.principal(VAULT2)],
      deployer,
    );
    expect(m1.result).toBeSome(
      Cl.tuple({
        "bond-index": Cl.uint(BOND_INDEX),
        "amount-ustx": Cl.uint(150_000),
        signer: Cl.principal(SIGNER_MGR),
        "is-l1-lock": Cl.bool(false),
        "amount-sats": Cl.uint(150_000),
      }),
    );
    expect(m2.result).toBeSome(
      Cl.tuple({
        "bond-index": Cl.uint(BOND_INDEX),
        "amount-ustx": Cl.uint(250_000),
        signer: Cl.principal(SIGNER_MGR_2),
        "is-l1-lock": Cl.bool(false),
        "amount-sats": Cl.uint(250_000),
      }),
    );
  });
});
