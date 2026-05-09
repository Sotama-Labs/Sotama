# Sotama

[sotama.xyz](https://sotama.xyz)

Sotama lets you set up automations on Solana. You write a rule like "if SOL drops below $100 then sell 1 SOL into USDC" or "every Friday move 0.5 SOL to my cold wallet", deposit funds into a PDA the program owns, and walk away. A keeper watches the conditions you specified and fires the action on chain when they hit.

The trust model is keeper-as-signer with on-chain invariants. The keeper signs the execute transaction, but the program enforces ownership, destination, slippage, and cadence on every fire, so a compromised keeper key cannot redirect funds.

## What you can build

- **Triggers**: watched-account activity, Pyth price thresholds (USD or ratio against another mint).
- **Actions**: SOL transfer, SPL transfer, Jupiter swap.
- **Control flow**: fire once, fire N times, fire repeatedly until a deadline. Loops respect a configurable minimum interval between fires.

## Architecture

```
       user
        |
        v
   Next.js app  ----------->  Anchor program  <-----------  Rust keeper
   (rule builder)              (on Solana)                  (on Fly.io)
                                                                 |
                                                                 v
                                                  Helius / Pyth / Jupiter / Turnkey
```

**Onchain (`programs/sotama_automations/`)** is an Anchor program. Each automation lives in its own PDA that owns the user's deposit. Every keeper-callable instruction checks the configured keeper signer, the cadence gate, and the action invariants (ATA mints, destination owner, slippage floor, Jupiter program id) before doing anything. There is a one-way kill switch on the Config that, once flipped, blocks all new fires and lets the admin run a wind-down that refunds deposits to users and routes the rent to a configured treasury.

**Keeper (`keeper/`)** is a long-running Rust binary. It indexes program accounts via Helius `getProgramAccounts`, subscribes to transaction events over WebSocket, and polls Pyth Hermes for price feeds. When a trigger fires it builds the right execute instruction, calls Jupiter's `/build` for swap routing if needed, and submits the transaction through Helius Sender. The signing key never sits on disk: every signature is a round trip to a Turnkey HSM.

**Frontend (`src/`)** is a Next.js app. The rule builder maps cleanly to the on-chain `TriggerSpec`, `ActionSpec`, and `Cadence` enums, so what you click is what gets stored.

When two or more users have rules that fire on the same condition in the same scan, the keeper queues them in deterministic order (oldest rule first, by `created_at` then `nonce`) and re-checks the trigger condition between fires. If the condition stops being satisfied, later users are skipped instead of fired against stale data.

## Repo layout

- `programs/sotama_automations/` Anchor program (Rust).
- `keeper/` off-chain executor (Rust, tokio, reqwest).
- `src/` frontend (Next.js, TypeScript).
- `tests/` Anchor integration tests (TypeScript, Mocha).
- `scripts/` operational helpers: devnet bootstrap, Turnkey policy generation, kill-switch wind-down, and the program-close pre-flight checker.
