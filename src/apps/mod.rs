//! Serving the apps a project builds on the platform (AP-12, AP-14, AP-17).

/// A lane's `status.build`, checked against the forge and published (AP-101, AP-104).
pub mod built;
/// The reconciler that compiles an App into its runtime and its grants (T-0227).
pub mod converge;
pub mod fetch;
pub mod functions;
pub mod kube;
/// An App name is unique in the organization (AP-14a).
pub mod names;
pub mod reconciler;
/// A person's roles in an application (ADR-N-027).
pub mod roles;
pub mod static_host;
