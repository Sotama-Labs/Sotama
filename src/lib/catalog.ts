import type { ActionOption, TriggerOption } from "./types";

export const TRIGGERS: TriggerOption[] = [
  { id: "price_below", label: "SOL price drops below", needsValue: true, valueType: "price", unit: "USD" },
  { id: "price_above", label: "SOL price goes above", needsValue: true, valueType: "price", unit: "USD" },
];

export const ACTIONS: ActionOption[] = [
  { id: "swap_sol_usdc", label: "swap SOL to USDC", needsValue: true, valueType: "amount", unit: "SOL" },
  { id: "swap_usdc_sol", label: "swap USDC to SOL", needsValue: true, valueType: "amount", unit: "USDC" },
];
