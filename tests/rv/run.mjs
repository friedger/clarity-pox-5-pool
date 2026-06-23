#!/usr/bin/env node
// Reliable runner for the bootstrapped Rendezvous harness.
//
// Why not the `rv` bin directly? The bin crashes on a flaky unhandled
// "epoch field invalid" rejection on epoch-3.4 deployment plans; driving
// rendezvous `main()` via import (and clearing any stale plan first) avoids it.
// Usage: node tests/rv/run.mjs <test|invariant> [--runs N ...]
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Force a fresh deployment plan (regen) for the harness manifest.
await rm(join(here, "deployments", "default.simnet-plan.yaml"), { force: true });

const type = process.argv[2] ?? "invariant";
const rest = process.argv.slice(3);
process.argv = ["node", "rv", "tests/rv", "pool", type, ...rest];

const appPath = join(here, "..", "..", "node_modules", "@stacks", "rendezvous", "dist", "app.js");
const { main } = await import(appPath);
await main();
