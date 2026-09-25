//! The step of "Build an app" the Portal takes itself (T-2696, API/04 §Paths): the endpoints
//! chosen at the first step open the app builder on them. The person names the app, says what it
//! should do and starts the run there; the conversation starts no run (AG-11).

use super::integrate::Taken;
use super::*;

/// The first question of the path, as its `question` event carries it in `step`.
pub(super) const ENDPOINTS_STEP: &str = "build-app-endpoints";

impl Driver {
    /// The chosen endpoints hand over to the builder; words instead of a choice go to the model.
    pub(super) async fn build_taken(&self, answers: &Value) -> Result<Option<Taken>, String> {
        let endpoints: Vec<String> = match answers.get("answer") {
            Some(Value::Array(chosen)) => chosen
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            Some(Value::String(one)) => vec![one.clone()],
            _ => Vec::new(),
        };
        if endpoints.is_empty() {
            return Ok(None);
        }
        let prose = format!(
            "The app builder opens on {}. Name the app, say what it should do and start it \
             there.",
            endpoints
                .iter()
                .map(|name| format!("'{name}'"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        self.thought(&prose).await?;
        self.event(
            "navigate",
            json!({
                "route": format!("/projects/{}/apps/new", self.project),
                "prefill": { "endpoints": endpoints },
            }),
        )
        .await?;
        Ok(Some(Taken::Done(prose)))
    }
}
