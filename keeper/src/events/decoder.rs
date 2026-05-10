use super::AutomationLifecycle;
use crate::state::{
    anchor_event_discriminator, AutomationCreatedEvent, AutomationFilledEvent,
    AutomationFinishedEvent, AutomationUpdatedEvent,
};
use base64::Engine;
use borsh::BorshDeserialize;
use once_cell::sync::Lazy;

const PROGRAM_DATA_PREFIX: &str = "Program data: ";

static D_CREATED: Lazy<[u8; 8]> = Lazy::new(|| anchor_event_discriminator("AutomationCreated"));
static D_UPDATED: Lazy<[u8; 8]> = Lazy::new(|| anchor_event_discriminator("AutomationUpdated"));
static D_FINISHED: Lazy<[u8; 8]> = Lazy::new(|| anchor_event_discriminator("AutomationFinished"));
static D_FILLED: Lazy<[u8; 8]> = Lazy::new(|| anchor_event_discriminator("AutomationFilled"));

/// Decode every Anchor lifecycle event from a single transaction's logs.
pub fn decode_logs(logs: &[String]) -> Vec<AutomationLifecycle> {
    let mut out = Vec::new();
    for line in logs {
        let Some(payload_b64) = line.strip_prefix(PROGRAM_DATA_PREFIX) else { continue };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload_b64.trim()) else { continue };
        if bytes.len() < 8 { continue }
        let (disc, rest) = bytes.split_at(8);
        let disc: [u8; 8] = disc.try_into().unwrap();
        if disc == *D_CREATED {
            if let Ok(ev) = AutomationCreatedEvent::try_from_slice(rest) {
                out.push(AutomationLifecycle::Created(ev));
            }
        } else if disc == *D_UPDATED {
            if let Ok(ev) = AutomationUpdatedEvent::try_from_slice(rest) {
                out.push(AutomationLifecycle::Updated(ev));
            }
        } else if disc == *D_FINISHED {
            if let Ok(ev) = AutomationFinishedEvent::try_from_slice(rest) {
                out.push(AutomationLifecycle::Finished(ev));
            }
        } else if disc == *D_FILLED {
            if let Ok(ev) = AutomationFilledEvent::try_from_slice(rest) {
                out.push(AutomationLifecycle::Filled(ev));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AutomationFilledEvent;
    use solana_sdk::pubkey::Pubkey;

    fn encode_event(name: &str, payload: Vec<u8>) -> String {
        let mut bytes = anchor_event_discriminator(name).to_vec();
        bytes.extend_from_slice(&payload);
        format!("Program data: {}", base64::engine::general_purpose::STANDARD.encode(&bytes))
    }

    #[test]
    fn decodes_created_event() {
        let ev = AutomationCreatedEvent {
            automation: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            nonce: 7,
            trigger_kind: 1,
            action_kind: 2,
            trigger_pubkey: Pubkey::new_unique(),
            cadence_kind: 0,
        };
        let logs = vec![encode_event("AutomationCreated", borsh::to_vec(&ev).unwrap())];
        let out = decode_logs(&logs);
        assert_eq!(out.len(), 1);
        match &out[0] {
            AutomationLifecycle::Created(got) => assert_eq!(got, &ev),
            _ => panic!("expected Created"),
        }
    }

    #[test]
    fn decodes_filled_event() {
        let ev = AutomationFilledEvent {
            automation: Pubkey::new_unique(),
            input_amount: 1_000_000_000,
            output_amount: 45_678_000,
            fill_slot: 999_000,
        };
        let logs = vec![encode_event("AutomationFilled", borsh::to_vec(&ev).unwrap())];
        let out = decode_logs(&logs);
        assert_eq!(out.len(), 1);
        match &out[0] {
            AutomationLifecycle::Filled(got) => assert_eq!(got, &ev),
            _ => panic!("expected Filled"),
        }
    }

    #[test]
    fn decodes_multiple_events_in_one_tx() {
        let created = AutomationCreatedEvent {
            automation: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            nonce: 1,
            trigger_kind: 1,
            action_kind: 4,
            trigger_pubkey: Pubkey::new_unique(),
            cadence_kind: 0,
        };
        let filled = AutomationFilledEvent {
            automation: Pubkey::new_unique(),
            input_amount: 500_000,
            output_amount: 100_000,
            fill_slot: 42,
        };
        let logs = vec![
            encode_event("AutomationCreated", borsh::to_vec(&created).unwrap()),
            encode_event("AutomationFilled", borsh::to_vec(&filled).unwrap()),
        ];
        let out = decode_logs(&logs);
        assert_eq!(out.len(), 2);
        assert!(matches!(out[0], AutomationLifecycle::Created(_)));
        assert!(matches!(out[1], AutomationLifecycle::Filled(_)));
    }

    #[test]
    fn skips_unrelated_program_data_lines() {
        let logs = vec!["Program data: AAAAAAAAAAA=".to_string()];
        let out = decode_logs(&logs);
        assert!(out.is_empty());
    }

    #[test]
    fn skips_non_program_data_lines() {
        let logs = vec!["Program log: hello".to_string(), "Program 5U9G... invoke [1]".to_string()];
        let out = decode_logs(&logs);
        assert!(out.is_empty());
    }
}
