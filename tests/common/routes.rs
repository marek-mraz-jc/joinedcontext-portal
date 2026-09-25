//! The inventory of every route the Portal serves, read from its source: the route coverage gate
//! (T-0840) and the authorization matrix (T-2797) both hold a row per route and check it here.

/// Every `.route("…", …)` under `src/`, as `(METHOD, path)` with the `/api/v1` prefix off.
///
/// ponytail: the source is the inventory because `axum`'s `Router` cannot be asked what it
/// holds. A router built inside a `#[cfg(test)]` module is a fixture, so the scan stops there.
pub fn routes_in_source() -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read the crate's sources") {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read a source file");
            let text = text.split("\n#[cfg(test)]").next().unwrap_or_default();
            found.extend(routes_in(text));
        }
    }
    found.sort();
    found.dedup();
    found
}

fn routes_in(text: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find(".route(") {
        let open = from + at + ".route(".len() - 1;
        let mut depth = 0usize;
        let mut end = open;
        for (offset, ch) in text[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + offset;
                        break;
                    }
                }
                _ => {}
            }
        }
        let call = &text[open..=end];
        from = end + 1;
        let Some(path) = call.split('"').nth(1) else {
            continue;
        };
        let path = path.strip_prefix("/api/v1").unwrap_or(path);
        for method in ["get", "post", "put", "patch", "delete"] {
            if names_method(call, method) {
                found.push((method.to_uppercase(), path.to_owned()));
            }
        }
    }
    found
}

/// `get(` as a method of this route, not the tail of a handler's name.
fn names_method(call: &str, method: &str) -> bool {
    let needle = format!("{method}(");
    let mut from = 0;
    while let Some(at) = call[from..].find(&needle) {
        let start = from + at;
        let before = call[..start].chars().next_back().unwrap_or(' ');
        if !before.is_alphanumeric() && before != '_' {
            return true;
        }
        from = start + needle.len();
    }
    false
}
