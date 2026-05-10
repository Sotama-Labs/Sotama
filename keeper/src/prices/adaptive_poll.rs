use std::time::Duration;

/// Distance-based poll interval. Distance is `|spot - threshold| / threshold` for absolute
/// triggers, or `|ratio - target| / target` for ratio triggers.
pub fn poll_interval(distance: f64) -> Duration {
    let d = distance.abs();
    if d < 0.005 { Duration::from_secs(1) }
    else if d < 0.02 { Duration::from_secs(3) }
    else if d < 0.05 { Duration::from_secs(6) }
    else { Duration::from_secs(30) }
}

/// Pick the tightest interval across all rules watching a feed.
pub fn min_interval(distances: &[f64]) -> Duration {
    distances.iter().map(|&d| poll_interval(d)).min().unwrap_or(Duration::from_secs(30))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_boundaries() {
        assert_eq!(poll_interval(0.001), Duration::from_secs(1));
        assert_eq!(poll_interval(0.01), Duration::from_secs(3));
        assert_eq!(poll_interval(0.03), Duration::from_secs(6));
        assert_eq!(poll_interval(0.10), Duration::from_secs(30));
    }

    #[test]
    fn min_picks_tightest() {
        assert_eq!(min_interval(&[0.10, 0.001, 0.04]), Duration::from_secs(1));
    }

    #[test]
    fn empty_defaults_to_30s() {
        assert_eq!(min_interval(&[]), Duration::from_secs(30));
    }
}
