import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { Cl } from "@stacks/transactions";
import { getContractFunction, strategyFor } from "@stacks/rendezvous";

/*
 * Rendezvous (rv) fuzzing harness.
 *
 * The pool's `#[env(simnet)]` rv functions (invariant-* / test-* / update-context)
 * live in contracts/pool.clar. We drive Rendezvous through its LIBRARY API rather
 * than the `rv` CLI: the CLI crashes on this project because clarinet's
 * `getContractAST` throws for the mainnet sBTC *requirement* contracts and rv's
 * trait scan (`extractProjectTraitImplementations`) does not guard that. Passing
 * an explicit (empty) trait-implementation map to `strategyFor` bypasses that
 * scan, so the exact same property/argument generation runs here.
 *
 * Part 1 fuzzes the pure share-math properties (test-*).
 * Part 2 runs a stateful campaign over the pool's real public functions and
 * asserts the invariants (invariant-*) after every step.
 */

const deployer = simnet.deployer;
const POOL = `${deployer}.pool`;
const VAULT1 = `${deployer}.vault-1`;
const SIGNER1 = `${deployer}.signer-manager`;
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const accounts = simnet.getAccounts();
const wallets = [
  accounts.get("wallet_1")!,
  accounts.get("wallet_2")!,
  accounts.get("wallet_3")!,
];

const isTrue = (cv: any) => cv.type === "true";
const okTrue = (cv: any) => cv.type === "ok" && cv.value.type === "true";

function checkInvariant(name: string): boolean {
  return isTrue(simnet.callReadOnlyFn(POOL, name, [], deployer).result);
}

// ---------------------------------------------------------------------------
// Part 1: property-based fuzzing of the pure share-math (rv library arg-gen)
// ---------------------------------------------------------------------------
describe("rv properties (share math)", () => {
  for (const name of ["test-sbtc-roundtrip-no-gain", "test-shares-roundtrip-no-gain"]) {
    it(`${name} holds over fuzzed inputs`, () => {
      const fn = getContractFunction(simnet, "pool", name);
      // 4th arg `{}` -> skip rv's project-wide trait scan (avoids the CLI crash).
      const arb = strategyFor(simnet, fn, [...accounts.values()], {});
      fc.assert(
        fc.property(arb, (args: any[]) => {
          const { result } = simnet.callPrivateFn(POOL, name, args, deployer);
          return okTrue(result);
        }),
        { numRuns: 500 },
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Part 2: stateful invariant campaign over the real public functions
// ---------------------------------------------------------------------------
describe("rv invariants (stateful campaign)", () => {
  beforeAll(() => {
    // Minimal wiring: bind vault-1 to signer-1 and point it at the pool. (No
    // pox-5 bootstrap needed: this campaign keeps funds liquid in the vault
    // instead of registering a cohort, so withdrawals always have backing.)
    simnet.callPublicFn(VAULT1, "set-pool", [Cl.principal(POOL)], deployer);
    expect(
      simnet.callPublicFn(
        POOL,
        "assign-vault",
        [Cl.principal(SIGNER1), Cl.principal(VAULT1)],
        deployer,
      ).result,
    ).toBeOk(Cl.bool(true));
  });

  it("solvency + supply/asset coupling hold across a random op sequence", () => {
    const u = fc.constantFrom(...wallets);
    const amt = fc.integer({ min: 1, max: 2_000_000 });

    // A reproducible random sequence of operations.
    const ops = fc.sample(
      fc.oneof(
        fc.record({ k: fc.constant("deposit"), who: u, sbtc: amt, ustx: amt }),
        fc.record({ k: fc.constant("reward"), amount: amt }),
        fc.record({ k: fc.constant("withdraw"), who: u, shares: amt }),
        fc.record({ k: fc.constant("transfer"), from: u, to: u, amount: amt }),
      ),
      { numRuns: 200, seed: 42 },
    );

    const balance = (who: string): bigint =>
      (simnet.callReadOnlyFn(POOL, "get-balance", [Cl.principal(who)], deployer)
        .result as any).value.value as bigint;
    const depositShares = (who: string): bigint =>
      ((simnet.callReadOnlyFn(POOL, "get-user-position", [Cl.principal(who)], deployer)
        .result as any).value.shares.value as bigint);

    for (const [i, op] of ops.entries()) {
      switch ((op as any).k) {
        case "deposit":
          simnet.callPublicFn(
            POOL,
            "deposit",
            [
              Cl.principal(SIGNER1),
              Cl.principal(VAULT1),
              Cl.uint((op as any).sbtc),
              Cl.uint((op as any).ustx),
            ],
            (op as any).who,
          );
          break;
        case "reward": {
          // Legitimate operator flow: deliver sBTC to the vault, then fold it in.
          const amount = (op as any).amount;
          simnet.callPublicFn(
            SBTC,
            "transfer",
            [Cl.uint(amount), Cl.principal(deployer), Cl.principal(VAULT1), Cl.none()],
            deployer,
          );
          simnet.callPublicFn(
            POOL,
            "fold-rewards",
            [Cl.principal(VAULT1), Cl.uint(amount)],
            deployer,
          );
          break;
        }
        case "withdraw": {
          // Withdraw at most the caller's own deposit shares.
          const ds = depositShares((op as any).who);
          if (ds > 0n) {
            const shares = BigInt((op as any).shares) % ds || ds;
            simnet.callPublicFn(
              POOL,
              "withdraw",
              [Cl.principal(VAULT1), Cl.uint(shares)],
              (op as any).who,
            );
          }
          break;
        }
        case "transfer": {
          const bal = balance((op as any).from);
          if (bal > 0n) {
            const amount = BigInt((op as any).amount) % bal || bal;
            simnet.callPublicFn(
              POOL,
              "transfer",
              [
                Cl.uint(amount),
                Cl.principal((op as any).from),
                Cl.principal((op as any).to),
                Cl.none(),
              ],
              (op as any).from,
            );
          }
          break;
        }
      }

      // Invariants must hold after every operation.
      expect(checkInvariant("invariant-solvency"), `solvency after op ${i} ${(op as any).k}`).toBe(true);
      expect(
        checkInvariant("invariant-supply-assets-coupled"),
        `coupling after op ${i} ${(op as any).k}`,
      ).toBe(true);
    }
  });
});
