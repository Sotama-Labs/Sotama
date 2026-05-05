use solana_sdk::pubkey::Pubkey;

use crate::indexer::WatchedSet;

#[derive(Debug, Clone)]
pub struct Shard {
    pub id: usize,
    pub accounts: Vec<Pubkey>,
}

pub fn shards(set: &WatchedSet, shard_size: usize) -> Vec<Shard> {
    let mut keys = set.watched_accounts();
    // Sort for stable ordering across rebuilds — easier debugging.
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
