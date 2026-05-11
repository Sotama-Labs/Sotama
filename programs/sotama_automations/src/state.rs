use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::events::AutomationFinished;

pub const MIN_AMOUNT_LAMPORTS: u64 = 1_000_000;

/// Action kind discriminators emitted in events. Match the order of
/// `ActionSpec` variants so a single `as u8` cast on the discriminator
/// would line up — but we use named constants to keep the wire format
/// independent of variant ordering.
pub mod action_kind {
    pub const TRANSFER_SOL: u8 = 0;
    pub const TRANSFER_SPL: u8 = 1;
    pub const SWAP: u8 = 4;
}

/// Trigger kind discriminators emitted in events.
pub mod trigger_kind {
    pub const ACCOUNT_ACTIVITY: u8 = 0;
    pub const ASSET_PRICE: u8 = 1;
    pub const TIME_ELAPSED: u8 = 2;
}

/// Hard ceiling on `TimeElapsed.duration_secs`. ~366 days — long enough
/// for any human-scale schedule, short enough to make a misconfigured
/// year-long timer obvious at create time. Stored as `u32` so the
/// trigger costs 4 bytes (well under the AssetPrice variant's 79 bytes,
/// so InitSpace is unaffected).
pub const MAX_TIME_ELAPSED_SECS: u32 = 366 * 24 * 60 * 60;

/// Comparator codes for `AssetPrice` triggers. Stored as u8 because Anchor
/// IDL doesn't expose enums-with-data plus simple enums in a single account
/// without name collisions on every variant.
pub mod comparator {
    pub const BELOW: u8 = 0;
    pub const ABOVE: u8 = 1;
}

/// Oracle source codes for `AssetPrice` triggers. The on-chain program
/// itself doesn't read prices — the keeper does — but the byte tells the
/// keeper which adapter to dispatch to. Hot-swappable: adding a new
/// provider is one constant + one keeper-side adapter, no schema change.
pub mod oracle_source {
    /// `feed` = 32-byte Pyth feed id (Hermes pull / Lazer stream).
    pub const PYTH: u8 = 0;
    /// `feed` = SPL mint pubkey; keeper polls Jupiter Price API v3
    /// (covers tokens that don't have a Pyth feed).
    pub const JUPITER: u8 = 1;
    // Reserved for future adapters: SWITCHBOARD = 2, CHAINLINK = 3, …
    /// Highest known source. `validate()` rejects anything above this so
    /// the keeper never has to handle unknown bytes.
    pub const MAX: u8 = JUPITER;
}

/// Sub-kind for `AccountActivity`. The on-chain program does not
/// distinguish between transfer and swap detection — the keeper does — but
/// storing the kind lets the indexer route the right subscriber.
pub mod account_kind {
    pub const TRANSFER: u8 = 0;
    pub const SWAP: u8 = 1;
}

/// Cadence kind discriminators. Used for `AutomationCreated` events so
/// indexers can render the right control-flow icon without re-fetching.
pub mod cadence_kind {
    pub const ONCE: u8 = 0;
    pub const REPEAT: u8 = 1;
    pub const UNTIL: u8 = 2;
}

/// Maximum lamports a single `execute_link_fee_debit` ix may transfer
/// from a linked rule's PDA to the keeper. Caps the keeper's authority
/// so a misconfigured fee can't drain a PDA. 0.001 SOL = 200× the
/// default 5_000 lamport per-fire fee, leaving plenty of headroom.
pub const MAX_LINK_FEE_LAMPORTS: u64 = 1_000_000;

/// Hard ceiling on `Config.swap_fee_bps`. 100 bps = 1%. Stops a
/// misconfigured admin update from taxing swaps above any reasonable
/// protocol rate — the launch rate is 10 bps (0.1%).
pub const MAX_SWAP_FEE_BPS: u16 = 100;

/// Hard ceiling on `Config.time_fee_lamports_per_day`. 0.01 SOL/day =
/// 0.3 SOL per 30-day uncapped rule. The launch rate is 300_000
/// (0.0003 SOL/day); this cap is 33× headroom so a future repricing
/// has room without an upgrade, while keeping a misconfigured value
/// from making rule creation prohibitive.
pub const MAX_TIME_FEE_LAMPORTS_PER_DAY: u64 = 10_000_000;

/// Default protocol fee on every `execute_swap`. Charged on the output
/// amount delivered to the user and routed to `Config.treasury`. 10 bps
/// = 0.1%.
pub const DEFAULT_SWAP_FEE_BPS: u16 = 10;

/// Default protocol time fee per day of rule lifetime. 300_000 lamports
/// = 0.0003 SOL/day. Charged upfront at create time and credited to the
/// keeper's wallet to fund its tx-fee budget. Rules without a bounded
/// lifetime (`Cadence::Once` / `Cadence::Repeat`) pay `30 * this` as a
/// flat ceiling.
pub const DEFAULT_TIME_FEE_LAMPORTS_PER_DAY: u64 = 300_000;

/// Maximum days a single rule is charged for at create time. Rules with
/// `Cadence::Until { unix_deadline }` shorter than 30 days pay
/// proportionally less; rules with no bounded lifetime pay this many
/// days at the current `time_fee_lamports_per_day` rate.
pub const TIME_FEE_MAX_DAYS: u64 = 30;

/// Seconds per day. Pulled out so the `compute_time_fee` math is
/// readable.
const SECS_PER_DAY: i64 = 86_400;

/// Compute the upfront time fee a `create_automation_*` ix charges.
/// Returns lamports owed by `owner` to the keeper.
///
/// Duration source:
///   * `Cadence::Until { unix_deadline }` → bounded lifetime, charged
///     for `ceil((deadline - now) / SECS_PER_DAY)` days, capped at
///     `TIME_FEE_MAX_DAYS`. A deadline within 1 day still pays 1 day.
///   * `Cadence::Once` and `Cadence::Repeat` → unbounded lifetime,
///     charged for `TIME_FEE_MAX_DAYS` flat.
///
/// Saturating arithmetic throughout so an absurd `lamports_per_day`
/// can't overflow into a wrap-around-cheap fee.
pub fn compute_time_fee(cadence: &Cadence, now: i64, lamports_per_day: u64) -> u64 {
    let days = match cadence {
        Cadence::Until { unix_deadline } => {
            let delta = unix_deadline.saturating_sub(now);
            if delta <= 0 {
                // Defensive: create_automation also rejects past
                // deadlines, but if a near-zero gap slips through we
                // still charge for at least one day.
                1u64
            } else {
                let ceil_days = ((delta as i128).saturating_add(SECS_PER_DAY as i128 - 1)
                    / SECS_PER_DAY as i128) as u64;
                ceil_days.min(TIME_FEE_MAX_DAYS)
            }
        }
        Cadence::Once | Cadence::Repeat { .. } => TIME_FEE_MAX_DAYS,
    };
    days.saturating_mul(lamports_per_day)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub enum TriggerSpec {
    /// Watched-account activity (transfer or swap). Detected off-chain by
    /// the keeper. The on-chain program trusts the keeper signer.
    AccountActivity {
        account: Pubkey,
        /// `Some(mint)` to filter to a specific SPL mint, `None` for any token.
        mint: Option<Pubkey>,
        /// `account_kind::TRANSFER` or `account_kind::SWAP`.
        kind: u8,
    },
    /// Price crossing on any oracle-supported asset (SPL token, equity, FX,
    /// commodity, index, …). The on-chain program is oracle-agnostic — the
    /// keeper picks an adapter based on `source` and resolves `feed`
    /// accordingly:
    ///
    ///   * `source = oracle_source::PYTH` — `feed` is a 32-byte Pyth feed
    ///     id (Hermes pull or Lazer stream). Threshold semantics follow
    ///     Pyth's wire format (typically `expo = -8`, e.g.
    ///     `threshold = 18_000_000_000` for $180.00).
    ///   * `source = oracle_source::JUPITER` — `feed` is an SPL mint
    ///     pubkey. The keeper polls Jupiter Price API v3 for that mint.
    ///     Threshold is in USD at `expo = -6` (Jupiter's native quote scale).
    ///
    /// The threshold semantic also depends on `quote_mint`:
    ///   * `quote_mint = None`  — single-feed comparison (base USD price).
    ///   * `quote_mint = Some(M)` — compare `base_price / quote_price`,
    ///     where the keeper resolves the quote price via a Jupiter `/quote`
    ///     probe of `M → USDC`. `threshold` and `expo` then express the
    ///     ratio scale (e.g. `expo = -6`, `threshold = 990_000` for `0.99`).
    ///     Only meaningful when the base asset is itself an SPL token; non-
    ///     token assets must be quoted in USD.
    AssetPrice {
        /// 32-byte feed identifier. Interpretation depends on `source`:
        /// Pyth feed id (PYTH), SPL mint (JUPITER), …
        feed: Pubkey,
        /// Optional quote mint. `None` denominates in USD (single-feed
        /// price). `Some(spl_mint)` makes this a base/quote comparison;
        /// the keeper probes Jupiter for the quote mint's USDC price
        /// at evaluation time.
        quote_mint: Option<Pubkey>,
        /// `comparator::BELOW` or `comparator::ABOVE`.
        comparator: u8,
        /// Threshold value scaled to `10^expo`.
        threshold: i64,
        /// Decimal exponent applied to the threshold. Must be ≤ 0.
        expo: i32,
        /// `oracle_source::PYTH`, `oracle_source::JUPITER`, … The keeper
        /// dispatches to the matching adapter; on-chain is oracle-agnostic.
        source: u8,
    },
    /// Wall-clock delay since `Automation.created_at`. The keeper's
    /// `time_watcher` ticks every minute, scans the active set for
    /// rules where `now >= created_at + duration_secs`, and fires them.
    /// No watched feed, no oracle dispatch — purely a clock check.
    /// Combined with `Cadence::Once` to mean "fire 5 minutes after I
    /// create this rule"; other cadences are blocked client-side
    /// because they don't read naturally with a one-shot timer.
    TimeElapsed {
        /// Seconds to wait after `Automation.created_at`. Capped at
        /// `MAX_TIME_ELAPSED_SECS` (~366 days) by `validate()`.
        duration_secs: u32,
    },
    /// Fire when the trigger's base mint USD price has moved relative to the
    /// effective fill price of an upstream automation. The keeper handles the
    /// price comparison; on-chain only stores the parameters.
    PriceRelativeToFill {
        /// Pubkey of the upstream automation whose `AutomationFilled` event
        /// established the cost basis.
        upstream: Pubkey,
        /// 0 = drop_below_fill (price <= fill * (1 - pct_bps/10000)).
        /// 1 = grow_above_fill (price >= fill * (1 + pct_bps/10000)).
        direction: u8,
        /// Percent threshold in basis points. 100 = 1%, 500 = 5%, etc.
        pct_bps: u32,
    },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub enum ActionSpec {
    /// Native SOL transfer from the automation PDA → destination.
    TransferSol {
        destination: Pubkey,
        amount: u64,
    },
    /// SPL token transfer from the automation PDA's ATA → destination's ATA.
    /// Both ATAs must be passed in as remaining accounts at execute time.
    TransferSpl {
        destination: Pubkey,
        mint: Pubkey,
        amount: u64,
    },
    /// Swap `amount_in` of `input_mint` for at least `min_amount_out` of
    /// `output_mint` via Jupiter v6, with the resulting tokens landing in
    /// `destination`'s ATA for `output_mint`.
    ///
    /// Routing is handled entirely off-chain by the keeper: it queries
    /// Jupiter's `/build` API at execute time, gets a `swapInstruction`,
    /// and relays it through Sotama's `execute_swap` for PDA-signed
    /// invocation. This program is DEX-agnostic — Jupiter aggregates
    /// across every Solana DEX.
    ///
    /// On-chain invariants verified at execute time:
    ///   • input mint of the PDA's input ATA matches `input_mint`
    ///   • output mint of the destination ATA matches `output_mint`
    ///   • destination ATA's owner matches `destination`
    ///   • the relayed inner ix targets the Jupiter v6 program ID
    ///   • post-CPI output balance increased by ≥ `min_amount_out`
    ///
    /// Linked-rule auto-deposit: when `linked_downstream` is `Some(B)`,
    /// after the swap CPI succeeds the handler also transfers
    /// `link_fee_deposit` lamports from this PDA to B's PDA. That
    /// prepays B's next fire and lets a chain perpetuate itself as long
    /// as the round-trip is profitable. Set both to `None`/`0` for a
    /// standalone swap.
    Swap {
        input_mint: Pubkey,
        output_mint: Pubkey,
        destination: Pubkey,
        amount_in: u64,
        min_amount_out: u64,
        /// Optional downstream automation PDA that receives the
        /// auto-deposit fee after this swap fires. The downstream PDA
        /// must be passed as the LAST remaining account at execute time.
        linked_downstream: Option<Pubkey>,
        /// Lamports prepaid to the downstream rule per fire of this
        /// rule. Capped on-chain at `MAX_LINK_FEE_LAMPORTS`.
        link_fee_deposit: u64,
        /// Keeper-side flag for inverted-pair chain links. When true, the
        /// keeper resolves `amount_in` at fire time from the PDA's input
        /// ATA balance and ignores the field above. The program never
        /// reads this — `amount_in` is informational at this layer (see
        /// execute_swap.rs).
        consume_upstream_output: bool,
    },
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub paused: bool,
    pub automation_count: u64,
    pub bump: u8,
    /// Destination for the swap protocol fee and the rent refund on
    /// close. Initialized to `admin` at config-create time; rotatable
    /// via `update_treasury`. Kept separate from `admin` so a treasury
    /// rotation doesn't require a fresh upgrade-authority key.
    pub treasury: Pubkey,
    /// Protocol fee on every `execute_swap`, in basis points of the
    /// delivered output amount. Charged from the user's output ATA to
    /// the treasury's output ATA after the slippage check. Capped at
    /// `MAX_SWAP_FEE_BPS` by `update_swap_fee_bps`. Default 10 bps
    /// (0.1%).
    pub swap_fee_bps: u16,
    /// Protocol time fee in lamports of SOL per day of rule lifetime.
    /// Charged upfront at `create_automation_*` time, transferred from
    /// the owner to the keeper's wallet (to fund tx fees). Rules with
    /// `Cadence::Until { unix_deadline }` pay
    /// `ceil((deadline - now) / 86_400)` days, capped at
    /// `TIME_FEE_MAX_DAYS`. `Cadence::Once` and `Cadence::Repeat` have
    /// no bounded lifetime so they pay the cap (30 days) flat.
    /// Capped at `MAX_TIME_FEE_LAMPORTS_PER_DAY` by
    /// `update_time_fee_per_day`. Default 300_000 (0.0003 SOL/day).
    pub time_fee_lamports_per_day: u64,
    /// Terminal kill-switch flag. Once true:
    ///   * `execute_*` and `create_automation_*` revert
    ///   * `update_treasury`, `update_swap_fee_bps`,
    ///     `update_time_fee_per_day`, `update_admin`,
    ///     `migrate_config` revert
    ///   * `admin_close_automation*` becomes callable (admin OR owner
    ///     signs; deposit → owner, all other lamports → treasury)
    /// One-way: `set_shutdown` itself rejects when already true. The
    /// flag exists to bound a compromised-admin blast-radius post-
    /// shutdown — once set, the only thing the admin can still do is
    /// accelerate user-PDA closures and rotate the keeper (harmless
    /// since execute_* are blocked).
    pub shutdown: bool,
}

/// Control-flow over the action firing schedule. Maps 1:1 to the UI's
/// If/For/While selector.
///
///  * `Once`  — fire one time when the trigger is satisfied. Terminal
///    after the first fire (matches v2's original single-shot behavior).
///  * `Repeat { total }` — fire up to `total` times in total. The
///    automation becomes terminal once `executions == total`.
///  * `Until { unix_deadline }` — fire repeatedly while
///    `now < unix_deadline`. After the deadline, the next attempted fire
///    becomes terminal without executing.
///
/// Both repeating cadences honor `min_interval_secs` between consecutive
/// fires, so the keeper can't compress a `Repeat { total: 10 }` into a
/// burst of 10 transactions in a single second.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub enum Cadence {
    Once,
    Repeat { total: u32 },
    Until { unix_deadline: i64 },
}

impl Cadence {
    pub fn validate(&self) -> Result<()> {
        match self {
            Cadence::Once => Ok(()),
            Cadence::Repeat { total } => {
                require!(*total >= 1, SotamaError::BadCadence);
                Ok(())
            }
            Cadence::Until { unix_deadline } => {
                require!(*unix_deadline > 0, SotamaError::BadCadence);
                Ok(())
            }
        }
    }

    pub fn kind_byte(&self) -> u8 {
        match self {
            Cadence::Once => cadence_kind::ONCE,
            Cadence::Repeat { .. } => cadence_kind::REPEAT,
            Cadence::Until { .. } => cadence_kind::UNTIL,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Automation {
    pub owner: Pubkey,
    pub nonce: u64,
    pub trigger: TriggerSpec,
    pub action: ActionSpec,
    /// Cadence/loop semantics chosen by the user (If/While/For in the UI).
    pub cadence: Cadence,
    /// Number of times this automation has fired. Increments on every
    /// successful execute_*. Used by the program to enforce
    /// `Cadence::Repeat { total }` and surfaced in the UI as the run count.
    pub executions: u32,
    /// Minimum seconds between consecutive fires. `0` means no floor.
    /// Always enforced when `executions > 0`, regardless of cadence.
    pub min_interval_secs: u32,
    /// Set true when the automation reaches its terminal state — either
    /// after a `Once` fire, after `executions == total` for `Repeat`, or
    /// when the keeper attempts a fire past `unix_deadline` for `Until`.
    /// Once set, further execute_* calls return `AutomationFinished`.
    pub finished: bool,
    pub created_at: i64,
    pub executed_at: i64,
    pub bump: u8,
    /// Per-automation opt-in for `execute_fee_topup`. False by default
    /// so a leaked keeper signing key cannot route arbitrary token
    /// holdings through Jupiter. Only set true at create time on Swap
    /// rules where the user explicitly enables auto-fee-management.
    /// Carved out of the original 32-byte `_reserved` budget: 2 bytes
    /// (one for fee_topup_enabled, one for bridge_enabled below). Update
    /// this comment if more bytes get carved.
    pub fee_topup_enabled: bool,
    /// Per-PDA opt-in for `execute_bridge`. Authorizes the keeper to
    /// route any non-input-mint token holdings of this PDA through
    /// Jupiter into the input mint, with `min_amount_out` slippage
    /// guard enforced on-chain. Set at create time by the chain
    /// classifier when the upstream link is `bridge_required`.
    pub bridge_enabled: bool,
    /// Reserved bytes for forward-compatible field additions. Lets a
    /// future v5 add small fields via `realloc` without forcing a
    /// fresh program ID (which v3→v4 already required). Was [u8; 32];
    /// shrunk to 30 to make room for `fee_topup_enabled` and
    /// `bridge_enabled` above.
    pub _reserved: [u8; 30],
}

impl Automation {
    /// Returns the destination wallet declared by the action, if the
    /// action transfers value out. Used by the close ix to reject closing
    /// an automation in flight (although the v2 program is single-shot
    /// and `executed` already gates this).
    pub fn action_destination(&self) -> Option<Pubkey> {
        match &self.action {
            ActionSpec::TransferSol { destination, .. } => Some(*destination),
            ActionSpec::TransferSpl { destination, .. } => Some(*destination),
            ActionSpec::Swap { destination, .. } => Some(*destination),
        }
    }

    /// Returns `true` if this automation's `Until`-cadence deadline has
    /// passed and it has not yet been marked finished. When this returns
    /// `true`, the caller **must** set `self.finished = true` and emit
    /// `AutomationFinished` before returning `Ok(())` — the automation is
    /// terminal but no action should fire.
    ///
    /// Returns `false` for any non-`Until` cadence, or for an automation
    /// that is already finished, or for an `Until` whose deadline has not
    /// yet elapsed.
    pub fn is_until_expired(&self, now: i64) -> bool {
        if self.finished {
            return false;
        }
        match self.cadence {
            Cadence::Until { unix_deadline } => now > unix_deadline,
            _ => false,
        }
    }

    /// If the `Until` deadline has passed (and this automation is not yet
    /// finished), marks it finished, emits `AutomationFinished{reason:0}`,
    /// and returns `Ok(true)` — the caller should `return Ok(())` without
    /// executing the action. Returns `Ok(false)` for all other cases so
    /// the caller can proceed normally.
    ///
    /// Encapsulates the three-step until-expiry prologue that was previously
    /// duplicated across `execute_automation`, `execute_automation_spl`, and
    /// `execute_swap`.
    pub fn handle_until_expiry(&mut self, key: Pubkey, now: i64) -> Result<bool> {
        if self.is_until_expired(now) {
            self.finished = true;
            emit!(AutomationFinished {
                automation: key,
                reason: 0, // terminal — Until deadline reached
            });
            return Ok(true);
        }
        Ok(false)
    }

    /// Pre-flight check before executing an action. Run by every
    /// `execute_*` handler so the gating logic stays in one place.
    /// Returns `Err` if the automation must not fire right now;
    /// otherwise returns `Ok(())` and the caller proceeds with the CPI.
    ///
    /// Two things are enforced:
    ///   1. The automation isn't already finished.
    ///   2. `min_interval_secs` has elapsed since the last fire.
    ///
    /// Note: `Until`-cadence deadline expiry is handled *before* this call
    /// in each execute handler (via `is_until_expired`), so this function
    /// never sees an expired-deadline `Until` automation. `DeadlineExpired`
    /// is kept for any future cadence that carries a hard deadline and
    /// should still surface as an error rather than a silent terminal fire.
    pub fn check_can_fire(&mut self, now: i64) -> Result<()> {
        require!(!self.finished, SotamaError::AutomationFinished);

        if self.executions > 0 && self.min_interval_secs > 0 {
            let earliest = self
                .executed_at
                .saturating_add(self.min_interval_secs as i64);
            require!(now >= earliest, SotamaError::MinIntervalNotElapsed);
        }

        Ok(())
    }

    /// Post-CPI bookkeeping. Increment the run count, stamp the time,
    /// and set `finished` if the cadence bound is now exhausted.
    /// Always called *after* the action CPI succeeded.
    pub fn advance(&mut self, now: i64) {
        self.executions = self.executions.saturating_add(1);
        self.executed_at = now;

        match self.cadence {
            Cadence::Once => {
                self.finished = true;
            }
            Cadence::Repeat { total } => {
                if self.executions >= total {
                    self.finished = true;
                }
            }
            Cadence::Until { unix_deadline } => {
                // The next attempt past the deadline will mark finished
                // via check_can_fire; we don't pre-emptively flip it here
                // so that a fire on the deadline boundary still counts.
                let _ = unix_deadline;
            }
        }
    }

}

impl TriggerSpec {
    /// Sanity-check the encoded byte fields on a TriggerSpec. Always run
    /// at create time so on-chain triggers can never have unrepresentable
    /// comparator/kind/mode bytes.
    pub fn validate(&self) -> Result<()> {
        match self {
            TriggerSpec::AccountActivity { kind, .. } => {
                require!(
                    *kind == account_kind::TRANSFER || *kind == account_kind::SWAP,
                    SotamaError::BadAccountKind
                );
            }
            TriggerSpec::AssetPrice {
                feed,
                quote_mint,
                comparator: c,
                expo,
                source,
                ..
            } => {
                require!(
                    *c == comparator::BELOW || *c == comparator::ABOVE,
                    SotamaError::BadComparator
                );
                require!(*expo <= 0, SotamaError::BadPythExpo);
                require!(*source <= oracle_source::MAX, SotamaError::BadOracleSource);
                // Quote mint must differ from the base feed pubkey to
                // ensure the comparison isn't trivially constant. We
                // compare bytes only; the feed is a 32-byte hex while
                // the mint is an SPL pubkey, so collisions are
                // effectively impossible — but still cheap to assert.
                if let Some(qm) = quote_mint {
                    require!(qm != feed, SotamaError::BadComparator);
                }
            }
            TriggerSpec::TimeElapsed { duration_secs } => {
                require!(*duration_secs > 0, SotamaError::BadCadence);
                require!(
                    *duration_secs <= MAX_TIME_ELAPSED_SECS,
                    SotamaError::BadCadence
                );
            }
            TriggerSpec::PriceRelativeToFill { direction, .. } => {
                // Only two direction codes are defined: 0 = drop_below_fill,
                // 1 = grow_above_fill. Anything else is rejected at create
                // time so the keeper never has to handle unknown bytes.
                require!(*direction <= 1, SotamaError::BadComparator);
            }
        }
        Ok(())
    }

    /// Single-byte discriminator used in `AutomationCreated` events.
    pub fn kind_byte(&self) -> u8 {
        match self {
            TriggerSpec::AccountActivity { .. } => trigger_kind::ACCOUNT_ACTIVITY,
            TriggerSpec::AssetPrice { .. } => trigger_kind::ASSET_PRICE,
            TriggerSpec::TimeElapsed { .. } => trigger_kind::TIME_ELAPSED,
            // 3 is the next unallocated discriminator after TIME_ELAPSED(2).
            TriggerSpec::PriceRelativeToFill { .. } => 3,
        }
    }

    /// Primary watched/feed pubkey, surfaced in events for indexers.
    /// `TimeElapsed` triggers have no watched target — return the
    /// default (32 zero bytes) so indexers can detect "no target"
    /// without a separate field.
    pub fn primary_pubkey(&self) -> Pubkey {
        match self {
            TriggerSpec::AccountActivity { account, .. } => *account,
            TriggerSpec::AssetPrice { feed, .. } => *feed,
            TriggerSpec::TimeElapsed { .. } => Pubkey::default(),
            // Surface the upstream automation pubkey so indexers can
            // link this trigger's event to the upstream fill event.
            TriggerSpec::PriceRelativeToFill { upstream, .. } => *upstream,
        }
    }
}

impl ActionSpec {
    pub fn kind_byte(&self) -> u8 {
        match self {
            ActionSpec::TransferSol { .. } => action_kind::TRANSFER_SOL,
            ActionSpec::TransferSpl { .. } => action_kind::TRANSFER_SPL,
            ActionSpec::Swap { .. } => action_kind::SWAP,
        }
    }
}
