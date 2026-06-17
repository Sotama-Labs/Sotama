/* ─────────────────────────────────────────────────────────────────────
   Demo seed data — pre-populated strategies, holdings, and execution
   history for the public demo. Stands in for everything the keeper +
   Solana RPC would normally hydrate, so Active Strategies looks alive
   without a single on-chain read. Prices are still pulled live from
   Jupiter (see ActiveStrategiesPage / the price hooks).
   ───────────────────────────────────────────────────────────────────── */

import { PublicKey } from "@solana/web3.js";
import type {
  Action,
  AssetPriceTrigger,
  AssetRef,
  Automation,
  Cadence,
  OracleSource,
  SwapAction,
  TokenRef,
  Trigger,
} from "@/lib/types";
import { CANONICAL_MINTS, SOL_MINT, USDC_MINT } from "@/lib/tokens";
import type { PdaHoldingsResult, PdaTokenHolding } from "@/hooks/usePdaHoldings";
import type {
  AutomationHistory,
  ExecutionRecord,
  FillRecord,
} from "@/hooks/useAutomationFills";

/* ── Pre-generated, valid base58 identities (never hold real funds) ──── */

const PDA = [
  "4rqgzLXkYRLcxZ5YBVtuDgtCE54KmMguVyuMuJKxJ1W1",
  "A67kcU3b17ggoqWT4fGjDTthBvBtNZ3jTQJVAKyo3s1q",
  "HZrjFyH4LjxYChuwVma2BqTqLAHjgLadNtBjr88ePCDS",
  "5i2Q1ViWcBioiHNKqnw697CXR1v6vLQR24sXRpjR3ezT",
  "5XRxBjdJbzzJhTmuYmTGbhu32GUgm8XvpTHSj2jAbbMN",
  "BLXu9ofaar2UPWzwrsX3eBmYkaRnZ6Ja6AGQgQCcXo3x",
  "FZtxXcN2P6Tpwea89Q78Hr8LidYnYxxkBZM4LUVrS7UU",
  "CSxFjbQpvFmJtk5TcPB9ZrhTQDQuoUEm3kUkieZFJtfB",
] as const;

const DEST = [
  "GrxAZVLThBiBQA1Utbk3NaKnm15fk6d2pohCW7WuDyPn",
  "w8tbLc9jp64pPpS4dAvmtYsvadt46prz65hGyEFMRxj",
] as const;

const SIG = [
  "7JRkYBd2Tu4PxvUNecMuChLX8AZqS3J8DXGCxGDULADm6aMUF8AgUF5afLJ3kwVbcWb443huCGUXxVPBVbGKcqSU",
  "HSrg3UVcxrzs4gVbMqSmzYbNunq4kDtkpQpSV3etK2YmaFRPXuBU93EouMYYqmzJUqnoqVheiMCF4d25r5aC693",
  "87MzFPyU3KfiLSM32QJcQnqf9TEBvCa8XbTesxU7CS415jtzEY7y2vqyTBWXJxZB1eZK5cPYwev1D3P6fcC2e5rX",
  "75pNXdKhem3rzRmm6AM8DzxHf8f6Zr97s5wDwFVdDbjc9N4GDzQ195KMppLh1m9otiiUNVfY5cJ6sFhTw91sYY2q",
  "i4G8fhXDDjwCzSJ27fJ5uRXS7Y4d7ssBASXc2mmy6JsCohRyaRKPupHmwHRTURmjJG65PZYZCaDdjutdcwFawJz",
  "82mSn91rJvmUKtE7d2nq3GXDwovwh5FYrTubE9yUZPQZB5p149WynQEwg9CymGaNVLUgTyWjkbic7s9mrafP5Beq",
] as const;

/* ── Token shorthands (canonical mainnet metadata) ───────────────────── */

const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const SOL = CANONICAL_MINTS[SOL_MINT];
const USDC = CANONICAL_MINTS[USDC_MINT];
const JUP = CANONICAL_MINTS[JUP_MINT];
const BONK = CANONICAL_MINTS[BONK_MINT];

const TOKEN_BY_MINT: Record<string, TokenRef> = {
  [SOL_MINT]: SOL,
  [USDC_MINT]: USDC,
  [JUP_MINT]: JUP,
  [BONK_MINT]: BONK,
};

/* ── Builders ────────────────────────────────────────────────────────── */

function asset(tok: TokenRef): AssetRef {
  return {
    symbol: tok.symbol,
    displaySymbol: tok.symbol,
    name: tok.name,
    assetClass: "Crypto",
    logo: tok.logo,
    mint: tok.mint,
    decimals: tok.decimals,
    metadataSource: tok.metadataSource,
  };
}

function jupOracle(tok: TokenRef): OracleSource {
  return { kind: "jupiter", mint: tok.mint, symbol: `${tok.symbol}/USD` };
}

function priceTrigger(
  tok: TokenRef,
  comparator: "above" | "below",
  threshold: number,
): AssetPriceTrigger {
  return {
    kind: "asset_price",
    asset: asset(tok),
    quote: { kind: "usd" },
    comparator,
    threshold,
    oracle: jupOracle(tok),
  };
}

function swap(
  input: TokenRef,
  output: TokenRef,
  amount: number,
  extra: Partial<SwapAction> = {},
): SwapAction {
  return { kind: "swap", inputToken: input, outputToken: output, amount, ...extra };
}

type Seed = {
  pubkey: string;
  trigger: Trigger;
  action: Action;
  cadence: Cadence;
  running: boolean;
  runs: number;
  createdMsAgo: number;
  lastCheckMsAgo: number;
  executedMsAgo?: number;
  closedMsAgo?: number;
  nonce: string;
  sig: string;
  link?: Automation["link"];
};

const MIN = 60_000;
const HR = 3_600_000;
const DAY = 86_400_000;

const CHAIN_ARB = "chain_demo_arb";

/** Stable per-render automation ids so React keys + chain links don't
 *  churn between renders within a session. */
const ID = PDA.map((p) => `onchain_${p}`);

function seeds(): Seed[] {
  return [
    // 1 — Running: buy the SOL dip.
    {
      pubkey: PDA[0],
      trigger: priceTrigger(SOL, "below", 135),
      action: swap(USDC, SOL, 250),
      cadence: { kind: "once" },
      running: true,
      runs: 0,
      createdMsAgo: 3 * DAY,
      lastCheckMsAgo: 9_000,
      nonce: "41",
      sig: SIG[0],
    },
    // 2 — Running: daily DCA into SOL (repeat).
    {
      pubkey: PDA[1],
      trigger: { kind: "time_elapsed", value: 1, unit: "days" },
      action: swap(USDC, SOL, 50),
      cadence: { kind: "repeat", total: 10 },
      running: true,
      runs: 4,
      createdMsAgo: 6 * DAY,
      lastCheckMsAgo: 2 * MIN,
      nonce: "37",
      sig: SIG[1],
    },
    // 3 — Running: take profit on JUP.
    {
      pubkey: PDA[2],
      trigger: priceTrigger(JUP, "above", 1.4),
      action: swap(JUP, USDC, 1200),
      cadence: { kind: "once" },
      running: true,
      runs: 0,
      createdMsAgo: 22 * HR,
      lastCheckMsAgo: 15_000,
      nonce: "44",
      sig: SIG[2],
    },
    // 4 — Completed: BONK sell already fired.
    {
      pubkey: PDA[3],
      trigger: priceTrigger(BONK, "above", 0.000045),
      action: swap(BONK, USDC, 25_000_000),
      cadence: { kind: "once" },
      running: false,
      runs: 1,
      createdMsAgo: 2 * DAY,
      lastCheckMsAgo: 5 * HR,
      executedMsAgo: 5 * HR,
      nonce: "29",
      sig: SIG[3],
    },
    // 5 — Paused: SOL ceiling auto-transfer.
    {
      pubkey: PDA[4],
      trigger: priceTrigger(SOL, "above", 320),
      action: { kind: "transfer", token: SOL, amount: 2, destination: DEST[0] },
      cadence: { kind: "once" },
      running: false,
      runs: 0,
      createdMsAgo: 12 * HR,
      lastCheckMsAgo: 40 * MIN,
      nonce: "46",
      sig: SIG[4],
    },
    // 6 — Arb chain, head (1/2): rotate USDC → SOL on a dip, fund rule 2.
    {
      pubkey: PDA[5],
      trigger: priceTrigger(SOL, "below", 130),
      action: swap(USDC, SOL, 500, { linkedDownstream: PDA[6] }),
      cadence: { kind: "repeat", total: 20 },
      running: true,
      runs: 3,
      createdMsAgo: 4 * DAY,
      lastCheckMsAgo: 12_000,
      nonce: "33",
      sig: SIG[5],
      link: {
        chainId: CHAIN_ARB,
        position: 0,
        total: 2,
        next: { kind: "rule", ruleId: ID[6] },
        isHead: true,
      },
    },
    // 7 — Arb chain, tail (2/2): sell SOL back to USDC once it grows 2%
    //     above the head's fill, then loop the proceeds back to the head.
    {
      pubkey: PDA[6],
      trigger: {
        kind: "price_relative_to_fill",
        upstream: new PublicKey(PDA[5]),
        direction: "grow",
        pctBps: 200,
      },
      action: swap(SOL, USDC, 0, { consumeUpstreamOutput: true, linkedDownstream: PDA[5] }),
      cadence: { kind: "repeat", total: 20 },
      running: true,
      runs: 3,
      createdMsAgo: 4 * DAY,
      lastCheckMsAgo: 12_000,
      nonce: "34",
      sig: SIG[5],
      link: {
        chainId: CHAIN_ARB,
        position: 1,
        total: 2,
        next: { kind: "loopBack" },
        isHead: false,
      },
    },
  ];
}

/** The seeded strategies the demo "owns". Replaces the RPC-backed
 *  `fetchOwnedOnChainAutomations` result in demo mode. */
export function seedDemoAutomations(): Automation[] {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  return seeds().map((s, i) => ({
    id: ID[i],
    schemaVersion: 3,
    triggers: [s.trigger],
    triggerOperators: [],
    actions: [s.action],
    actionOperators: [],
    cadence: s.cadence,
    minIntervalSecs: 0,
    running: s.running,
    runs: s.runs,
    lastCheck: iso(s.lastCheckMsAgo),
    createdAt: iso(s.createdMsAgo),
    pubkey: s.pubkey,
    signature: s.sig,
    nonce: s.nonce,
    executedAt: s.executedMsAgo != null ? iso(s.executedMsAgo) : undefined,
    closedAt: s.closedMsAgo != null ? iso(s.closedMsAgo) : undefined,
    link: s.link,
  }));
}

/* ── Holdings (what each strategy's PDA currently "holds") ────────────── */

type HoldingSpec = { sol?: number; tokens?: Array<{ mint: string; ui: number }> };

const HOLDINGS: Record<string, HoldingSpec> = {
  [PDA[0]]: { tokens: [{ mint: USDC_MINT, ui: 250 }] }, // SOL-dip buy
  [PDA[1]]: { tokens: [{ mint: USDC_MINT, ui: 300 }] }, // DCA: 6 fires left × 50
  [PDA[2]]: { tokens: [{ mint: JUP_MINT, ui: 1200 }] }, // JUP take-profit
  // PDA[3] completed → fully swapped out, nothing left to show.
  [PDA[4]]: { sol: 2 }, // paused SOL transfer holds its 2 SOL deposit
  [PDA[5]]: { tokens: [{ mint: USDC_MINT, ui: 500 }] }, // arb head holds the torch
  // PDA[6] arb tail is waiting on upstream → empty input ATA.
};

function holdingToResult(spec: HoldingSpec): PdaHoldingsResult {
  const tokens: PdaTokenHolding[] = (spec.tokens ?? []).map((t) => {
    const token = TOKEN_BY_MINT[t.mint] ?? null;
    const decimals = token?.decimals ?? 6;
    return {
      mint: t.mint,
      amount: BigInt(Math.round(t.ui * Math.pow(10, decimals))),
      uiAmount: t.ui,
      token,
    };
  });
  return { tokens, extraSol: spec.sol ?? 0, loading: false, error: null };
}

const EMPTY_HOLDINGS: PdaHoldingsResult = {
  tokens: [],
  extraSol: 0,
  loading: false,
  error: null,
};

/** Dummy holdings for a strategy PDA. Replaces the RPC-backed
 *  `usePdaHoldings` fetch in demo mode. */
export function demoHoldings(pda: string | null | undefined): PdaHoldingsResult {
  if (!pda) return EMPTY_HOLDINGS;
  const spec = HOLDINGS[pda];
  return spec ? holdingToResult(spec) : EMPTY_HOLDINGS;
}

/* ── Execution / fill history (drives the Active Strategies stats) ────── */

/** Per-fire input amount used to synthesize fills. Falls back to the
 *  action's static amount; consume-upstream rules carry no static amount
 *  so a representative SOL size is used. */
function perFireInput(a: Automation): { mint: string; decimals: number; amount: number } | null {
  const act = a.actions[0];
  if (act?.kind !== "swap") return null;
  const amount = act.amount > 0 ? act.amount : act.inputToken.mint === SOL_MINT ? 3.5 : 1;
  return { mint: act.inputToken.mint, decimals: act.inputToken.decimals, amount };
}

/** Dummy on-chain history. Emits one fill per recorded run for every
 *  swap strategy that has fired, plus a rolled-up execution record so the
 *  Volume + Executions tiles populate. Replaces `useAutomationHistory`'s
 *  RPC log-walk in demo mode. */
export function demoHistory(automations: Automation[]): AutomationHistory {
  const fills: FillRecord[] = [];
  const executions: ExecutionRecord[] = [];
  let sigIdx = 0;

  for (const a of automations) {
    if (!a.pubkey || a.runs <= 0) continue;
    const pf = perFireInput(a);
    const createdSec = Math.floor(Date.parse(a.createdAt) / 1000) || 0;

    for (let i = 0; i < a.runs; i++) {
      const blockTime = createdSec + (i + 1) * 3600;
      const sig = `${SIG[sigIdx % SIG.length]}-${a.nonce}-${i}`;
      if (pf) {
        const inputRaw = BigInt(Math.round(pf.amount * Math.pow(10, pf.decimals)));
        // Approximate output as ~1:1 notionally — only inputAmount × price
        // feeds the Volume tile, so the output figure is cosmetic.
        fills.push({
          sig,
          slot: 250_000_000 + sigIdx,
          blockTime,
          automation: a.pubkey,
          inputAmount: inputRaw.toString(),
          outputAmount: inputRaw.toString(),
        });
      }
      sigIdx++;
    }

    executions.push({
      sig: `${SIG[sigIdx % SIG.length]}-${a.nonce}-exec`,
      slot: 250_000_000 + sigIdx,
      blockTime: createdSec + a.runs * 3600,
      automation: a.pubkey,
      actionKind: a.actions[0]?.kind === "swap" ? 2 : 0,
      amount: "0",
      executions: a.runs,
      finished: !!a.executedAt,
    });
    sigIdx++;
  }

  return { fills, executions };
}
