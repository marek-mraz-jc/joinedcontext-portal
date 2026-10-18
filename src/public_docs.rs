//! The public documentation (T-4063): the API chapter and the User Guide, served to anyone at
//! `/docs/{chapter}/{page}`, so a citizen with no account can read how to use a public Endpoint
//! (API/00 §1). The pages are the markdown of a pinned docs commit, bundled by
//! `scripts/public-docs.sh`; no other chapter is in the bundle, so none can be served.
//!
//! The markdown is rendered on the server with raw HTML shown as text and every link either
//! relative, `http(s)` or `mailto`, so a page carries no script whatever the source holds.

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag};
use rust_embed::RustEmbed;

use crate::state::AppState;

#[derive(RustEmbed)]
#[folder = "public-docs"]
#[include = "API/*.md"]
#[include = "User-Guide/*.md"]
#[include = "COMMIT"]
struct Pages;

/// The chapters whose pages are public; the bundle holds no other.
const CHAPTERS: [&str; 2] = ["API", "User-Guide"];

pub fn router() -> Router<AppState> {
    Router::new().route("/docs/{chapter}/{page}", get(serve))
}

async fn serve(Path((chapter, page)): Path<(String, String)>) -> Response {
    match render(&chapter, page.strip_suffix(".md").unwrap_or(&page)) {
        Some(document) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "public, max-age=300"),
            ],
            document,
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "No such page in the public documentation\n",
        )
            .into_response(),
    }
}

/// The page as a whole HTML document; `None` for a chapter that is not public or a page that is
/// not in the bundle.
pub fn render(chapter: &str, page: &str) -> Option<String> {
    let named = !page.is_empty()
        && page
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !CHAPTERS.contains(&chapter) || !named {
        return None;
    }
    let file = Pages::get(&format!("{chapter}/{page}.md"))?;
    let text = std::str::from_utf8(&file.data).ok()?;
    let (title, body) = split_front_matter(text);
    let title = title.or_else(|| first_heading(body)).unwrap_or(page);
    let mut content = String::new();
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    html::push_html(&mut content, Parser::new_ext(body, options).map(safe));
    let commit = docs_commit();
    Some(format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n<main>\n{content}</main>\n\
         <footer><p>joinedcontext platform documentation, {chapter}, docs {commit}, \
         Portal {release}</p></footer>\n</body>\n</html>\n",
        title = escape(title),
        commit = escape(short(&commit)),
        release = escape(&release()),
    ))
}

/// The docs commit the bundle was made from (`public-docs/COMMIT`), which the deployment pins
/// beside the Portal's digest (T-4483).
pub fn docs_commit() -> String {
    Pages::get("COMMIT")
        .and_then(|file| String::from_utf8(file.data.into_owned()).ok())
        .map(|commit| commit.trim().to_owned())
        .unwrap_or_default()
}

/// The release these pages belong to: the Portal's version and, in an image, the commit it was
/// built from (the `JC_PORTAL_COMMIT` build argument, T-4483).
pub fn release() -> String {
    match option_env!("JC_PORTAL_COMMIT").map(str::trim) {
        Some(built) if !built.is_empty() => format!("{} {}", crate::APP_VERSION, short(built)),
        _ => crate::APP_VERSION.to_owned(),
    }
}

fn short(commit: &str) -> &str {
    commit.get(..12).unwrap_or(commit)
}

const STYLE: &str = "body{font:16px/1.6 system-ui,sans-serif;max-width:52rem;margin:0 auto;\
padding:1rem;color:#1b1f24;background:#fff}pre,code{font-family:ui-monospace,monospace}\
pre{overflow-x:auto;padding:.75rem;background:#f4f5f7}table{border-collapse:collapse;\
display:block;overflow-x:auto}td,th{border:1px solid #ccd;padding:.25rem .5rem}\
footer{color:#5b636e;font-size:.875rem}@media (prefers-color-scheme:dark){body{color:#e6e8eb;\
background:#14171a}pre{background:#1e2226}a{color:#8ab4ff}footer{color:#a0a8b3}}";

/// The `title:` of a page's front matter and the markdown after it.
fn split_front_matter(text: &str) -> (Option<&str>, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return (None, text);
    };
    let Some(end) = rest.find("\n---\n") else {
        return (None, text);
    };
    let title = rest[..end]
        .lines()
        .find_map(|line| line.strip_prefix("title:"))
        .map(|title| title.trim().trim_matches(['"', '\'']))
        .filter(|title| !title.is_empty());
    (title, &rest[end + "\n---\n".len()..])
}

fn first_heading(body: &str) -> Option<&str> {
    body.lines()
        .find_map(|line| line.strip_prefix("# "))
        .map(str::trim)
}

/// Raw HTML becomes text and every link a safe one; nothing else changes.
fn safe(event: Event<'_>) -> Event<'_> {
    match event {
        Event::Html(raw) | Event::InlineHtml(raw) => Event::Text(raw),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type,
            dest_url: link(dest_url),
            title,
            id,
        }),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type,
            dest_url: link(dest_url),
            title,
            id,
        }),
        other => other,
    }
}

/// `http(s)` and `mailto` stay, any other scheme becomes `#`; a relative link to another page
/// loses its `.md`, so `07-websocket.md#limits` opens `07-websocket#limits` beside it.
fn link(dest: CowStr<'_>) -> CowStr<'_> {
    let bare: String = dest
        .chars()
        .filter(|c| !c.is_ascii_whitespace() && !c.is_ascii_control())
        .collect::<String>()
        .to_ascii_lowercase();
    if let Some((scheme, _)) = bare.split_once(':') {
        if !scheme.contains(['/', '#', '?']) {
            return if matches!(scheme, "http" | "https" | "mailto") {
                dest
            } else {
                CowStr::Borrowed("#")
            };
        }
    }
    let (path, anchor) = dest.split_at(dest.find('#').unwrap_or(dest.len()));
    match path
        .strip_suffix(".md")
        .map(|stem| format!("{stem}{anchor}"))
    {
        Some(rewritten) => CowStr::from(rewritten),
        None => dest,
    }
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(markdown: &str) -> String {
        let mut out = String::new();
        html::push_html(
            &mut out,
            Parser::new_ext(markdown, Options::empty()).map(safe),
        );
        out
    }

    #[test]
    fn every_bundled_page_renders_with_a_title() {
        let mut pages = 0;
        for path in Pages::iter().filter(|path| path.ends_with(".md")) {
            let (chapter, file) = path.split_once('/').expect("chapter/page.md");
            let page = file.strip_suffix(".md").expect("a markdown page");
            let document = render(chapter, page).unwrap_or_else(|| panic!("{path} renders"));
            assert!(!document.contains("<title></title>"), "{path} has a title");
            pages += 1;
        }
        assert!(pages > 10, "the bundle holds the API and User Guide pages");
    }

    #[test]
    fn the_websocket_guide_is_titled_from_its_front_matter() {
        let document = render("API", "07-websocket").expect("the guide is public");
        assert!(document.contains("<title>Live Updates over WebSocket</title>"));
        assert!(
            !document.contains("sidebar_position"),
            "front matter is not shown"
        );
    }

    #[test]
    fn only_the_public_chapters_and_plain_names_are_served() {
        for (chapter, page) in [
            ("Operations", "00-intro"),
            ("Deployment", "00-intro"),
            ("Architecture", "09-portal"),
            ("api", "07-websocket"),
            ("API", ""),
            ("API", "..%2FOperations%2F00-intro"),
            ("API", "../Operations/00-intro"),
            ("API", "no-such-page"),
        ] {
            assert!(
                render(chapter, page).is_none(),
                "{chapter}/{page} is not served"
            );
        }
    }

    #[test]
    fn raw_html_is_text_and_links_are_safe() {
        let out = rendered(
            "<script>alert(1)</script>\n\n[a](javascript:alert(1)) [b](JaVa\tScript:x) \
             [c](07-websocket.md#limits) [d](https://example.org/x.md) [e](mailto:a@b.c) \
             [f](data:text/html,x) [g](#here) ![i](vbscript:x)",
        );
        assert!(!out.contains("<script"), "{out}");
        assert!(out.contains("&lt;script&gt;"), "{out}");
        assert!(!out.to_ascii_lowercase().contains("javascript:"), "{out}");
        assert!(
            !out.contains("data:") && !out.contains("vbscript:"),
            "{out}"
        );
        assert!(out.contains("href=\"07-websocket#limits\""), "{out}");
        assert!(out.contains("href=\"https://example.org/x.md\""), "{out}");
        assert!(out.contains("href=\"mailto:a@b.c\""), "{out}");
        assert!(out.contains("href=\"#here\""), "{out}");
    }

    #[test]
    fn front_matter_without_a_title_falls_back_to_the_heading() {
        assert_eq!(split_front_matter("---\nx: 1\n---\n# H\n").0, None);
        assert_eq!(
            first_heading("intro\n# The heading \n"),
            Some("The heading")
        );
        assert_eq!(
            split_front_matter("# no front matter\n"),
            (None, "# no front matter\n")
        );
        assert_eq!(
            split_front_matter("---\ntitle: 'Q'\n---\nbody").0,
            Some("Q")
        );
        assert_eq!(
            escape("<a href=\"x\">&'"),
            "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
        );
    }
}
