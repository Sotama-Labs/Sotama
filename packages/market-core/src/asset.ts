export type AssetClass = "Crypto" | "Equity" | "Commodity" | "FX" | "Metal";

export type AssetRef = {
  symbol: string;
  displaySymbol: string;
  name: string;
  assetClass: AssetClass;
  logo?: string;
  mint?: string;
  decimals?: number;
  metadataSource?: "canonical" | "jupiter" | "user";
};
