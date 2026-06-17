"use client";

import { AutomationWorkspace } from "@/components/AutomationWorkspace";

/**
 * Public demo entry. Renders the full Sotama workspace with no access
 * gate — the maintenance page links here. With NEXT_PUBLIC_DEMO_MODE=true
 * (set on the beta deployment) the workspace runs on dummy data: a fake
 * auto-connected wallet, seeded strategies + executions, simulated funding
 * and closing, and zero Solana RPC. Live crypto prices still come from the
 * free Jupiter API; tickers/previews from the free Pyth Hermes endpoint.
 */
export default function DemoPage() {
  return <AutomationWorkspace />;
}
