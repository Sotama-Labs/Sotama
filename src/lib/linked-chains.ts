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
  nextNonce,
  SOTAMA_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  type OnChainActionSpec,
  type OnChainTriggerSpec,
} from "./program";
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
  | { kind: "mint_flow_mismatch"; fromIndex: number; toIndex: number }
  | { kind: "loop_with_distinct_input_output"; nodeIndex: number }
  | { kind: "head_must_have_seed_amount"; nodeIndex: number };

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
  // Mint-flow check: each upstream rule's outputMint must equal the
  // downstream's inputMint, otherwise the Swap.destination's ATA holds
  // a token the downstream rule can't trade. Only meaningful when there
  // are 2+ nodes — single-rule chains have no destination routing.
  for (let i = 0; i < nodes.length; i++) {
    const link = nodes[i].next;
    if (!link) continue;
    const targetIdx = link.ruleIndex;
    if (targetIdx < 0 || targetIdx >= nodes.length) continue;
    if (targetIdx === i) {
      // Self-link only works on a 1-card chain where the swap output
      // is routed back to owner (cadence-driven loop). For multi-card
      // chains a self-link would require input mint = output mint —
      // degenerate — so we reject it here. Single-card self-loops use
      // `next: null` semantically (the loop is cadence-only), but the
      // LoopModal can also produce ruleIndex=0 for clarity; treat that
      // as valid only when it's the only node.
      if (nodes.length > 1) {
        return { kind: "loop_with_distinct_input_output", nodeIndex: i };
      }
      continue;
    }
    const upstream = nodes[i].result.actions[0] as { kind: "swap"; outputToken: { mint: string } };
    const downstream = nodes[targetIdx].result.actions[0] as {
      kind: "swap";
      inputToken: { mint: string };
    };
    if (upstream.outputToken.mint !== downstream.inputToken.mint) {
      return { kind: "mint_flow_mismatch", fromIndex: i, toIndex: targetIdx };
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

function buildTriggerSpec(t: Trigger): OnChainTriggerSpec | null {
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
        } else {
          const m = tryPubkey(t.quote.asset.mint);
          if (!m) return null;
          quoteMint = m;
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
  const amountIn = new BN(
    Math.round(a.amount * Math.pow(10, a.inputToken.decimals)),
  );
  return {
    swap: {
      inputMint,
      outputMint,
      destination,
      amountIn,
      minAmountOut: new BN(0),
      linkedDownstream,
      linkFeeDeposit: new BN(0),
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
      "Sotama program ID is not configured. Run `pnpm anchor:deploy:devnet` and update .env.local.",
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
  const startNonce = await nextNonce(program);

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

  const ixs: TransactionInstruction[] = [];
  const seedAmounts: BN[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const result = node.result;
    const trigger = result.triggers[0];
    const action = result.actions[0];
    if (!trigger || !action || action.kind !== "swap") {
      throw new Error(`node ${i + 1}: chain rules must be Swap actions`);
    }

    const onChainTrigger = buildTriggerSpec(trigger);
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
    const onChainAction = buildSwapAction(destinations[i], action, linkedDownstream);
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
      ixs.push(
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
      const ownerWsolAta = associatedTokenAddress(owner, NATIVE_MINT);
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          ownerWsolAta,
          owner,
          NATIVE_MINT,
          SPL_TOKEN_PROGRAM_ID,
        ),
      );
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: ownerWsolAta,
          lamports: wrapLamports,
        }),
      );
      ixs.push(createSyncNativeInstruction(ownerWsolAta, SPL_TOKEN_PROGRAM_ID));
    }
    const automationPdaForNode = nodePdas[i];
    const automationInputAta = associatedTokenAddress(
      automationPdaForNode,
      onChainAction.swap.inputMint,
    );
    ixs.push(
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
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        destOutputAta,
        destinations[i],
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

    const built = await buildCreateAutomationSwapLinkedIx({
      program,
      owner,
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
      nextNonce: startNonce + BigInt(i),
    });
    ixs.push(built.ix);
  }

  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = owner;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  // Parse the AutomationCreated events to recover each rule's pubkey
  // + nonce. Anchor emits one event per create call, so the order
  // matches our `nodes` array.
  const txDetails = await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  const logs = txDetails?.meta?.logMessages ?? [];
  // parseAutomationCreated returns ONE event — call it per chunk.
  // For a multi-create tx the EventParser yields multiple events; we
  // collect them all by walking the logs N times skipping prior events.
  const events: { pubkey: string; nonce: string }[] = [];
  // We use a custom parse that returns ALL events in order, since the
  // existing helper short-circuits at the first one.
  events.push(...parseAllAutomationCreated(program, logs));
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
  // network fee accounted in SOL; if the input is also SOL, we don't
  // double-count — the network fee is paid from the wallet's SOL
  // balance, separate from the wSOL ATA used for the seed transfer.
  return { totalsByToken, networkFeeSol, nodes: breakdown };
}

const _LAMPORTS_PER_SOL = LAMPORTS_PER_SOL;
export const LAMPORTS_PER_SOL_EXPORT = _LAMPORTS_PER_SOL;
