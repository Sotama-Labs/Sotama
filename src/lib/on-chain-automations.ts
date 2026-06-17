"use client";

import { Keypair, LAMPORTS_PER_SOL, PublicKey, type Connection } from "@solana/web3.js";
import {
  getProgram,
  isKnownTokenProgram,
  isProgramConfigured,
} from "./program";
import type {
  Action,
  AssetRef,
  Automation,
  Cadence,
  OracleSource,
  QuoteRef,
  TokenRef,
  Trigger,
} from "./types";
import { displaySymbolFromBase } from "./assets";
import { lookupPythFeedMetadata } from "./oracles";
import { CANONICAL_MINTS, resolveToken, SOL_MINT } from "./tokens";
import { isDemoMode } from "./demo/demo";
import { seedDemoAutomations } from "./demo/seed";

const OWNER_MEMCMP_OFFSET = 8;
const U64_MAX = "18446744073709551615";

type MintBasics = {
  decimals: number;
  tokenProgram: string;
};

function hasKey<T extends string>(
  value: unknown,
  key: T,
): value is Record<T, unknown> {
  return typeof value === "object" && value !== null && key in value;
}

function bnString(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return value.toString();
  const rendered = (value as { toString?: () => string } | null)?.toString?.();
  return rendered ?? "0";
}

function num(value: unknown): number {
  return Number(bnString(value));
}

function pubkeyString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "string") return value;
  const rendered = (value as { toBase58?: () => string } | null)?.toBase58?.();
  return rendered ?? null;
}

function pubkeyToFeedId(value: unknown): string | null {
  try {
    const pk = value instanceof PublicKey ? value : new PublicKey(pubkeyString(value) ?? "");
    return Buffer.from(pk.toBytes()).toString("hex");
  } catch {
    return null;
  }
}

function unixIso(value: unknown, fallback = new Date().toISOString()): string {
  const sec = num(value);
  if (Number.isFinite(sec) && sec > 0) return new Date(sec * 1000).toISOString();
  return fallback;
}

function baseUnitsToUi(raw: unknown, decimals: number): number {
  const value = Number(bnString(raw));
  if (!Number.isFinite(value)) return 0;
  return value / Math.pow(10, decimals);
}

function tokenToAsset(token: TokenRef): AssetRef {
  return {
    symbol: token.symbol,
    displaySymbol: token.symbol,
    name: token.name,
    assetClass: "Crypto",
    logo: token.logo,
    mint: token.mint,
    decimals: token.decimals,
    metadataSource: token.metadataSource,
  };
}

function fallbackToken(mint: string, basics: MintBasics | null): TokenRef {
  const short = mint.slice(0, 4);
  return {
    mint,
    symbol: `TOK-${short}`,
    name: `Token ${short}`,
    decimals: basics?.decimals ?? 0,
    metadataSource: "manual",
    tokenProgram: basics?.tokenProgram,
  };
}

function fallbackAsset(label: string): AssetRef {
  return {
    symbol: label,
    displaySymbol: label,
    name: label,
    assetClass: "Crypto",
  };
}

function pythAsset(symbol: string, description?: string, assetClass: AssetRef["assetClass"] = "Crypto"): AssetRef {
  return {
    symbol,
    displaySymbol: displaySymbolFromBase(symbol),
    name: description || displaySymbolFromBase(symbol),
    assetClass,
  };
}

function quoteAssetClass(symbol: string): AssetRef["assetClass"] {
  const upper = symbol.toUpperCase();
  if (upper === "XAU" || upper === "XAG" || upper === "XPD" || upper === "XPT") return "Metal";
  if (/^[A-Z]{3}$/.test(upper)) return "FX";
  return "Crypto";
}

async function fetchMintBasics(
  connection: Connection,
  mint: string,
): Promise<MintBasics | null> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
    if (!info || !isKnownTokenProgram(info.owner) || info.data.length <= 44) return null;
    return {
      decimals: info.data[44],
      tokenProgram: info.owner.toBase58(),
    };
  } catch {
    return null;
  }
}

async function resolveOnChainToken(
  connection: Connection,
  mint: string,
): Promise<TokenRef> {
  const basicsPromise = fetchMintBasics(connection, mint);
  const resolved = await resolveToken(mint).catch(() => null);
  const basics = await basicsPromise;

  if (resolved?.status === "ok") {
    return {
      ...resolved.token,
      decimals: basics?.decimals ?? resolved.token.decimals,
      tokenProgram: resolved.token.tokenProgram ?? basics?.tokenProgram,
    };
  }

  return fallbackToken(mint, basics);
}

async function resolveQuoteRef(
  connection: Connection,
  value: unknown,
): Promise<QuoteRef> {
  const key = pubkeyString(value);
  if (!key) return { kind: "usd" };

  const basics = await fetchMintBasics(connection, key);
  if (basics) {
    const token = await resolveOnChainToken(connection, key);
    return { kind: "asset", asset: tokenToAsset(token) };
  }

  const feedId = pubkeyToFeedId(value);
  const feed = feedId ? await lookupPythFeedMetadata(feedId) : null;
  if (feed?.base) {
    const symbol = feed.base;
    return {
      kind: "asset",
      asset: pythAsset(symbol, feed.description, feed.assetClass),
    };
  }

  return { kind: "asset", asset: fallbackAsset(`Feed ${key.slice(0, 4)}`) };
}

function thresholdToUi(threshold: unknown, expo: unknown): number {
  const raw = Number(bnString(threshold));
  const e = num(expo);
  if (!Number.isFinite(raw) || !Number.isFinite(e)) return 0;
  return raw * Math.pow(10, e);
}

function timeElapsedFromSecs(secs: number): { value: number; unit: "minutes" | "hours" | "days" } {
  if (secs % 86_400 === 0) return { value: secs / 86_400, unit: "days" };
  if (secs % 3_600 === 0) return { value: secs / 3_600, unit: "hours" };
  return { value: Math.max(1, Math.round(secs / 60)), unit: "minutes" };
}

function cadenceFromOnChain(value: unknown): Cadence {
  if (hasKey(value, "repeat")) {
    const total = hasKey(value.repeat, "total") ? num(value.repeat.total) : 1;
    return { kind: "repeat", total: Math.max(1, total) };
  }
  if (hasKey(value, "until")) {
    const unixDeadline = hasKey(value.until, "unixDeadline")
      ? num(value.until.unixDeadline)
      : 0;
    return { kind: "until", unixDeadline };
  }
  return { kind: "once" };
}

async function triggerFromOnChain(
  connection: Connection,
  trigger: unknown,
): Promise<Trigger | null> {
  if (hasKey(trigger, "accountActivity")) {
    const spec = trigger.accountActivity;
    if (!hasKey(spec, "account") || !hasKey(spec, "kind")) return null;
    const account = pubkeyString(spec.account);
    if (!account) return null;
    const mint = hasKey(spec, "mint") ? pubkeyString(spec.mint) : null;
    const token = mint
      ? { mode: "specific" as const, value: await resolveOnChainToken(connection, mint) }
      : { mode: "any" as const };
    if (num(spec.kind) === 1) {
      return {
        kind: "account_swap",
        account,
        token,
        amount: { mode: "any" },
        amountDirection: "at_least",
      };
    }
    return { kind: "account_transfer", account, token };
  }

  if (hasKey(trigger, "assetPrice")) {
    const spec = trigger.assetPrice;
    if (
      !hasKey(spec, "feed") ||
      !hasKey(spec, "comparator") ||
      !hasKey(spec, "threshold") ||
      !hasKey(spec, "expo") ||
      !hasKey(spec, "source")
    ) {
      return null;
    }

    const source = num(spec.source);
    const comparator = num(spec.comparator) === 0 ? "below" : "above";
    const quoteMint = hasKey(spec, "quoteMint") ? spec.quoteMint : null;
    const quoteFromField = quoteMint ? await resolveQuoteRef(connection, quoteMint) : null;

    let asset: AssetRef;
    let quote: QuoteRef = quoteFromField ?? { kind: "usd" };
    let oracle: OracleSource;

    if (source === 1) {
      const mint = pubkeyString(spec.feed);
      if (!mint) return null;
      const token = await resolveOnChainToken(connection, mint);
      asset = tokenToAsset(token);
      const quoteSymbol = quote.kind === "usd" ? "USD" : quote.asset.displaySymbol;
      oracle = { kind: "jupiter", mint, symbol: `${asset.displaySymbol}/${quoteSymbol}` };
    } else {
      const feedId = pubkeyToFeedId(spec.feed);
      if (!feedId) return null;
      const feed = await lookupPythFeedMetadata(feedId);
      const base = feed?.base ?? `Feed ${feedId.slice(0, 6)}`;
      asset = pythAsset(base, feed?.description, feed?.assetClass);
      if (!quoteFromField && feed?.quote && feed.quote.toUpperCase() !== "USD") {
        quote = {
          kind: "asset",
          asset: pythAsset(feed.quote, feed.quote, quoteAssetClass(feed.quote)),
        };
      }
      oracle = { kind: "pyth", feedId, symbol: feed?.symbol ?? `${asset.displaySymbol}/USD` };
    }

    return {
      kind: "asset_price",
      asset,
      quote,
      comparator,
      threshold: thresholdToUi(spec.threshold, spec.expo),
      oracle,
    };
  }

  if (hasKey(trigger, "timeElapsed")) {
    const secs = hasKey(trigger.timeElapsed, "durationSecs")
      ? num(trigger.timeElapsed.durationSecs)
      : 60;
    return { kind: "time_elapsed", ...timeElapsedFromSecs(secs) };
  }

  if (hasKey(trigger, "priceRelativeToFill")) {
    const spec = trigger.priceRelativeToFill;
    if (!hasKey(spec, "upstream") || !hasKey(spec, "direction") || !hasKey(spec, "pctBps")) {
      return null;
    }
    const upstream = pubkeyString(spec.upstream);
    if (!upstream) return null;
    return {
      kind: "price_relative_to_fill",
      upstream: new PublicKey(upstream),
      direction: num(spec.direction) === 1 ? "grow" : "drop",
      pctBps: num(spec.pctBps),
    };
  }

  return null;
}

async function actionFromOnChain(
  connection: Connection,
  action: unknown,
): Promise<Action | null> {
  if (hasKey(action, "transferSol")) {
    const spec = action.transferSol;
    if (!hasKey(spec, "destination") || !hasKey(spec, "amount")) return null;
    const destination = pubkeyString(spec.destination);
    if (!destination) return null;
    return {
      kind: "transfer",
      token: CANONICAL_MINTS[SOL_MINT],
      amount: Number(bnString(spec.amount)) / LAMPORTS_PER_SOL,
      destination,
    };
  }

  if (hasKey(action, "transferSpl")) {
    const spec = action.transferSpl;
    if (!hasKey(spec, "destination") || !hasKey(spec, "mint") || !hasKey(spec, "amount")) {
      return null;
    }
    const destination = pubkeyString(spec.destination);
    const mint = pubkeyString(spec.mint);
    if (!destination || !mint) return null;
    const token = await resolveOnChainToken(connection, mint);
    return {
      kind: "transfer",
      token,
      amount: baseUnitsToUi(spec.amount, token.decimals),
      destination,
    };
  }

  if (hasKey(action, "swap")) {
    const spec = action.swap;
    if (
      !hasKey(spec, "inputMint") ||
      !hasKey(spec, "outputMint") ||
      !hasKey(spec, "amountIn")
    ) {
      return null;
    }
    const inputMint = pubkeyString(spec.inputMint);
    const outputMint = pubkeyString(spec.outputMint);
    if (!inputMint || !outputMint) return null;
    const [inputToken, outputToken] = await Promise.all([
      resolveOnChainToken(connection, inputMint),
      resolveOnChainToken(connection, outputMint),
    ]);
    const linkedDownstream = hasKey(spec, "linkedDownstream")
      ? pubkeyString(spec.linkedDownstream)
      : null;
    const consumeUpstreamOutput =
      hasKey(spec, "consumeUpstreamOutput") && spec.consumeUpstreamOutput === true;
    return {
      kind: "swap",
      inputToken,
      outputToken,
      amount:
        consumeUpstreamOutput || bnString(spec.amountIn) === U64_MAX
          ? 0
          : baseUnitsToUi(spec.amountIn, inputToken.decimals),
      linkedDownstream: linkedDownstream ?? undefined,
      consumeUpstreamOutput: consumeUpstreamOutput || bnString(spec.amountIn) === U64_MAX,
    };
  }

  return null;
}

async function automationFromOnChain(
  connection: Connection,
  row: { publicKey: PublicKey; account: unknown },
): Promise<Automation | null> {
  const account = row.account;
  if (
    !hasKey(account, "trigger") ||
    !hasKey(account, "action") ||
    !hasKey(account, "cadence") ||
    !hasKey(account, "executions") ||
    !hasKey(account, "minIntervalSecs") ||
    !hasKey(account, "finished") ||
    !hasKey(account, "createdAt") ||
    !hasKey(account, "executedAt") ||
    !hasKey(account, "nonce")
  ) {
    return null;
  }

  const [trigger, action] = await Promise.all([
    triggerFromOnChain(connection, account.trigger),
    actionFromOnChain(connection, account.action),
  ]);
  if (!trigger || !action) return null;

  const now = new Date().toISOString();
  const createdAt = unixIso(account.createdAt, now);
  const executedAtSec = num(account.executedAt);
  const finished = account.finished === true;

  return {
    id: `onchain_${row.publicKey.toBase58()}`,
    schemaVersion: 3,
    triggers: [trigger],
    triggerOperators: [],
    actions: [action],
    actionOperators: [],
    cadence: cadenceFromOnChain(account.cadence),
    minIntervalSecs: num(account.minIntervalSecs),
    running: !finished,
    runs: num(account.executions),
    lastCheck: now,
    createdAt,
    pubkey: row.publicKey.toBase58(),
    nonce: bnString(account.nonce),
    executedAt: finished ? unixIso(executedAtSec, now) : undefined,
  };
}

function reconstructChainLinks(items: Automation[]): Automation[] {
  const byPubkey = new Map<string, Automation>();
  for (const item of items) {
    if (item.pubkey) byPubkey.set(item.pubkey, item);
  }

  const nextById = new Map<string, string>();
  const prevById = new Map<string, string>();
  const neighbors = new Map<string, Set<string>>();
  const connect = (from: Automation, toPubkey: string | null | undefined) => {
    if (!toPubkey) return;
    const to = byPubkey.get(toPubkey);
    if (!to) return;
    nextById.set(from.id, to.id);
    prevById.set(to.id, from.id);
    const a = neighbors.get(from.id) ?? new Set<string>();
    const b = neighbors.get(to.id) ?? new Set<string>();
    a.add(to.id);
    b.add(from.id);
    neighbors.set(from.id, a);
    neighbors.set(to.id, b);
  };

  for (const item of items) {
    const action = item.actions[0];
    if (action?.kind === "swap") connect(item, action.linkedDownstream);
    const trigger = item.triggers[0];
    if (trigger?.kind === "price_relative_to_fill") {
      const upstream = byPubkey.get(trigger.upstream.toBase58());
      if (upstream && !prevById.has(item.id)) {
        const a = neighbors.get(item.id) ?? new Set<string>();
        const b = neighbors.get(upstream.id) ?? new Set<string>();
        a.add(upstream.id);
        b.add(item.id);
        neighbors.set(item.id, a);
        neighbors.set(upstream.id, b);
      }
    }
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const patched = new Map(items.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const sortedIds = [...byId.keys()].sort((a, b) => {
    const l = byId.get(a)!;
    const r = byId.get(b)!;
    return Number(BigInt(l.nonce ?? "0") - BigInt(r.nonce ?? "0"));
  });

  for (const id of sortedIds) {
    if (visited.has(id)) continue;
    const stack = [id];
    const component: string[] = [];
    visited.add(id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const next of neighbors.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    if (component.length <= 1) continue;

    const start =
      component.find((candidate) => !prevById.has(candidate)) ??
      component.sort((a, b) => {
        const l = byId.get(a)!;
        const r = byId.get(b)!;
        return Number(BigInt(l.nonce ?? "0") - BigInt(r.nonce ?? "0"));
      })[0];

    const order: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur && !seen.has(cur) && component.includes(cur)) {
      order.push(cur);
      seen.add(cur);
      cur = nextById.get(cur);
    }
    for (const rest of component) {
      if (!seen.has(rest)) order.push(rest);
    }

    const first = byId.get(order[0]);
    const chainId = `chain_${first?.pubkey?.slice(0, 12) ?? order[0]}`;
    for (let position = 0; position < order.length; position += 1) {
      const item = byId.get(order[position]);
      if (!item) continue;
      const nextId = nextById.get(item.id);
      patched.set(item.id, {
        ...item,
        link: {
          chainId,
          position,
          total: order.length,
          next: nextId ? { kind: "rule", ruleId: nextId } : null,
          isHead: position === 0,
        },
      });
    }
  }

  return items.map((item) => patched.get(item.id) ?? item);
}

export async function fetchOwnedOnChainAutomations(
  connection: Connection,
  owner: PublicKey,
): Promise<Automation[]> {
  // Demo mode: return the seeded strategies instead of reading PDAs off
  // Solana. This is what populates Active Strategies with dummy triggers
  // + executions for the public demo — no RPC involved.
  if (isDemoMode()) return seedDemoAutomations();
  if (!isProgramConfigured()) return [];

  const dummy = Keypair.generate();
  const dummyWallet = {
    publicKey: dummy.publicKey,
    signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs,
    payer: dummy,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = getProgram(connection, dummyWallet as any);

  const rows = await program.account.automation.all([
    { memcmp: { offset: OWNER_MEMCMP_OFFSET, bytes: owner.toBase58() } },
  ]);
  const built = await Promise.all(
    rows.map((row) =>
      automationFromOnChain(connection, {
        publicKey: row.publicKey,
        account: row.account,
      }),
    ),
  );

  return reconstructChainLinks(
    built
      .filter((item): item is Automation => item !== null)
      .sort((l, r) => Date.parse(r.createdAt) - Date.parse(l.createdAt)),
  );
}

export function mergeOnChainAutomations(
  local: Automation[],
  remote: Automation[],
): Automation[] {
  const byKey = new Map<string, Automation>();
  const keyFor = (item: Automation) => item.pubkey ?? item.id;

  for (const item of remote) byKey.set(keyFor(item), item);
  for (const item of local) {
    const key = keyFor(item);
    const onChain = item.pubkey ? byKey.get(key) : null;
    if (!onChain) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, {
      ...onChain,
      ...item,
      runs: Math.max(item.runs || 0, onChain.runs || 0),
      running: onChain.running,
      lastCheck: onChain.lastCheck,
      createdAt: onChain.createdAt || item.createdAt,
      nonce: onChain.nonce ?? item.nonce,
      executedAt: onChain.executedAt,
      closedAt: undefined,
    });
  }

  return [...byKey.values()].sort((l, r) => Date.parse(r.createdAt) - Date.parse(l.createdAt));
}
