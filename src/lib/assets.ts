import type { AssetClass, AssetRef } from "./types";

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  Crypto: "Crypto",
  Equity: "Equity",
  Commodity: "Commodity",
  FX: "FX",
  Metal: "Metal",
};

/** Asset classes with no live feed data available from the current provider. */
export const CLASSES_COMING_SOON: ReadonlySet<AssetClass> = new Set(["Commodity"]);

/** Strip leading region prefix from a Pyth base symbol. "US.NVDA" → "NVDA" */
export function displaySymbolFromBase(base: string): string {
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(dot + 1);
}

/** Parse a Pyth pair symbol into base + quote. "Equity.US.NVDA/USD" → { base: "US.NVDA", quote: "USD" } */
export function parsePythSymbol(symbol: string): { base: string; quote: string } | null {
  const slash = symbol.lastIndexOf("/");
  if (slash === -1) return null;
  const quote = symbol.slice(slash + 1);
  const dot = symbol.indexOf(".");
  if (dot === -1) return null;
  // Sanity-check the asset-type-prefix dot precedes the base/quote
  // separator. Without this guard, a malformed symbol like "BTC/EUR.X"
  // would slice("EUR.X".indexOf(".") + 1, slash) with negative bounds,
  // producing junk.
  if (dot >= slash) return null;
  const base = symbol.slice(dot + 1, slash);
  if (!base) return null;
  return { base, quote };
}

function asset(
  symbol: string,
  displaySymbol: string,
  name: string,
  assetClass: AssetClass,
  extras: Partial<AssetRef> = {},
): AssetRef {
  return { symbol, displaySymbol, name, assetClass, ...extras };
}

export const POPULAR_ASSETS: Record<AssetClass, AssetRef[]> = {
  Crypto: [
    asset("SOL", "SOL", "Solana", "Crypto", { mint: "So11111111111111111111111111111111111111112", decimals: 9, metadataSource: "canonical" }),
    asset("BTC", "BTC", "Bitcoin", "Crypto"),
    asset("ETH", "ETH", "Ethereum", "Crypto"),
    asset("USDC", "USDC", "USD Coin", "Crypto", { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, metadataSource: "canonical" }),
    asset("JUP", "JUP", "Jupiter", "Crypto", { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, metadataSource: "canonical" }),
    asset("BONK", "BONK", "Bonk", "Crypto", { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5, metadataSource: "canonical" }),
    asset("WIF", "WIF", "dogwifhat", "Crypto"),
    asset("PYTH", "PYTH", "Pyth Network", "Crypto", { mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", decimals: 6, metadataSource: "canonical" }),
  ],
  Equity: [
    asset("US.NVDA", "NVDA", "NVIDIA Corp", "Equity"),
    asset("US.AAPL", "AAPL", "Apple Inc", "Equity"),
    asset("US.MSFT", "MSFT", "Microsoft Corp", "Equity"),
    asset("US.TSLA", "TSLA", "Tesla Inc", "Equity"),
    asset("US.AMZN", "AMZN", "Amazon.com Inc", "Equity"),
    asset("US.GOOGL", "GOOGL", "Alphabet Inc", "Equity"),
    asset("US.META", "META", "Meta Platforms Inc", "Equity"),
    asset("US.NFLX", "NFLX", "Netflix Inc", "Equity"),
    asset("US.SPY", "SPY", "SPDR S&P 500 ETF", "Equity"),
    asset("US.QQQ", "QQQ", "Invesco QQQ Trust", "Equity"),
  ],
  Commodity: [
    asset("WTI", "WTI", "Crude Oil (WTI)", "Commodity"),
    asset("BRENT", "BRENT", "Crude Oil (Brent)", "Commodity"),
    asset("NG", "NG", "Natural Gas", "Commodity"),
    asset("CORN", "CORN", "Corn", "Commodity"),
    asset("WHEAT", "WHEAT", "Wheat", "Commodity"),
    asset("SOYB", "SOYB", "Soybeans", "Commodity"),
  ],
  FX: [
    asset("USD", "USD", "US Dollar", "FX"),
    asset("EUR", "EUR", "Euro", "FX"),
    asset("GBP", "GBP", "British Pound", "FX"),
    asset("JPY", "JPY", "Japanese Yen", "FX"),
    asset("CHF", "CHF", "Swiss Franc", "FX"),
    asset("CAD", "CAD", "Canadian Dollar", "FX"),
    asset("AUD", "AUD", "Australian Dollar", "FX"),
    asset("NZD", "NZD", "New Zealand Dollar", "FX"),
    asset("SGD", "SGD", "Singapore Dollar", "FX"),
  ],
  Metal: [
    asset("XAU", "XAU", "Gold", "Metal"),
    asset("XAG", "XAG", "Silver", "Metal"),
    asset("XPD", "XPD", "Palladium", "Metal"),
    asset("XPT", "XPT", "Platinum", "Metal"),
  ],
};
