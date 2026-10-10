//! The server half of this App: `/api/items` on the App's own host, kept in the App's own
//! schema (`migrations/`). A component holds no socket, environment, file or credential
//! (AP-147); the host answers `sql` as this App and no other.

use jc_app_sdk::http::{Params, Request, Response, Router};
use jc_app_sdk::sql;
use serde::Deserialize;

/// The longest text an item keeps, as the table's check says.
pub const MAX_TEXT: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewItem {
    pub text: String,
}

/// The text to keep, trimmed, or why it is refused.
pub fn checked(item: &NewItem) -> Result<String, String> {
    let text = item.text.trim();
    if text.is_empty() {
        return Err("text is empty".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(format!("text is longer than {MAX_TEXT} characters"));
    }
    Ok(text.to_owned())
}

fn list(_: &Request, _: &Params) -> Response {
    match sql::query(
        "select id, text, created_at::text as created_at from items order by id desc limit 100",
        &[],
    ) {
        Ok(rows) => Response::json(200, &sql::objects(&rows)),
        Err(err) => Response::from_sql(err),
    }
}

fn create(request: &Request, _: &Params) -> Response {
    let item: NewItem = match request.json() {
        Ok(item) => item,
        Err(refused) => return refused,
    };
    let text = match checked(&item) {
        Ok(text) => text,
        Err(why) => return Response::problem(422, "Unprocessable Entity", &why),
    };
    match sql::query(
        "insert into items (text) values ($1) returning id, text, created_at::text as created_at",
        &[text.into()],
    ) {
        Ok(rows) => match sql::objects(&rows).into_iter().next() {
            Some(row) => Response::json(201, &row),
            None => Response::problem(500, "Internal Server Error", "the insert returned no row"),
        },
        Err(err) => Response::from_sql(err),
    }
}

pub fn handle(request: Request) -> Response {
    Router::new()
        .get("/api/items", list)
        .post("/api/items", create)
        .handle(&request)
}

jc_app_sdk::app!(handle);

#[cfg(test)]
mod tests {
    use super::*;

    fn item(text: &str) -> NewItem {
        NewItem { text: text.into() }
    }

    #[test]
    fn a_text_is_trimmed_and_kept() {
        assert_eq!(checked(&item("  bike lane  ")), Ok("bike lane".into()));
    }

    #[test]
    fn an_empty_or_too_long_text_is_refused() {
        assert!(checked(&item("   ")).is_err());
        assert!(checked(&item(&"é".repeat(MAX_TEXT))).is_ok());
        assert!(checked(&item(&"é".repeat(MAX_TEXT + 1))).is_err());
    }

    #[test]
    fn an_unknown_route_is_not_found() {
        let request = Request {
            method: "GET".into(),
            path: "/api/nothing".into(),
            ..Request::default()
        };
        assert_eq!(handle(request).status, 404);
    }
}
