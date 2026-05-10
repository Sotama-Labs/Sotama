pub mod decoder;
pub mod subscriber;

#[derive(Clone, Debug)]
pub enum AutomationLifecycle {
    Created(crate::state::AutomationCreatedEvent),
    Updated(crate::state::AutomationUpdatedEvent),
    Finished(crate::state::AutomationFinishedEvent),
}
