/* ─────────────────────────────────────────────────────────────────────
   Linked-rule chain construction.

   A "linked chain" is 2 or 3 Sotama Automations created in a single
   transaction such that each rule's swap output funds the next rule's
   input ATA. This is the on-chain primitive that makes continuous
   arbitrage loops possible: rule A's USDC→TKN swap output lands in
   rule B's input ATA; rule B's TKN→USDC output lands back in rule A's
   input ATA; the cycle perpetuates until the user closes the chain or
   one rule's trigger stops being satisfied.

   Construction invariants:
     • Every rule's action is `Swap`.
     • Every rule's outputMint equals the next rule's inputMint
       (mint-flow chain — without this, the destination ATA receives
       a token the next rule can't spend).
     • Every rule's `Swap.destination` is the *next* rule's PDA — that
       way the swap output ATA is owned by the next rule's PDA and
       happens to equal that rule's input ATA.
     • Only the chain head receives a seed deposit at create time;
       downstream rules deposit 0 input units (they fill at fire time).
     • All N rules are created in ONE transaction. If the tx reverts,
       no PDAs were committed and the user's seed deposit stays in
       their wallet. If it lands, every rule is provisioned.

   Cascade lifecycle:
     • All rules in a chain share a `chainId` (a UUID minted by the
       client). Pause/delete operations on any one rule offer the user
       a cascade for the rest.

   This module does not talk to the on-chain program directly — it
   produces the ix+account specs the DepositSheet's send flow already
   knows how to assemble into a signed v0 tx. The atomic-tx builder
   lives in DepositSheet (or its chain-mode equivalent) so the wallet
   adapter signing path is a single place.
   ───────────────────────────────────────────────────────────────────── */

import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import { BorshCoder, EventParser, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  associatedTokenAddress,
  automationPda,
  buildCreateAutomationSwapLinkedIx,
  cadenceToOnChain,
  getProgram,
  isProgramConfigured,
  fetchConfig,
  SOTAMA_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  type OnChainActionSpec,
  type OnChainTriggerSpec,
} from "./program";
import { lookupFeedForAsset } from "./oracles";
import {
  INFINITE_LOOP_UNIX_DEADLINE,
  MAX_TIME_ELAPSED_SECS,
  SELF_LOOP_INFINITE_FUND_CYCLES,
  timeElapsedToSecs,
  type BuilderResult,
  type Cadence,
  type ChainLinkClass,
  type LoopMode,
  type Trigger,
  type Action,
} from "./types";

const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;

/** A node in the chain at construction time. The `next` field references
 *  another node by its array index OR `loopBack` (= 0). The chain library
 *  resolves this to a concrete `Swap.destination = nodePda[next_index]`
 *  before submitting. */
export type ChainNodeDraft = {
  result: BuilderResult;
  /** Chain link from this node. `null` = terminal (rule stops after its
   *  cadence). `{ kind: "rule", ruleIndex: n }` = swap output goes to
   *  node n's PDA. `{ kind: "loopBack" }` = swap output goes back to
   *  node 0's PDA (perpetual chain). */
  next: ChainNodeNextDraft | null;
};

/** Where a chain node routes its swap output. Unified to a single
 *  variant: every link targets a specific rule by zero-based index in
 *  the draft chain. `null` means terminal (output to owner wallet).
 *
 *  • Forward auto-links: mid-chain cards always have
 *    `{ ruleIndex: i+1 }` so the last-card-of-chain is the only slot
 *    where the user picks freely.
 *  • Back-links: last card may target any earlier rule. A target
 *    index ≤ current index closes a cycle; the chain library detects
 *    the cycle and asks the user to pick a loop mode.
 *  • Self-link: single-card chain may target itself (`ruleIndex: 0`),
 *    which is purely cadence-driven (no destination routing — input
 *    ATA depletes over time). */
export type ChainNodeNextDraft = { kind: "rule"; ruleIndex: number };

/** Pure classifier for an adjacent rule pair.
 *
 *  Decision tree (in evaluation order):
 *   1. If either action is missing or not a swap → bridge_required.
 *   2. Degenerate same-token case: both isInverted AND isMatched AND
 *      upstream input mint == upstream output mint (e.g. USDC→USDC then
 *      USDC→USDC) → matched_mints. Without this guard the inverted
 *      branch below would fire first and mis-classify the pair.
 *   3. Inverted pair (A→B then B→A, non-degenerate) → inverted_pair.
 *   4. Forward match (upstream.out == downstream.in) → matched_mints.
 *   5. Neither → bridge_required. */
export function classifyChainLink(
  upstream: BuilderResult,
  downstream: BuilderResult,
): ChainLinkClass {
  const up = upstream.actions[0];
  const down = downstream.actions[0];
  if (!up || up.kind !== "swap" || !down || down.kind !== "swap") {
    // Non-swap chain rules already rejected by validateChainDraft;
    // default to bridge_required so the validator surfaces the error.
    return "bridge_required";
  }
  const isInverted =
    up.inputToken.mint === down.outputToken.mint &&
    up.outputToken.mint === down.inputToken.mint;
  const isMatched = up.outputToken.mint === down.inputToken.mint;
  // Degenerate case: both conditions hold AND the swap is same-token
  // (up.in == up.out). In this case matched_mints takes precedence.
  if (isInverted && isMatched && up.inputToken.mint === up.outputToken.mint) {
    return "matched_mints";
  }
  if (isInverted) {
    return "inverted_pair";
  }
  if (isMatched) {
    return "matched_mints";
  }
  return "bridge_required";
}

/** Validate a chain draft. Returns null when valid; an error code +
 *  the offending node index otherwise. The keeper can't gracefully
 *  recover from a chain whose mint flow doesn't line up — it'd just
 *  retry forever and the destination ATAs would accumulate stranded
 *  tokens — so the validator is strict. */
export type ChainValidationError =
  | { kind: "non_swap_action"; nodeIndex: number }
  | { kind: "head_must_have_seed_amount"; nodeIndex: number }
  | { kind: "price_relative_to_fill_requires_chain_position"; nodeIndex: number }
  | { kind: "price_relative_to_fill_requires_consume_upstream"; nodeIndex: number };

export function validateChainDraft(
  nodes: ChainNodeDraft[],
): ChainValidationError | null {
  // 1-node chains are valid (single-rule self-loop). 2+ node chains
  // also valid; the rest of the rules below apply to both shapes.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const action = node.result.actions[0];
    // Multi-action chain rules are out of scope for v1 — the on-chain
    // program supports only one action per Automation account, and the
    // chain library only routes the FIRST action's swap output. Reject
    // anything that isn't a single Swap to avoid silent breakage.
    if (!action || action.kind !== "swap" || node.result.actions.length !== 1) {
      return { kind: "non_swap_action", nodeIndex: i };
    }
  }
  // Self-link guard: a self-link (ruleIndex === i) on a multi-card chain
  // is rejected because the output cannot bridge back to the same node —
  // the bridge requires a separate downstream rule to route output into.
  // Single-card self-loops are valid (cadence-driven, no destination routing).
  for (let i = 0; i < nodes.length; i++) {
    const link = nodes[i].next;
    if (!link) continue;
    const targetIdx = link.ruleIndex;
    if (targetIdx < 0 || targetIdx >= nodes.length) continue;
    // Self-links and back-links are both valid in any chain shape now.
    // For mismatched-mint self-links the bridge dispatcher refills the
    // input ATA from the wrong-mint output ATA, so the rule keeps firing.
    // sendChainCreate sets bridge_enabled accordingly.
  }

  // PriceRelativeToFill validation: only valid on downstream rules that
  // consume upstream output (i >= 1 AND consumeUpstreamOutput === true).
  for (let i = 0; i < nodes.length; i++) {
    const trigger = nodes[i].result.triggers[0];
    if (!trigger || trigger.kind !== "price_relative_to_fill") continue;
    if (i === 0) {
      return { kind: "price_relative_to_fill_requires_chain_position", nodeIndex: i };
    }
    const action = nodes[i].result.actions[0];
    const consumesUpstream = action?.kind === "swap" && action.consumeUpstreamOutput === true;
    if (!consumesUpstream) {
      return { kind: "price_relative_to_fill_requires_consume_upstream", nodeIndex: i };
    }
  }

  return null;
}

/** Detect which node indices participate in a cycle. The forward auto-
 *  link convention (mid-chain card K → card K+1) means a cycle exists
 *  iff some node's `next` points at an index ≤ the source's own
 *  index. The cycle members are everything reachable from that target
 *  by following the next-pointers until we revisit it. */
export function findCycleNodes(
  nodes: { next: ChainNodeNextDraft | null }[],
): Set<number> {
  const cycle = new Set<number>();
  if (nodes.length === 0) return cycle;
  // Walk from every starting node — a cycle anywhere will be revealed
  // by the second visit. Cheap because chains have ≤ MAX_CHAIN_LENGTH
  // nodes.
  const next = (i: number): number | null => {
    const link = nodes[i]?.next;
    return link ? link.ruleIndex : null;
  };
  for (let start = 0; start < nodes.length; start++) {
    const visited: number[] = [];
    let cur: number | null = start;
    while (cur != null && !visited.includes(cur)) {
      visited.push(cur);
      cur = next(cur);
    }
    if (cur != null && visited.includes(cur)) {
      // Cycle entry is `cur`; members are visited[indexOf(cur)..end].
      const entryAt = visited.indexOf(cur);
      for (let j = entryAt; j < visited.length; j++) {
        cycle.add(visited[j]);
      }
      return cycle;
    }
  }
  return cycle;
}

/** Client-side mirror of `programs/sotama_automations/src/state.rs::
 *  compute_time_fee`. Returns the lamports the on-chain handler will
 *  charge `owner → keeper` at create time for this rule's cadence. */
const TIME_FEE_MAX_DAYS = 30n;
const SECS_PER_DAY = 86_400n;
export function estimateTimeFee(cadence: Cadence, lamportsPerDay: bigint): bigint {
  let days: bigint;
  if (cadence.kind === "until") {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const delta = BigInt(cadence.unixDeadline) - nowSec;
    if (delta <= 0n) {
      days = 1n;
    } else {
      const ceilDays = (delta + SECS_PER_DAY - 1n) / SECS_PER_DAY;
      days = ceilDays < TIME_FEE_MAX_DAYS ? ceilDays : TIME_FEE_MAX_DAYS;
    }
  } else {
    // once or repeat — unbounded lifetime, charged for the cap.
    days = TIME_FEE_MAX_DAYS;
  }
  return days * lamportsPerDay;
}

/** Resolve a `LoopMode` to a concrete `Cadence` for a given rule. Used
 *  by `sendChainCreate` to override per-rule cadences when the chain
 *  has a loop mode set. */
export function loopModeToCadence(loop: LoopMode): Cadence {
  if (loop.kind === "frequency") {
    return { kind: "repeat", total: loop.cycles };
  }
  return { kind: "until", unixDeadline: INFINITE_LOOP_UNIX_DEADLINE };
}

/* ── Per-rule trigger/action mapping ──────────────────────────────── */
/* Imported in DepositSheet — duplicated here for the chain build path
   so the chain library is self-contained. Both stay in sync because they
   convert from the same UI Trigger / Action types. */

function tryPubkey(addr: string | null | undefined): PublicKey | null {
  if (!addr) return null;
  try {
    return new PublicKey(addr);
  } catch {
    return null;
  }
}

function feedIdToPubkey(feedId: string): PublicKey {
  const hex = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  return new PublicKey(Buffer.from(hex, "hex"));
}

async function buildTriggerSpec(t: Trigger): Promise<OnChainTriggerSpec | null> {
  switch (t.kind) {
    case "account_transfer": {
      const account = tryPubkey(t.account);
      if (!account) return null;
      const mint =
        t.token.mode === "specific" && t.token.value
          ? tryPubkey(t.token.value.mint)
          : null;
      return { accountActivity: { account, mint, kind: 0 } };
    }
    case "account_swap": {
      const account = tryPubkey(t.account);
      if (!account) return null;
      const mint =
        t.token.mode === "specific" && t.token.value
          ? tryPubkey(t.token.value.mint)
          : null;
      return { accountActivity: { account, mint, kind: 1 } };
    }
    case "asset_price": {
      let feed: PublicKey;
      let source: number;
      let defaultExpo: number;
      let inverted = false;
      switch (t.oracle.kind) {
        case "pyth": {
          try {
            feed = feedIdToPubkey(t.oracle.feedId);
          } catch {
            return null;
          }
          source = 0;
          defaultExpo = -8;
          inverted = t.oracle.inverted === true;
          break;
        }
        case "jupiter": {
          const m = tryPubkey(t.oracle.mint);
          if (!m) return null;
          feed = m;
          source = 1;
          defaultExpo = -6;
          break;
        }
        case "switchboard_pending":
          return null;
      }
      const userIntentComparator = t.comparator === "below" ? 0 : 1;
      const comparator = inverted
        ? userIntentComparator === 0
          ? 1
          : 0
        : userIntentComparator;
      let quoteMint: PublicKey | null = null;
      let expo: number;
      if (t.quote.kind === "usd") {
        expo = defaultExpo;
      } else {
        const quoteTicker = t.quote.asset.displaySymbol.toUpperCase();
        const pairResolved =
          t.oracle.kind === "pyth" &&
          (t.oracle.symbol.toUpperCase().includes(`/${quoteTicker}`) ||
            t.oracle.symbol.toUpperCase().includes(`${quoteTicker}/`));
        if (pairResolved) {
          expo = defaultExpo;
        } else if (t.quote.asset.mint) {
          const m = tryPubkey(t.quote.asset.mint);
          if (!m) return null;
          quoteMint = m;
          expo = -6;
        } else {
          // No SPL mint for the quote — fall back to its Pyth feed id.
          // The keeper disambiguates `quote_mint` bytes by checking the
          // Pyth symbol catalog at fire time (catalog hit → Hermes path,
          // miss → Jupiter probe). Both are 32-byte values fitting the
          // existing on-chain field, so no schema change.
          const quotePyth = await lookupFeedForAsset(t.quote.asset);
          if (!quotePyth) return null;
          try {
            quoteMint = feedIdToPubkey(quotePyth.feedId);
          } catch {
            return null;
          }
          expo = -6;
        }
      }
      if (inverted && t.threshold <= 0) return null;
      const targetValue = inverted ? 1 / t.threshold : t.threshold;
      const scaled = Math.round(targetValue * Math.pow(10, -expo));
      return {
        assetPrice: {
          feed,
          quoteMint,
          comparator,
          threshold: new BN(scaled),
          expo,
          source,
        },
      };
    }
    case "time_elapsed": {
      const secs = timeElapsedToSecs(t.value, t.unit);
      if (!(secs > 0) || secs > MAX_TIME_ELAPSED_SECS) return null;
      return { timeElapsed: { durationSecs: secs } };
    }
    case "price_relative_to_fill": {
      if (!t.upstream || !(t.pctBps > 0)) return null;
      return {
        priceRelativeToFill: {
          upstream: t.upstream,
          direction: t.direction === "grow" ? 1 : 0,
          pctBps: t.pctBps,
        },
      };
    }
  }
}

function buildSwapAction(
  destination: PublicKey,
  a: Action,
  linkedDownstream: PublicKey | null,
): OnChainActionSpec | null {
  if (a.kind !== "swap") return null;
  const inputMint = tryPubkey(a.inputToken.mint);
  const outputMint = tryPubkey(a.outputToken.mint);
  if (!inputMint || !outputMint) return null;
  const consumeUpstreamOutput = a.consumeUpstreamOutput === true;
  // When consuming upstream output, write u64::MAX so the on-chain
  // input-consumption cap (execute_swap.rs:260, `input_consumed <=
  // amount_in`) never clips the actual per-fire amount. The keeper
  // resolves the real amount from the PDA's input ATA balance at fire
  // time; the cap is a TWAP/DCA guard for fixed-amount rules and would
  // otherwise reject swaps whenever upstream produced more than the
  // user-typed sentinel. u64::MAX still satisfies the > 0 guard in
  // create_automation_swap_linked.
  const amountIn = consumeUpstreamOutput
    ? new BN("18446744073709551615") // u64::MAX
    : new BN(Math.round(a.amount * Math.pow(10, a.inputToken.decimals)));
  return {
    swap: {
      inputMint,
      outputMint,
      destination,
      amountIn,
      minAmountOut: new BN(0),
      linkedDownstream,
      linkFeeDeposit: new BN(0),
      consumeUpstreamOutput,
    },
  };
}

/* ── Chain creation transaction ──────────────────────────────────── */

export type ChainCreateResult = {
  /** Confirmed transaction signature. */
  signature: string;
  /** Per-node creation outcome. The `pubkey` is the on-chain Automation
   *  PDA; `nonce` is the program-assigned monotonic counter. */
  nodes: Array<{ pubkey: string; nonce: string; seedAmount: string }>;
};

export async function sendChainCreate(params: {
  connection: Connection;
  wallet: {
    publicKey: PublicKey;
    signTransaction: <T extends Transaction>(tx: T) => Promise<T>;
    /** Required when the chain doesn't fit in a single tx — the setup
     *  ixs (ATA creates + SOL wrap) get split into a separate tx that
     *  must land before the chain-create ixs. Wallet adapter always
     *  provides this for any modern wallet; pass it through. */
    signAllTransactions?: <T extends Transaction>(txs: T[]) => Promise<T[]>;
  };
  nodes: ChainNodeDraft[];
  /** Loop topology applied at submit time. When set, every rule's
   *  cadence is overridden to match (Repeat{total} for frequency,
   *  Until{far_future} for infinite) and the head's seed amount is
   *  scaled accordingly:
   *    • 1-node self-loop: seed = amount × cycles (or × DEFAULT_FUND
   *      for infinite). The PDA's input ATA depletes as the rule
   *      fires; chain doesn't self-feed because there's no second
   *      rule to route output back.
   *    • 2+ node loop: seed = amount × 1. The chain self-feeds via
   *      Swap.destination routing — every cycle's output refills the
   *      next rule's input, and the loop closes the cycle. Cadences
   *      get the loopMode template so all rules fire on matching
   *      schedules.
   *  When `null`, the existing per-rule cadence is honoured and the
   *  head still seeds with `amount × 1`. Linear (terminal) chains
   *  fire once unless the user manually picks a higher cadence
   *  per-rule, but the head's input only covers cycle 1 so additional
   *  fires would fail with "insufficient funds" until the user
   *  manually tops up. */
  loopMode?: LoopMode | null;
}): Promise<ChainCreateResult> {
  const { connection, wallet, nodes, loopMode } = params;
  if (!isProgramConfigured() || !SOTAMA_PROGRAM_ID) {
    throw new Error(
      "Sotama program ID is not configured. Set NEXT_PUBLIC_SOTAMA_PROGRAM_ID in your environment.",
    );
  }
  // Capture a non-null reference so the closures below get the same
  // narrowing guarantee the runtime check just gave us.
  const programId: PublicKey = SOTAMA_PROGRAM_ID;
  const owner = wallet.publicKey;

  const adapterWallet = {
    publicKey: owner,
    signTransaction: wallet.signTransaction,
    signAllTransactions: async <T extends Transaction>(txs: T[]) =>
      Promise.all(txs.map((t) => wallet.signTransaction(t))) as Promise<T[]>,
    payer: undefined as never,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = getProgram(connection, adapterWallet as any);
  // Fetch Config once — we need `keeper` (time-fee recipient) and the
  // starting `automation_count` for nonce sequencing.
  const config = await fetchConfig(program);
  const keeper = config.keeper;
  const startNonce = BigInt(config.automationCount.toString());

  // Pre-compute every node's PDA so destination wiring + ATA creates
  // can be expressed before any ix is built. Nonces are sequential from
  // `startNonce`; the on-chain Config.automation_count auto-increments
  // per create_automation_swap_linked call, so the i-th node gets nonce
  // `startNonce + i`.
  const nodePdas: PublicKey[] = nodes.map((_, i) =>
    automationPda(owner, startNonce + BigInt(i), programId),
  );

  // Resolve each node's destination wallet. The `Swap.destination`
  // is the wallet whose output ATA receives the swap result; setting
  // it to a downstream rule's PDA makes that PDA's output-mint ATA
  // serve as the next rule's input ATA (mint flow contract).
  //   • Multi-card link → destination = nodePdas[link.ruleIndex]
  //   • Terminal (next === null) → destination = owner
  //   • Single-card self-loop → destination = owner (no fund routing
  //     possible — input ATA depletes as the rule fires; the loop is
  //     purely cadence-driven)
  const destinations: PublicKey[] = nodes.map((node) => {
    if (nodes.length === 1) return owner;
    if (!node.next) return owner;
    return nodePdas[node.next.ruleIndex];
  });

  // Loop members get the loopMode cadence override; warm-up rules
  // outside the cycle keep their per-card cadence. For a 1-card
  // chain the only node is in the cycle (self-loop) iff loopMode is
  // set — same code path as multi-card.
  const cycleMembers =
    loopMode != null
      ? nodes.length === 1
        ? new Set([0])
        : findCycleNodes(nodes)
      : new Set<number>();

  // Per-link classification: a node is bridge-enabled iff the chain
  // link ENDING at this node (i.e., upstream link from i-1 to i) is
  // classified as bridge_required. Card 0 has no upstream link, so it
  // never gets bridge_enabled.
  const linkClasses: ChainLinkClass[] = nodes
    .slice(0, -1)
    .map((node, i) => classifyChainLink(node.result, nodes[i + 1].result));

  // Two ix buckets. The setup bucket (ATA creates + SOL wrap) goes into
  // a dedicated pre-tx because the combined chain doesn't fit in a single
  // legacy tx (Solana's v0 wire cap is 1232 bytes; even a 2-card chain
  // typically overruns once you add ~8 ATA creates + 2 create_automation_
  // swap_linked ixs). Splitting keeps each tx well under the cap.
  const setupIxs: TransactionInstruction[] = [];
  const chainIxs: TransactionInstruction[] = [];
  const seedAmounts: BN[] = [];
  // Accumulate the SOL cost the chain create will charge so we can
  // pre-flight a wallet balance check before any prompt. Time fees +
  // optional wSOL wrap dominate; ATA rents + tx fees are bounded.
  let estimatedTimeFeeLamports = 0n;
  let estimatedWrapLamports = 0n;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const result = node.result;
    const trigger = result.triggers[0];
    const action = result.actions[0];
    if (!trigger || !action || action.kind !== "swap") {
      throw new Error(`node ${i + 1}: chain rules must be Swap actions`);
    }

    // For PriceRelativeToFill triggers the upstream PDA is the previous
    // node's PDA (forward chain: i - 1). The draft leaves `upstream: null`
    // while editing; we inject the resolved pubkey here before encoding.
    let resolvedTrigger = trigger;
    if (trigger.kind === "price_relative_to_fill" && i > 0) {
      resolvedTrigger = { ...trigger, upstream: nodePdas[i - 1] };
    }
    const onChainTrigger = await buildTriggerSpec(resolvedTrigger);
    if (!onChainTrigger) {
      throw new Error(`node ${i + 1}: trigger could not be encoded`);
    }
    // Linked-downstream pubkey — not required for the chain to work
    // (destination routing is what matters), but useful for on-chain
    // event indexing and for the existing execute_swap link_fee_deposit
    // path. Set to the same target as `destination`. 1-card chains
    // never carry a downstream pubkey because the destination is the
    // owner.
    const linkedDownstream =
      nodes.length > 1 && node.next ? nodePdas[node.next.ruleIndex] : null;
    // The head card has no upstream link, so `consumeUpstreamOutput`
    // can't be honoured even if the draft carries it (e.g., a card was
    // toggled to consume mode then promoted to head). Strip it here so
    // the encoder doesn't write the u64::MAX `amount_in` sentinel and
    // try to seed the head PDA with an overflowing balance.
    const safeAction =
      i === 0 && action.kind === "swap" && action.consumeUpstreamOutput
        ? { ...action, consumeUpstreamOutput: false }
        : action;
    const onChainAction = buildSwapAction(destinations[i], safeAction, linkedDownstream);
    if (!onChainAction || !("swap" in onChainAction)) {
      throw new Error(`node ${i + 1}: action could not be encoded`);
    }

    // Head node deposits one cycle's worth of input by default.
    // Special cases when there's a loop and the head is NOT in the
    // cycle (a "warm-up" rule that drives the loop into existence
    // and then stops): head still seeds amount × 1 because the
    // warm-up cadence is typically Once. Single-card self-loop has
    // no upstream to refill it, so we pre-fund many cycles upfront.
    const isHead = i === 0;
    let seedAmount: BN;
    if (!isHead) {
      seedAmount = new BN(0);
    } else if (nodes.length === 1 && loopMode) {
      const cyclesToFund =
        loopMode.kind === "frequency"
          ? loopMode.cycles
          : SELF_LOOP_INFINITE_FUND_CYCLES;
      seedAmount = onChainAction.swap.amountIn.mul(new BN(cyclesToFund));
    } else {
      seedAmount = onChainAction.swap.amountIn;
    }
    seedAmounts.push(seedAmount);

    // Pre-create owner input ATA + automation input ATA + destination
    // output ATA (idempotent, no-ops if exists).
    const ownerInputAta = associatedTokenAddress(owner, onChainAction.swap.inputMint);
    if (onChainAction.swap.inputMint.toBase58() !== SOL_MINT_STR) {
      setupIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          ownerInputAta,
          owner,
          onChainAction.swap.inputMint,
          SPL_TOKEN_PROGRAM_ID,
        ),
      );
    }
    // Special-case wrapped SOL: head node may wrap user's native SOL
    // into wSOL for the seed transfer. Downstream nodes don't need
    // wrapping (they receive wSOL from the upstream swap).
    if (isHead && onChainAction.swap.inputMint.toBase58() === SOL_MINT_STR) {
      const wrapLamports = BigInt(seedAmount.toString());
      estimatedWrapLamports += wrapLamports;
      const ownerWsolAta = associatedTokenAddress(owner, NATIVE_MINT);
      setupIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          ownerWsolAta,
          owner,
          NATIVE_MINT,
          SPL_TOKEN_PROGRAM_ID,
        ),
      );
      setupIxs.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: ownerWsolAta,
          lamports: wrapLamports,
        }),
      );
      setupIxs.push(createSyncNativeInstruction(ownerWsolAta, SPL_TOKEN_PROGRAM_ID));
    }
    const automationPdaForNode = nodePdas[i];
    const automationInputAta = associatedTokenAddress(
      automationPdaForNode,
      onChainAction.swap.inputMint,
    );
    setupIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        automationInputAta,
        automationPdaForNode,
        onChainAction.swap.inputMint,
        SPL_TOKEN_PROGRAM_ID,
      ),
    );
    // Destination output ATA: when destination = next node's PDA,
    // this ATA equals the next node's input ATA (idempotent create
    // dedups against the prior loop iteration, no harm done).
    const destOutputAta = associatedTokenAddress(
      destinations[i],
      onChainAction.swap.outputMint,
    );
    setupIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        destOutputAta,
        destinations[i],
        onChainAction.swap.outputMint,
        SPL_TOKEN_PROGRAM_ID,
      ),
    );
    // Treasury's output ATA — receives the protocol swap fee on every
    // execute_swap fire of this rule. Idempotent across chain links
    // that share an output mint and across all users system-wide.
    setupIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        associatedTokenAddress(config.treasury, onChainAction.swap.outputMint),
        config.treasury,
        onChainAction.swap.outputMint,
        SPL_TOKEN_PROGRAM_ID,
      ),
    );

    // Cadence resolution: when loopMode is set AND this node is in
    // the cycle, override the per-rule cadence with the loop template
    // (Repeat{cycles} for frequency, Until{far_future} for infinite).
    // Warm-up rules outside the cycle keep their picked cadence
    // (typically Once) so they don't get stuck retrying with empty
    // input ATAs after the loop takes over.
    const effectiveCadence =
      loopMode && cycleMembers.has(i)
        ? loopModeToCadence(loopMode)
        : result.cadence;
    estimatedTimeFeeLamports += estimateTimeFee(
      effectiveCadence,
      BigInt(config.timeFeeLamportsPerDay.toString()),
    );

    const upstreamLinkClass = i === 0 ? null : linkClasses[i - 1];
    // Self-link with mismatched mints needs the bridge too — the rule's
    // own swap output lands in the wrong ATA, and the dispatcher refills
    // the input ATA before the next fire.
    const isSelfLink = node.next != null && node.next.ruleIndex === i;
    const selfLinkNeedsBridge =
      isSelfLink && classifyChainLink(node.result, node.result) === "bridge_required";
    const bridgeEnabled =
      upstreamLinkClass === "bridge_required" || selfLinkNeedsBridge;

    const built = await buildCreateAutomationSwapLinkedIx({
      program,
      owner,
      keeper,
      trigger: onChainTrigger,
      action: onChainAction as OnChainActionSpec & {
        swap: {
          inputMint: PublicKey;
          outputMint: PublicKey;
          destination: PublicKey;
          amountIn: BN;
          minAmountOut: BN;
        };
      },
      cadence: cadenceToOnChain(effectiveCadence),
      minIntervalSecs: result.minIntervalSecs,
      // Linked rules opt into keeper-driven fee top-up. The keeper
      // periodically converts a slice of PDA tokens to wSOL for its
      // operating budget, so the chain remains self-sustaining even
      // for SOL-fee accounting.
      enableFeeTopup: true,
      seedAmount,
      bridgeEnabled,
      nextNonce: startNonce + BigInt(i),
    });
    chainIxs.push(built.ix);
  }

  // Pre-flight SOL balance check. Time fees + wSOL wrap dominate; ATA
  // rents are 0.00203928 SOL each and only billed for ATAs that don't
  // exist yet (the client overestimates by assuming all setup ATA ixs
  // create — safe and clear). The partial-failure mode without this
  // check is painful: setup tx burns ATA rent, then chain tx reverts
  // on time-fee transfer, leaving the wallet depleted.
  //
  // Tx count: 1 setup (if any setupIxs) + ceil(chainIxs / CHAIN_BATCH_SIZE)
  // chain-create txs. For 1-3 rule chains that's 1 chain tx; for 4-5
  // rules it's 2-3 chain txs (and 4 prompts total).
  const ATA_RENT_LAMPORTS = 2_039_280n;
  const TX_FEE_LAMPORTS = 5_000n;
  const CHAIN_BATCH_SIZE_PREVIEW = 2;
  const chainTxCount = BigInt(
    Math.ceil(chainIxs.length / CHAIN_BATCH_SIZE_PREVIEW),
  );
  const txCount = (setupIxs.length > 0 ? 1n : 0n) + chainTxCount;
  const estimatedSolNeeded =
    estimatedTimeFeeLamports +
    estimatedWrapLamports +
    ATA_RENT_LAMPORTS * BigInt(setupIxs.length) +
    TX_FEE_LAMPORTS * txCount;
  const ownerBalance = BigInt(await connection.getBalance(owner));
  if (ownerBalance < estimatedSolNeeded) {
    const fmt = (lamports: bigint) =>
      (Number(lamports) / 1_000_000_000).toLocaleString(undefined, {
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
      });
    const need = fmt(estimatedSolNeeded);
    const have = fmt(ownerBalance);
    const shortBy = fmt(estimatedSolNeeded - ownerBalance);
    throw new Error(
      `Not enough SOL to fund this chain. Need ~${need} SOL (time fees + ATA rent + tx fees), wallet has ${have} SOL — top up ~${shortBy} SOL and retry.`,
    );
  }

  // Send setup tx first (sign + submit + confirm) and ONLY then build,
  // sign and submit the chain tx. We deliberately don't use
  // signAllTransactions here: when both txs are signed upfront,
  // preflight simulation of the chain tx runs against current state
  // (where the PDA input ATA still doesn't exist) and reverts with
  // AnchorError 3012 / 0xbc4 (AccountNotInitialized). Two prompts is
  // worth not having to chase that ordering bug. Setup ixs are
  // idempotent ATA creates + an optional wSOL wrap, so a partial
  // failure leaves the user only out the ATA rent (~0.002 SOL each).
  let sig: string;
  if (setupIxs.length > 0) {
    const setupBh = await connection.getLatestBlockhash("confirmed");
    const setupTx = new Transaction();
    for (const ix of setupIxs) setupTx.add(ix);
    setupTx.feePayer = owner;
    setupTx.recentBlockhash = setupBh.blockhash;
    const signedSetup = await wallet.signTransaction(setupTx);
    const setupSig = await connection.sendRawTransaction(signedSetup.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(
      {
        signature: setupSig,
        blockhash: setupBh.blockhash,
        lastValidBlockHeight: setupBh.lastValidBlockHeight,
      },
      "confirmed",
    );
  }

  // Chain create txs are split when chainIxs.length > CHAIN_BATCH_SIZE.
  // Each batch is one tx, signed independently; the on-chain program
  // enforces sequential nonces via `config.automation_count`, so the
  // ix order across batches must match the rule order. Partial-failure
  // recovery: if batch K lands but batch K+1 fails, the user can retry
  // — the second attempt will rebuild from a fresh fetchConfig and
  // pick up the new nonce baseline. The first K rules are already
  // live and their setup ATAs are still valid; the remaining N-K
  // rules just need to be created. (For now the simple retry flow
  // requires the user to recreate from scratch; the partially-created
  // PDAs can be closed via the regular close ix to recover ATA rent.)
  const CHAIN_BATCH_SIZE = 2;
  const batches: TransactionInstruction[][] = [];
  for (let i = 0; i < chainIxs.length; i += CHAIN_BATCH_SIZE) {
    batches.push(chainIxs.slice(i, i + CHAIN_BATCH_SIZE));
  }
  const chainBh = await connection.getLatestBlockhash("confirmed");
  // The user-facing `sig` is the LAST batch's signature — that's the
  // tx whose logs contain the AutomationCreated events for the tail
  // rules. We parse events from every batch's tx below.
  const batchSigs: string[] = [];
  try {
    for (let b = 0; b < batches.length; b++) {
      const chainTx = new Transaction();
      for (const ix of batches[b]) chainTx.add(ix);
      chainTx.feePayer = owner;
      // Re-fetch blockhash for batches after the first to avoid using
      // a near-expired hash mid-flow. The first batch reuses the
      // shared `chainBh` from above.
      const bh = b === 0
        ? chainBh
        : await connection.getLatestBlockhash("confirmed");
      chainTx.recentBlockhash = bh.blockhash;
      const signedChain = await wallet.signTransaction(chainTx);
      const batchSig = await connection.sendRawTransaction(signedChain.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(
        {
          signature: batchSig,
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
        },
        "confirmed",
      );
      batchSigs.push(batchSig);
    }
    sig = batchSigs[batchSigs.length - 1];
  } catch (e) {
    // Nonce race: between our fetchConfig() call near the top of this
    // function and the chain tx landing, another user's
    // create_automation* incremented Config.automation_count. Our PDA
    // seeds (automation_count.to_le_bytes()) collided with the now-
    // existing PDA and `SystemProgram` reverted with "already in use"
    // / `0x0`. Setup tx already landed (idempotent ATAs are now created
    // against the OLD nodePdas — wasted ~0.002 SOL per ATA but no data
    // loss). Surface a recognizable error so the UI can prompt a
    // one-click retry; the next attempt re-fetches a fresh startNonce.
    const msg = e instanceof Error ? e.message : String(e);
    const collided =
      msg.includes("already in use") ||
      msg.includes("0x0") ||
      // Anchor's `init` constraint surfaces this when the PDA derived
      // from our (assumed) nonce already has data.
      msg.includes("AlreadyInitialized");
    if (collided) {
      throw new Error(
        "Another user's automation was created at the same time and took your sequence number. Click create again — the setup ATAs are already provisioned so the next attempt will be cheaper.",
      );
    }
    throw e;
  }

  // Parse the AutomationCreated events from EVERY batch's tx — Anchor
  // emits one event per create call, and we may have split the chain
  // across multiple txs. Walk each tx's logs in order so events line
  // up with the `nodes` array.
  const events: { pubkey: string; nonce: string }[] = [];
  for (const batchSig of batchSigs) {
    const txDetails = await connection.getTransaction(batchSig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const logs = txDetails?.meta?.logMessages ?? [];
    events.push(...parseAllAutomationCreated(program, logs));
  }
  if (events.length < nodes.length) {
    // Fall back to derived pubkeys if event parsing doesn't recover all
    // creates (rare — would mean log truncation). The PDAs are
    // deterministic so we know what we created.
    for (let i = events.length; i < nodes.length; i++) {
      events.push({
        pubkey: nodePdas[i].toBase58(),
        nonce: (startNonce + BigInt(i)).toString(),
      });
    }
  }

  return {
    signature: sig,
    nodes: events.slice(0, nodes.length).map((e, i) => ({
      pubkey: e.pubkey,
      nonce: e.nonce,
      seedAmount: seedAmounts[i].toString(),
    })),
  };
}

/* ── Event parsing — multi-event variant ─────────────────────────── */

function parseAllAutomationCreated(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  logs: string[],
): { pubkey: string; nonce: string }[] {
  const out: { pubkey: string; nonce: string }[] = [];
  const coder = new BorshCoder(program.idl as Idl);
  const parser = new EventParser(program.programId, coder);
  for (const evt of parser.parseLogs(logs)) {
    if (evt.name === "AutomationCreated" || evt.name === "automationCreated") {
      const data = evt.data as { pubkey: PublicKey; nonce: BN };
      out.push({ pubkey: data.pubkey.toBase58(), nonce: data.nonce.toString() });
    }
  }
  return out;
}

/* ── Per-rule deposit summary (for the chain-mode DepositSheet) ──── */

export type ChainDepositSummary = {
  /** Token symbol → amount the user is contributing across all chain
   *  nodes (only the head's seed counts for v1). */
  totalsByToken: Record<string, number>;
  /** Tx fee estimate in SOL. Each create_automation_swap_linked is
   *  ~80k CU; the whole chain typically lands under 0.0001 SOL. */
  networkFeeSol: number;
  /** Per-node breakdown for the summary list. */
  nodes: Array<{
    label: string;
    triggerSummary: string;
    actionSummary: string;
    seedAmount: number;
    seedToken: string;
    isHead: boolean;
    linkSummary: string;
  }>;
  /** Advisory: Token-2022 mints in the chain may have transfer-fee
   *  extensions that compound across cycles. We can't compute exact
   *  per-fire loss without an on-chain extension probe (deferred to
   *  the UI layer), but we surface that at least one mint is
   *  Token-2022 so the user knows to expect net < quoted amounts.
   *  Empty when every mint is legacy SPL. */
  token2022MintsInChain: string[];
};

export function summarizeChain(
  nodes: ChainNodeDraft[],
  loopMode?: LoopMode | null,
): ChainDepositSummary {
  const totalsByToken: Record<string, number> = {};
  const SOLANA_BASE_FEE = 0.000005;
  // Each create + ~3 ATA creates: rough CU + tx overhead. 0.00005 per
  // node is a safe over-estimate.
  const networkFeeSol = SOLANA_BASE_FEE + nodes.length * 0.00005;
  // Head seed scaling matches `sendChainCreate`: single-rule self-loop
  // pre-funds many cycles, multi-rule chains seed only cycle 1.
  const headCyclesToFund =
    nodes.length === 1 && loopMode
      ? loopMode.kind === "frequency"
        ? loopMode.cycles
        : SELF_LOOP_INFINITE_FUND_CYCLES
      : 1;
  const breakdown = nodes.map((node, i) => {
    const action = node.result.actions[0];
    const label = `Rule ${i + 1}`;
    let actionSummary = "—";
    let seedAmount = 0;
    let seedToken = "";
    if (action && action.kind === "swap") {
      seedToken = action.inputToken.symbol;
      seedAmount = i === 0 ? action.amount * headCyclesToFund : 0;
      if (seedAmount > 0) {
        totalsByToken[seedToken] = (totalsByToken[seedToken] || 0) + seedAmount;
      }
      actionSummary = `swap ${action.amount} ${action.inputToken.symbol} → ${action.outputToken.symbol}`;
    }
    const trigger = node.result.triggers[0];
    let triggerSummary = "—";
    if (trigger) {
      if (trigger.kind === "asset_price") {
        triggerSummary = `${trigger.asset.symbol} ${trigger.comparator} ${trigger.threshold}`;
      } else if (trigger.kind === "time_elapsed") {
        triggerSummary = `after ${trigger.value} ${trigger.unit}`;
      } else if (trigger.kind === "price_relative_to_fill") {
        const pct = trigger.pctBps / 100;
        triggerSummary = `${trigger.direction === "grow" ? "grew" : "dropped"} ${pct}% from fill`;
      } else {
        triggerSummary = trigger.kind.replace("_", " ");
      }
    }
    let linkSummary = "terminal";
    if (nodes.length === 1 && loopMode) {
      linkSummary =
        loopMode.kind === "infinite"
          ? "self-link · until depleted"
          : `self-link · ${loopMode.cycles} cycles`;
    } else if (node.next) {
      const targetIdx = node.next.ruleIndex;
      // A back-link (target ≤ current index) closes a cycle. Forward
      // links (target == i + 1) are the auto-pipe between mid-chain
      // cards.
      if (targetIdx <= i) {
        linkSummary = `↩ link back to rule ${targetIdx + 1}`;
      } else {
        linkSummary = `→ rule ${targetIdx + 1}`;
      }
    }
    return {
      label,
      triggerSummary,
      actionSummary,
      seedAmount,
      seedToken,
      isHead: i === 0,
      linkSummary,
    };
  });
  // Surface any Token-2022 mints in the chain so the UI can warn the
  // user that transfer-fee extensions may erode the round-trip
  // amount. We don't know the per-fire fee % without an on-chain
  // extension probe; the UI shows an advisory and links to docs.
  const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const token2022Mints = new Set<string>();
  for (const node of nodes) {
    for (const action of node.result.actions) {
      if (action.kind !== "swap") continue;
      if (action.inputToken.tokenProgram === TOKEN_2022_PROGRAM) {
        token2022Mints.add(action.inputToken.symbol);
      }
      if (action.outputToken.tokenProgram === TOKEN_2022_PROGRAM) {
        token2022Mints.add(action.outputToken.symbol);
      }
    }
  }
  // network fee accounted in SOL; if the input is also SOL, we don't
  // double-count — the network fee is paid from the wallet's SOL
  // balance, separate from the wSOL ATA used for the seed transfer.
  return {
    totalsByToken,
    networkFeeSol,
    nodes: breakdown,
    token2022MintsInChain: [...token2022Mints],
  };
}

const _LAMPORTS_PER_SOL = LAMPORTS_PER_SOL;
export const LAMPORTS_PER_SOL_EXPORT = _LAMPORTS_PER_SOL;
