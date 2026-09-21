//! The internal listener (AG-52): every route the credential proxy, the agent runner, the pipeline
//! runner and the gateway call back on, and nothing else. It is served on its own port with no
//! session layer and no CSRF guard, so each handler authenticates its caller's bearer through
//! `crate::auth::internal` before it reads anything. A `/internal/` route lives here and nowhere
//! else, so a handler cannot be added to the wrong listener by being written in the wrong file.

use axum::Router;

use crate::state::AppState;

pub mod agent_runs;
pub mod pipeline_tests;
pub mod previews;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(agent_runs::router())
        .merge(pipeline_tests::router())
        .merge(previews::router())
}
