export type ValueType = "price" | "amount";

export type TriggerOption = {
  id: "price_below" | "price_above";
  label: string;
  needsValue: true;
  valueType: "price";
  unit: "USD";
};

export type ActionOption = {
  id: "swap_sol_usdc" | "swap_usdc_sol";
  label: string;
  needsValue: true;
  valueType: "amount";
  unit: "SOL" | "USDC";
};

export type Option = TriggerOption | ActionOption;

export type Slot<O extends Option = Option> = {
  choice: O | null;
  value: string | number | null;
};

export type Automation = {
  id: string;
  triggers: Slot<TriggerOption>[];
  actions: Slot<ActionOption>[];
  running: boolean;
  runs: number;
  lastCheck: string;
};

export type Execution = {
  id: string;
  strategyId: string;
  from: { token: string; amount: number };
  to: { token: string; amount: number };
  price: number;
  when: string;
  txShort: string;
};

export type Tweaks = {
  appearance: "auto" | "light" | "dark";
  accent: string;
};
