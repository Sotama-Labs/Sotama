use solana_sdk::pubkey::Pubkey;

use crate::indexer::WatchedSet;

#[derive(Debug, Clone)]
pub struct Shard {
    pub id: usize,
    pub accounts: Vec<Pubkey>,
}

/// Account-trigger shards (used by `subscriber.rs` for transactionSubscribe).
/// Price and stake monitors poll directly without the 40-account-cap, so
/// they don't need sharding.
pub fn shards(set: &WatchedSet, shard_size: usize) -> Vec<Shard> {
    let mut keys = set.account_watch_keys();
    keys.sort();
    let chunk_size = shard_size.max(1);
    keys.chunks(chunk_size)
        .enumerate()
        .map(|(id, chunk)| Shard {
            id,
            accounts: chunk.to_vec(),
        })
        .collect()
}
