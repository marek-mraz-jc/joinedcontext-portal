//! Serving the apps a project builds on the platform (AP-12, AP-14, AP-17).

/// A build pod per App and its own build cache (AP-130, AP-131).
pub mod build_pods;
/// A lane's `status.build`, checked against the forge and published (AP-101, AP-104).
pub mod built;
/// The reconciler that compiles an App into its runtime and its grants (T-0227).
pub mod converge;
/// The default group of every App role, committed with the role (AP-118).
pub mod default_groups;
pub mod fetch;
pub mod functions;
pub mod kube;
/// An App name is unique in the organization (AP-14a).
pub mod names;
/// A project's own namespace for its pod-backed Apps (AP-116).
pub mod project_namespace;
pub mod reconciler;
/// A person's roles in an application (ADR-N-027).
pub mod roles;
pub mod static_host;
