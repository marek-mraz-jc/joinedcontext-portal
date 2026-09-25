//! The process: structured logs, the variables the reconciler sets, bind, serve.
//!
//! In the pod the reconciler sets `JC_BIND_ADDRESS` to `0.0.0.0:8080`, the port the APISIX edge
//! upstreams to and the NetworkPolicy opens to nobody else (AP-26, AP-108). The loopback default
//! is for a laptop, where nothing stands in front of the process.

use std::sync::Arc;

use jc_app::{router, App, Config};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // One JSON object per line, which the cluster's log pipeline reads field by field.
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = Config::from_env()?;
    let bind = std::env::var("JC_BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8080".to_owned());
    tracing::info!(%bind, base = %config.base_path, "starting");

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, router(Arc::new(App::new(config))))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
