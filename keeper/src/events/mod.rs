pub mod decoder;
pub mod subscriber;

#[derive(Clone, Debug)]
pub enum AutomationLifecycle {
    Created(crate::state::AutomationCreatedEvent),
    Updated(crate::state::AutomationUpdatedEvent),
    Finished(crate::state::AutomationFinishedEvent),
    /// Emitted after every successful `execute_swap` Jupiter CPI.
    /// Carries the actual amounts from the fill so the keeper can compute
    /// the effective USD per output unit and update the `FillCache`.
    Filled(crate::state::AutomationFilledEvent),
}
