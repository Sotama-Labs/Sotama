# sotama-keeper

Off-chain executor for the Sotama on-chain program. Indexes active automations, watches their triggers, and submits the right execute instruction when a trigger fires.

The keeper signs transactions on behalf of the program, but the on-chain program enforces ownership, destination, slippage, and cadence on every fire. A compromised keeper signing key cannot redirect funds.

## Modules

```
config.rs         Reads env, picks the cluster, wires RPC + WS + Sender +
                  Hermes + Jupiter URLs, loads the signer.

state.rs          Borsh mirrors of the on-chain Automation, TriggerSpec,
                  ActionSpec, and Cadence types. Stays in lockstep with
                  programs/sotama_automations/src/state.rs.

indexer.rs        Calls getProgramAccounts every RECONCILE_INTERVAL_SECS,
                  groups active automations by trigger kind, broadcasts the
                  set via tokio::sync::watch.

shard.rs          Splits the watched-account set into shards of at most
                  SHARD_SIZE (Helius Atlas accountInclude limit is 50;
                  default 40).

subscriber.rs     One tokio task per shard. Connects to Helius
                  transactionSubscribe and forwards trigger events into a
                  bounded mpsc channel. Reconnects with backoff and respawns
                  whenever the indexer publishes a changed set.

price_watcher.rs  Polls Pyth Hermes every PRICE_POLL_INTERVAL_SECS. For
                  PriceRatio triggers (quote_mint = Some), it also probes
                  Jupiter /quote against USDC and compares the ratio with
                  cross-multiplication so there is no float drift at the
                  threshold.

signer.rs         Two implementations behind one trait. TurnkeySigner is
                  the prod path: every signature is a P-256-stamped POST
                  to Turnkey's sign_raw_payload endpoint. LocalKeypairSigner
                  is the dev fallback that reads a Solana keypair JSON.
                  Picked from env at startup.

executor.rs       Drains the trigger channel. Per event, sorts matches by
                  (created_at, nonce) so the oldest rule fires first, then
                  processes them sequentially. Builds the right execute_*
                  instruction (with Jupiter /build for Swap actions),
                  fetches a priority fee, signs via the configured signer,
                  and submits via Helius Sender.

revalidate.rs     Mid-queue trigger re-evaluation. Between fires within the
                  same event, the executor calls revalidate() to confirm
                  the condition still holds. AssetPrice re-polls Pyth (and
                  Jupiter for non-USD quotes); AccountActivity always
                  passes since the watched event already happened. A
                  false return skips the rest of the batch.

program.rs        Anchor instruction builders for the execute_* family,
                  plus PDA derivation helpers.

jupiter.rs        HTTP client for Jupiter v6 /quote and /build. Parses the
                  returned inner instruction's account list, locates the
                  input and output ATA indices, and decodes the inner ix
                  data so execute_swap can replay it under the PDA.

types.rs          AutomationCtx (the executor's snapshot of an active
                  rule) and TriggerEvent (the message shipped over the
                  trigger channel).

main.rs           Loads config, seeds the indexer, spawns the watcher
                  tasks (indexer, subscriber, price_watcher, lazer
                  optional, jupiter, executor), awaits ctrl-c.
```

## Cross-user queue ordering

When two or more rules match the same trigger event, they fire one at a time in `(created_at, nonce)` order. The keeper re-checks the trigger condition between fires and skips later users if it no longer holds. So if SOL crosses below $100 and ten users have a "below $100" rule, the oldest fires first, and if the price snaps back above $100 before user three's transaction lands, users three through ten are skipped.

## Run locally (devnet)

```bash
solana-keygen new -o keeper-keypair.json --no-bip39-passphrase

# On-chain Config.keeper must match this pubkey. Run
# `pnpm anchor:initialize:devnet` from the workspace root if Config
# is not initialized yet, or rotate via update_keeper.

cp .env.example .env
# Set HELIUS_API_KEY, PROGRAM_ID, and KEEPER_KEYPAIR_PATH.
# Leave TURNKEY_* blank to use the local-keypair signer.

cargo run --release
```

Healthy startup:

```
INFO sotama_keeper: sotama-keeper starting cluster="devnet" program_id=...
INFO sotama_keeper: indexer: seeded initial active automations active=N
INFO sotama_keeper::subscriber: shard: subscribed shard=0
```

## Run on Fly.io

Production deploys live in a separate Fly app per cluster (`sotama-keeper-devnet`, `sotama-keeper-mainnet`). Signing routes through Turnkey: the binary reads the Turnkey API credentials from Fly secrets and posts each signature request to Turnkey's HSM-backed signer. No Solana private key ever sits on the machine. The setup runbook is internal.

## Env vars

Required for any deployment:

| Var | Purpose |
|---|---|
| `CLUSTER` | `devnet` or `mainnet-beta`. Drives URL family selection. Default `devnet`. |
| `HELIUS_API_KEY` | Helius dashboard key. Appended to RPC, WS, and Sender URLs. |
| `PROGRAM_ID` | Deployed `sotama_automations` program pubkey. |

Required when signing via Turnkey (production):

| Var | Purpose |
|---|---|
| `TURNKEY_API_PUBLIC_KEY` | Turnkey API user public key (compressed P-256, hex). Presence of this var picks the Turnkey signer over the local-keypair fallback. |
| `TURNKEY_API_PRIVATE_KEY` | Stamper private key (hex). Used to sign Turnkey API requests, not Solana txs. |
| `TURNKEY_ORGANIZATION_ID` | Turnkey org id. |
| `TURNKEY_PRIVATE_KEY_ID` | Turnkey id of the Solana ed25519 key that signs Sotama transactions. |
| `KEEPER_PUBKEY` | Solana pubkey for `TURNKEY_PRIVATE_KEY_ID`. Cached at boot so each fire skips a Turnkey round trip just to discover its own pubkey. |

Required when signing via local keypair (development):

| Var | Purpose |
|---|---|
| `KEEPER_KEYPAIR_PATH` | Path to a Solana keypair JSON. Used only when `TURNKEY_API_PUBLIC_KEY` is unset. |

Optional tuning (defaults are sensible):

| Var | Default | Purpose |
|---|---|---|
| `RECONCILE_INTERVAL_SECS` | `60` | indexer tick. |
| `PRICE_POLL_INTERVAL_SECS` | `12` | price_watcher tick. |
| `SHARD_SIZE` | `40` | accounts per transactionSubscribe shard. |
| `SWAP_SLIPPAGE_BPS` | `50` | Jupiter slippage for action swaps and price-ratio quote probes. |
| `KEEPER_FEE_LAMPORTS` | `5000` | per-fire link fee for downstream-of-link automations. |
| `PYTH_HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes endpoint. |
| `JUPITER_BASE_URL` | `https://api.jup.ag` | Jupiter v6 API base. |
| `RUST_LOG` | `info,sotama_keeper=debug` | tracing filter. |
| `HELIUS_DEVNET_*`, `HELIUS_MAINNET_*` | Helius public URLs | RPC, WS, and Sender base URLs per cluster. Override only if pinning to a private Helius region. |

See `src/config.rs` for the exhaustive list, including the fee-topup tunables.

## Logs

Tracing goes to stdout, filtered by `RUST_LOG`. Each fire prints the automation pubkey, the correlation id of the triggering event, and the resulting transaction signature.
