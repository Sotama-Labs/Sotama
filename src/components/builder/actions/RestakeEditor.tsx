"use client";

import { useEffect, useRef } from "react";
import type { DraftRestake } from "@/lib/types";
import { CLUSTER, CLUSTER_LABEL } from "@/lib/rpc";
import { getDefaultVoteAccount } from "@/lib/staking-defaults";
import { AddressInput } from "../AddressInput";
import { EditorShell, FieldRow } from "../EditorShell";

/* The vote account is intentionally not surfaced as a UI knob —
   delegation target is decided by the cluster (Helius on mainnet, a
   random active validator on devnet) and silently filled into the
   draft so the on-chain `StakeRestake` action still gets a target.
   Users who care can override the auto-pick later by editing the
   automation in localStorage; the goal here is to keep the staking
   flow opinionated and uncluttered. */

export function RestakeEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftRestake;
  onChange: (next: DraftRestake) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready = !!draft.stakeAccount && !!draft.voteAccount;

  // Mirror draft + onChange in refs so the async fill below always
  // reads the *latest* draft (and avoids overwriting whatever the user
  // typed into stakeAccount between mount and the RPC's resolve).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (draftRef.current.voteAccount) return;
    let alive = true;
    getDefaultVoteAccount().then((v) => {
      if (!alive || !v) return;
      const cur = draftRef.current;
      if (!cur.voteAccount) onChangeRef.current({ ...cur, voteAccount: v });
    });
    return () => {
      alive = false;
    };
  }, []);

  const validatorBlurb =
    CLUSTER === "mainnet-beta"
      ? "Re-delegated to the Helius validator each cycle."
      : `Re-delegated to a random ${CLUSTER_LABEL[CLUSTER]} validator each cycle.`;

  return (
    <EditorShell
      title="Restake the reward"
      side="then"
      onBack={onBack}
      onConfirm={onConfirm}
      ready={ready}
      confirmLabel="Confirm"
    >
      <FieldRow label="Stake account">
        <AddressInput
          value={draft.stakeAccount}
          onChange={(v) => onChange({ ...draft, stakeAccount: v })}
          onCommit={ready ? onConfirm : undefined}
        />
      </FieldRow>
      <div
        className="hig-caption-1"
        style={{ color: "var(--label-secondary)", padding: "0.25rem 0.125rem" }}
      >
        {validatorBlurb} The full balance is re-delegated each time the
        trigger fires — accrued rewards become active stake on the next
        epoch.
      </div>
    </EditorShell>
  );
}
