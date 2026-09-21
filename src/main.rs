use joinedcontext_portal::config::Config;
use joinedcontext_portal::{server, telemetry};

#[tokio::main]
async fn main() {
    // OPS-15: JSON lines on stdout, nothing on disk.
    if let Err(err) = tracing::subscriber::set_global_default(telemetry::log_subscriber(
        std::io::stdout,
        telemetry::log_filter(),
    )) {
        eprintln!("Logging error: {err}");
        std::process::exit(1);
    }

    let config = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("Configuration error: {err}");
            std::process::exit(1);
        }
    };

    if let Err(err) = server::serve(config).await {
        eprintln!("Server error: {err}");
        std::process::exit(1);
    }
}
