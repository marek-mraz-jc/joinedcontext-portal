//! Completions through the proxy and what the prompts carry: the schema, the samples, the rows the kit reads (AP-56, AP-57).

use super::*;

impl Driver {
    /// One call through the proxy, asked twice when the first answer carries no text: a
    /// provider answers empty now and then, and a second call is cheaper than a failed run.
    pub(super) async fn complete(&self, user: &str) -> Result<String, String> {
        self.complete_with_system(&self.narrowed(&SYSTEM), user)
            .await
    }

    pub(super) async fn complete_with_system(
        &self,
        system: &str,
        user: &str,
    ) -> Result<String, String> {
        self.complete_within(system, user, OUTPUT_BUDGET).await
    }

    /// A provider that says the key's credit covers fewer output tokens than asked is asked
    /// once more within what it covers: most answers are far shorter than the budget, and a
    /// run should not stop over a ceiling it would not have reached.
    pub(super) async fn complete_within(
        &self,
        system: &str,
        user: &str,
        budget: u32,
    ) -> Result<String, String> {
        let first = match self.complete_once(system, user, budget).await {
            Err(CallError::Empty) => self.complete_once(system, user, budget).await,
            Err(CallError::Credit {
                affordable: Some(afford),
            }) if afford >= MIN_CREDIT_BUDGET && afford < budget => {
                self.complete_once(system, user, afford - afford / 20).await
            }
            other => other,
        };
        first.map_err(|err| err.said(budget))
    }

    /// Common HTTP execution for model calls through the proxy, handling 402 credits and budget cuts.
    async fn post_llm(&self, path: &str, body: &Value, budget: u32) -> Result<Value, CallError> {
        let response = self
            .http
            .post(format!("{}{path}", self.proxy_base))
            .bearer_auth(&self.bearer)
            .json(body)
            .send()
            .await
            .map_err(|err| {
                CallError::Failed(format!(
                    "the model call did not go through the proxy: {err}"
                ))
            })?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::PAYMENT_REQUIRED {
            return Err(CallError::Credit {
                affordable: affordable_tokens(&text),
            });
        }
        if !status.is_success() {
            let said = provider_said(&text);
            // The proxy's audit line carries the status alone, so a refusal is otherwise only
            // visible in the person's own conversation and never in the logs (T-2247).
            tracing::warn!(%status, provider = %said, "the model provider refused the call");
            return Err(CallError::Failed(refusal(status)));
        }
        let answer: Value = serde_json::from_str(&text)
            .map_err(|err| CallError::Failed(format!("the model's answer is not JSON: {err}")))?;
        let cut = answer
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| reason == "length")
            || answer
                .get("stop_reason")
                .and_then(Value::as_str)
                .is_some_and(|reason| reason == "max_tokens");
        if cut {
            return Err(CallError::Failed(format!(
                "the answer was cut at the output budget of {budget} tokens and nothing \
                 was applied; ask for less at once"
            )));
        }
        Ok(answer)
    }

    /// One call through the proxy, in the body the profile's provider reads (AG-53).
    pub(super) async fn complete_once(
        &self,
        system: &str,
        user: &str,
        budget: u32,
    ) -> Result<String, CallError> {
        let (path, body) = if self.provider == "anthropic" {
            (
                "/v1/llm/messages",
                json!({
                    "model": self.model,
                    "max_tokens": budget,
                    "system": system,
                    "messages": [{ "role": "user", "content": user }],
                }),
            )
        } else {
            (
                "/v1/llm/chat/completions",
                json!({
                    "model": self.model,
                    "max_tokens": budget,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": user },
                    ],
                }),
            )
        };
        let answer = self.post_llm(path, &body, budget).await?;
        // OpenAI-compatible: choices[0].message.content. Anthropic: content[].text, joined.
        if let Some(content) = answer
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
        {
            return Ok(content.to_owned());
        }
        let joined: String = answer
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        if joined.is_empty() {
            return Err(CallError::Empty);
        }
        Ok(joined)
    }

    /// One tool completion through the proxy with 402 retry and empty-answer retry (SDK-20).
    pub(super) async fn complete_tools(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[ToolSpec],
        budget: u32,
    ) -> Result<ToolAnswer, CallError> {
        let first = match self
            .complete_tools_once(system, messages, tools, budget)
            .await
        {
            Err(CallError::Empty) => {
                self.complete_tools_once(system, messages, tools, budget)
                    .await
            }
            Err(CallError::Credit {
                affordable: Some(afford),
            }) if afford >= MIN_CREDIT_BUDGET && afford < budget => {
                self.complete_tools_once(system, messages, tools, afford - afford / 20)
                    .await
            }
            other => other,
        };
        first
    }

    async fn complete_tools_once(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[ToolSpec],
        budget: u32,
    ) -> Result<ToolAnswer, CallError> {
        if self.provider == "anthropic" {
            let tools_json = tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema,
                    })
                })
                .collect::<Vec<_>>();
            let merged = merge_anthropic_messages(messages);
            let body = json!({
                "model": self.model,
                "max_tokens": budget,
                "system": system,
                "messages": merged,
                "tools": tools_json,
            });
            let answer = self.post_llm("/v1/llm/messages", &body, budget).await?;
            let mut text_parts = Vec::new();
            let mut calls = Vec::new();
            if let Some(content) = answer.get("content").and_then(Value::as_array) {
                for part in content {
                    let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
                    if part_type == "text" {
                        if let Some(t) = part.get("text").and_then(Value::as_str) {
                            text_parts.push(t);
                        }
                    } else if part_type == "tool_use" {
                        let id = part
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let name = part
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let input = part.get("input").cloned().unwrap_or(Value::Null);
                        calls.push(ToolCall { id, name, input });
                    }
                }
            }
            let text = if text_parts.is_empty() {
                None
            } else {
                Some(text_parts.join("\n"))
            };
            let input_tokens = usage_at(&answer, "/usage/input_tokens");
            let output_tokens = usage_at(&answer, "/usage/output_tokens");
            if text.as_deref().unwrap_or("").trim().is_empty() && calls.is_empty() {
                return Err(CallError::Empty);
            }
            Ok(ToolAnswer {
                text,
                calls,
                usage_tokens: input_tokens + output_tokens,
                input_tokens,
                output_tokens,
            })
        } else {
            let tools_json = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema,
                        }
                    })
                })
                .collect::<Vec<_>>();
            let mut full_messages = vec![json!({ "role": "system", "content": system })];
            full_messages.extend_from_slice(messages);
            let body = json!({
                "model": self.model,
                "max_tokens": budget,
                "messages": full_messages,
                "tools": tools_json,
            });
            let answer = self
                .post_llm("/v1/llm/chat/completions", &body, budget)
                .await?;
            let choice_msg = answer.pointer("/choices/0/message");
            let text = choice_msg
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut calls = Vec::new();
            if let Some(tool_calls) = choice_msg
                .and_then(|m| m.get("tool_calls"))
                .and_then(Value::as_array)
            {
                for tc in tool_calls {
                    let id = tc
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let name = tc
                        .pointer("/function/name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let input = if let Some(s) =
                        tc.pointer("/function/arguments").and_then(Value::as_str)
                    {
                        serde_json::from_str::<Value>(s).unwrap_or(Value::Null)
                    } else {
                        tc.pointer("/function/arguments")
                            .cloned()
                            .unwrap_or(Value::Null)
                    };
                    calls.push(ToolCall { id, name, input });
                }
            }
            let input_tokens = usage_at(&answer, "/usage/prompt_tokens");
            let output_tokens = usage_at(&answer, "/usage/completion_tokens");
            let usage_tokens = answer
                .pointer("/usage/total_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(input_tokens + output_tokens);
            if text.as_deref().unwrap_or("").trim().is_empty() && calls.is_empty() {
                return Err(CallError::Empty);
            }
            Ok(ToolAnswer {
                text,
                calls,
                usage_tokens,
                input_tokens,
                output_tokens,
            })
        }
    }

    /// The entity types the data needs name, in order, once each.
    /// What the schema and the kit's own checks cannot say about a `form` (AP-61, AP-62): it
    /// needs an application that may write, and its fields are attributes the data needs
    /// declare for that type, so a form never edits what the endpoint never granted.
    pub(super) fn form_errors(&self, spec: &kit::Spec) -> Vec<String> {
        let mut errors = Vec::new();
        for (index, view) in spec.views.iter().enumerate() {
            let kit::View::Form { source, fields, .. } = view else {
                continue;
            };
            let path = format!("views[{index}]");
            if !self.allows_write {
                errors.push(format!(
                    "{path}: a form writes through the endpoint and this application may not write (no write operation in its data needs); remove the form"
                ));
                continue;
            }
            let source = spec
                .sources
                .iter()
                .find(|s| Some(s.name.as_str()) == source.as_deref())
                .or(spec.sources.first());
            let Some(source) = source else {
                continue;
            };
            let declared = self.need_attrs(&source.entity_type);
            for (i, field) in fields.iter().flatten().enumerate() {
                if !declared.iter().any(|attr| attr == field) {
                    errors.push(format!(
                        "{path}.fields[{i}]: '{field}' is not an attribute the data needs declare for {}",
                        source.entity_type
                    ));
                }
            }
        }
        errors
    }

    /// The attributes the data needs declare for one type.
    pub(super) fn need_attrs(&self, entity_type: &str) -> Vec<String> {
        let mut attrs = Vec::new();
        for need in self.data_needs.as_array().into_iter().flatten() {
            let names = need
                .get("types")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            if !names.into_iter().any(|t| t == entity_type) {
                continue;
            }
            for attr in need
                .get("attrs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !attrs.iter().any(|known| known == attr) {
                    attrs.push(attr.to_owned());
                }
            }
        }
        attrs
    }

    /// The types the data needs name that the endpoint serves, in the order they were named.
    pub(super) fn types(&self) -> Vec<String> {
        let mut types: Vec<String> = Vec::new();
        for need in self.data_needs.as_array().into_iter().flatten() {
            for entity_type in need
                .get("types")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !types.iter().any(|known| known == entity_type) {
                    types.push(entity_type.to_owned());
                }
            }
        }
        served_only(types, self.schema_index.get())
    }

    /// The data needs as the model reads them: every type the endpoint does not serve left out,
    /// and a need left with no type dropped.
    pub(super) fn served_needs(&self) -> Value {
        needs_served(&self.data_needs, self.schema_index.get())
    }

    /// The endpoint's schema index, read through the proxy with the run's ticket (EP-46). A run
    /// over several endpoints gets one index: every endpoint's models, each marked with the
    /// index of its endpoint; an endpoint whose index cannot be read keeps the types its needs
    /// name, so a proxy that does not serve it yet narrows nothing away.
    pub(super) async fn schema_index(&self) -> Result<Value, String> {
        let mut index = self
            .read_entities(&format!("{}/schema/index.json", self.data_base(0)))
            .await?;
        if self.endpoints.len() < 2 {
            return Ok(index);
        }
        let by_endpoint = endpoints::types_by_endpoint(&self.endpoints, &self.data_needs);
        let mut models: Vec<Value> = Vec::new();
        for at in 0..self.endpoints.len() {
            let read = if at == 0 {
                Ok(index.clone())
            } else {
                self.read_entities(&format!("{}/schema/index.json", self.data_base(at)))
                    .await
            };
            match read {
                Ok(read) => models.extend(
                    read["models"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .cloned()
                        .map(|mut model| {
                            model["endpoint"] = json!(at);
                            model
                        }),
                ),
                Err(_) => models.push(json!({
                    "endpoint": at,
                    "unread": true,
                    "types": by_endpoint.get(at).cloned().unwrap_or_default(),
                })),
            }
        }
        index["models"] = Value::Array(models);
        Ok(index)
    }

    /// Where the data of the run's endpoint at `at` is read through the proxy.
    pub(super) fn data_base(&self, at: usize) -> String {
        endpoints::data_base(&self.proxy_base, &self.endpoints, at)
    }

    /// Where the entities of one type are read: through the endpoint of the need naming it.
    pub(super) fn data_base_of(&self, entity_type: &str) -> String {
        self.data_base(endpoints::of_type(
            &self.endpoints,
            &self.data_needs,
            entity_type,
        ))
    }

    /// Every source's rows, read through the proxy in pages up to the source's limit. A source
    /// that cannot be read is an empty list and a line in the chat: the dashboard still shows.
    pub(super) async fn rows(&self, spec: &kit::Spec) -> Value {
        let mut data = serde_json::Map::new();
        for source in &spec.sources {
            let limit = source
                .limit
                .unwrap_or(kit::DEFAULT_LIMIT)
                .min(kit::MAX_LIMIT);
            let mut rows: Vec<Value> = Vec::new();
            let mut failure = None;
            while (rows.len() as u32) < limit {
                let page = kit::PAGE.min(limit - rows.len() as u32);
                let mut url = format!(
                    "{}/ngsi-ld/v1/entities?type={}&options=keyValues&limit={page}&offset={}",
                    self.data_base_of(&source.entity_type),
                    urlencoding(&source.entity_type),
                    rows.len()
                );
                if !source.attrs.is_empty() {
                    url.push_str(&format!("&attrs={}", urlencoding(&source.attrs.join(","))));
                }
                if let Some(q) = &source.q {
                    url.push_str(&format!("&q={}", urlencoding(q)));
                }
                match self.read_entities(&url).await {
                    Ok(Value::Array(entities)) => {
                        let got = entities.len() as u32;
                        rows.extend(entities);
                        if got < page {
                            break;
                        }
                    }
                    Ok(_) => {
                        failure = Some("the endpoint did not answer a list".to_owned());
                        break;
                    }
                    Err(reason) => {
                        failure = Some(reason);
                        break;
                    }
                }
            }
            if let Some(reason) = failure {
                let _ = self
                    .thought(&format!(
                        "The rows of {} could not be read: {reason}",
                        source.name
                    ))
                    .await;
            }
            data.insert(source.name.clone(), Value::Array(rows));
        }
        Value::Object(data)
    }

    /// One GET through the proxy with the run's ticket, as JSON.
    pub(super) async fn read_entities(&self, url: &str) -> Result<Value, String> {
        let body = self.read_text(url).await?;
        serde_json::from_str::<Value>(&body).map_err(|err| err.to_string())
    }

    /// One GET through the proxy with the run's ticket, as text.
    pub(super) async fn read_text(&self, url: &str) -> Result<String, String> {
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.bearer)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "{status}: {}",
                body.chars().take(200).collect::<String>()
            ));
        }
        Ok(body)
    }

    /// A few entities per type, read through the proxy like the application will (AP-57). A
    /// type several endpoints serve is read through each and joined by id, the first endpoint's
    /// entities leading. A type that cannot be read is an empty list with the reason in the chat:
    /// the model still gets the data needs, and the chat says what was missing.
    pub(super) async fn samples(&self, types: &[String]) -> Result<Value, String> {
        let mut samples = serde_json::Map::new();
        let mut joined = String::new();
        for entity_type in types {
            let serving = endpoints::serving(&self.endpoints, &self.data_needs, entity_type);
            let names: Vec<&str> = serving
                .iter()
                .filter_map(|&at| self.endpoints.get(at))
                .map(|endpoint| endpoint.name.as_str())
                .collect();
            self.thought(&format!(
                "Reading {SAMPLES_PER_TYPE} entities of {entity_type} through {}.",
                if self.endpoints.len() < 2 || names.is_empty() {
                    "the endpoint".to_owned()
                } else {
                    names.join(" and ")
                }
            ))
            .await?;
            let mut rows: Vec<Value> = Vec::new();
            let mut carried: Vec<String> = Vec::new();
            for &at in &serving {
                let base = format!(
                    "{}/ngsi-ld/v1/entities?type={}&limit={SAMPLES_PER_TYPE}&options=keyValues",
                    self.data_base(at),
                    urlencoding(entity_type)
                );
                let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
                // A later endpoint is asked for the entities already read, so their parts meet.
                let mut read = if ids.is_empty() {
                    self.read_entities(&base).await
                } else {
                    self.read_entities(&format!("{base}&id={}", urlencoding(&ids.join(","))))
                        .await
                };
                if !ids.is_empty() && matches!(&read, Ok(Value::Array(found)) if found.is_empty()) {
                    read = self.read_entities(&base).await;
                }
                let name = self
                    .endpoints
                    .get(at)
                    .map_or("the endpoint", |endpoint| endpoint.name.as_str());
                match read {
                    Ok(Value::Array(entities)) => {
                        carried.push(format!(
                            "`{name}` carries {}",
                            endpoints::attributes_of(&entities).join(", ")
                        ));
                        endpoints::join_by_id(&mut rows, entities);
                    }
                    Ok(_) => {}
                    Err(reason) => {
                        self.thought(&format!(
                            "No sample of {entity_type} could be read through {name}: {reason}"
                        ))
                        .await?;
                    }
                }
            }
            if carried.len() > 1 {
                joined.push_str(&format!(
                    "- {entity_type}: {}. The samples are these rows joined by `id`; read the \
                     type from each endpoint with `{{ endpoint }}` and join the rows the same way.\n",
                    carried.join("; ")
                ));
            }
            samples.insert(entity_type.clone(), Value::Array(rows));
        }
        let _ = self.joined.set(joined);
        Ok(Value::Object(samples))
    }

    pub(super) async fn status(&self, status: AgentRunStatus) -> Result<(), String> {
        self.state
            .agents
            .set_status(&self.run_id, status, None)
            .await
            .map_err(|err| err.to_string())?;
        self.event(
            "status",
            json!({ "status": status.as_str(), "timestamp": now_rfc3339() }),
        )
        .await
    }

    /// The specification committed to the run's branch, so the application exists in the forge
    /// from its first pass and a closed tab loses nothing (AP-24). A Portal without a forge
    /// keeps the run in its store alone; a forge that refuses is said in the chat and the pass
    /// stands.
    pub(super) async fn commit(&self, message: &str) -> Result<(), String> {
        let Some(gitea) = self.state.gitea.clone() else {
            return Ok(());
        };
        if self.branch.is_empty() {
            return Ok(());
        }
        let Some(spec) = self
            .state
            .agents
            .get_run(&self.run_id)
            .await
            .ok()
            .flatten()
            .and_then(|run| {
                run.files
                    .get(kit::SPEC_FILE)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        else {
            return Ok(());
        };
        let path = format!("{}src/{}", self.path_prefix, kit::SPEC_FILE);
        let outcome: Result<String, GitError> = async {
            if gitea.branch_head(&self.branch).await.is_err() {
                let base = gitea.default_branch().await?;
                gitea.create_branch(&self.branch, &base).await?;
            }
            let sha = gitea
                .get_file(&path, &self.branch)
                .await?
                .map(|file| file.sha);
            gitea
                .put_file(&FileWrite {
                    path: &path,
                    branch: &self.branch,
                    message,
                    content: &spec,
                    sha: sha.as_deref(),
                    author: Author {
                        name: &self.created_by,
                        email: "agent@joinedcontext.local",
                    },
                })
                .await
        }
        .await;
        match outcome {
            Ok(sha) => {
                self.event(
                    "commit",
                    json!({ "sha": sha, "message": commit_subject(message) }),
                )
                .await
            }
            Err(err) => {
                self.thought(&format!("The commit did not land in the forge: {err}"))
                    .await
            }
        }
    }
}

/// A tool the model may call in an editing turn (SDK-20), in the provider's own body.
pub(super) struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

/// One call the model asked for: the id the provider echoes, the tool and its arguments.
#[derive(Debug, Clone)]
pub(super) struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// What a tool completion answered: prose, calls, and what it cost.
#[derive(Debug, Clone, Default)]
pub(super) struct ToolAnswer {
    pub text: Option<String>,
    pub calls: Vec<ToolCall>,
    pub usage_tokens: u64,
    /// The two halves of `usage_tokens`, 0 when the provider does not report them.
    pub input_tokens: u64,
    pub output_tokens: u64,
}

fn usage_at(answer: &Value, pointer: &str) -> u64 {
    answer.pointer(pointer).and_then(Value::as_u64).unwrap_or(0)
}

/// Anthropic takes alternating roles: two turns of one role in a row are one turn with the
/// content blocks joined (a string is one text block).
pub(super) fn merge_anthropic_messages(messages: &[Value]) -> Vec<Value> {
    let blocks = |content: &Value| -> Vec<Value> {
        match content {
            Value::String(text) => vec![json!({ "type": "text", "text": text })],
            Value::Array(parts) => parts.clone(),
            other => vec![json!({ "type": "text", "text": other.to_string() })],
        }
    };
    let mut merged: Vec<Value> = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let content = blocks(message.get("content").unwrap_or(&Value::Null));
        match merged.last_mut() {
            Some(last) if last.get("role").and_then(Value::as_str) == Some(role) => {
                if let Some(parts) = last.get_mut("content").and_then(Value::as_array_mut) {
                    parts.extend(content);
                }
            }
            _ => merged.push(json!({ "role": role, "content": content })),
        }
    }
    merged
}

/// The model's own turn, appended so the next call sees what it asked for.
pub(super) fn assistant_turn_message(provider: &str, answer: &ToolAnswer) -> Value {
    if provider == "anthropic" {
        let mut content = Vec::new();
        if let Some(text) = answer
            .text
            .as_deref()
            .filter(|text| !text.trim().is_empty())
        {
            content.push(json!({ "type": "text", "text": text }));
        }
        for call in &answer.calls {
            content.push(json!({
                "type": "tool_use",
                "id": call.id,
                "name": call.name,
                "input": call.input,
            }));
        }
        json!({ "role": "assistant", "content": content })
    } else {
        let calls: Vec<Value> = answer
            .calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.input.to_string() },
                })
            })
            .collect();
        let mut message = json!({ "role": "assistant", "content": answer.text });
        if !calls.is_empty() {
            message["tool_calls"] = Value::Array(calls);
        }
        message
    }
}

/// A tool's result, in the shape the provider reads it back.
pub(super) fn tool_result_message(provider: &str, call_id: &str, content: &str) -> Value {
    if provider == "anthropic" {
        json!({
            "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": call_id, "content": content }],
        })
    } else {
        json!({ "role": "tool", "tool_call_id": call_id, "content": content })
    }
}

#[cfg(test)]
mod tests {
    //! `rows` (T-2513; PF-55, AG-76): a kit's sources read page by page through the proxy. The
    //! endpoint is the gate for `q` and `attrs`; these cases prove what the Portal sends and what
    //! it keeps when an endpoint fails.

    use super::*;
    use crate::state::AppState;
    use std::collections::BTreeMap;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    /// An endpoint holding `total` entities of its type, answering each page by `limit` and
    /// `offset` like a broker does.
    struct Holding(usize);

    impl Respond for Holding {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let query: BTreeMap<String, String> = request.url.query_pairs().into_owned().collect();
            let number = |key: &str| {
                query
                    .get(key)
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(0)
            };
            let (limit, offset) = (number("limit"), number("offset"));
            let page: Vec<Value> = (offset..self.0.min(offset + limit))
                .map(|i| json!({ "id": format!("urn:ngsi-ld:T:{i}"), "type": "T" }))
                .collect();
            ResponseTemplate::new(200).set_body_json(page)
        }
    }

    async fn endpoint(server: &MockServer, entity_type: &str, answer: impl Respond + 'static) {
        Mock::given(method("GET"))
            .and(path("/v1/data/ngsi-ld/v1/entities"))
            .and(query_param("type", entity_type))
            .respond_with(answer)
            .mount(server)
            .await;
    }

    fn source(name: &str, entity_type: &str, limit: Option<u32>) -> kit::Source {
        kit::Source {
            name: name.to_owned(),
            entity_type: entity_type.to_owned(),
            attrs: Vec::new(),
            q: None,
            limit,
        }
    }

    fn spec(sources: Vec<kit::Source>) -> kit::Spec {
        kit::Spec {
            title: "t".to_owned(),
            subtitle: None,
            sources,
            filters: Vec::new(),
            views: Vec::new(),
            theme: None,
        }
    }

    fn driver(server: &MockServer) -> (Driver, AppState) {
        let state = AppState::new(crate::config::Config::for_tests(), None);
        let mut driver = Driver::for_tests(state.clone(), "helsinki");
        driver.proxy_base = server.uri();
        (driver, state)
    }

    /// The `(limit, offset)` of every page read for `entity_type`, in order.
    async fn pages(server: &MockServer, entity_type: &str) -> Vec<(String, String)> {
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .iter()
            .filter_map(|request| {
                let query: BTreeMap<String, String> =
                    request.url.query_pairs().into_owned().collect();
                (query.get("type").map(String::as_str) == Some(entity_type))
                    .then(|| (query["limit"].clone(), query["offset"].clone()))
            })
            .collect()
    }

    async fn thoughts(state: &AppState) -> Vec<String> {
        state
            .agents
            .events_since("test-run", 0)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|event| event.kind == "thought")
            .filter_map(|event| event.payload["text"].as_str().map(str::to_owned))
            .collect()
    }

    fn count(data: &Value, name: &str) -> usize {
        data[name].as_array().map_or(usize::MAX, Vec::len)
    }

    /// T-2513, AG-76: `q` and `attrs` travel percent-encoded, once each, beside the four
    /// parameters the Portal sets; nothing else is added to the endpoint's URL.
    #[tokio::test]
    async fn q_and_attrs_are_sent_percent_encoded_in_one_url_and_nothing_else_is_added() {
        let server = MockServer::start().await;
        endpoint(&server, "BikeHireDockingStation", Holding(3)).await;
        let (driver, _) = driver(&server);
        let q = r#"status=="closed";name~="a b&c=d""#;
        let mut stations = source("stations", "BikeHireDockingStation", Some(10));
        stations.attrs = vec!["name".to_owned(), "status".to_owned()];
        stations.q = Some(q.to_owned());

        let data = driver.rows(&spec(vec![stations])).await;
        assert_eq!(count(&data, "stations"), 3);
        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].url.query(),
            Some(
                "type=BikeHireDockingStation&options=keyValues&limit=10&offset=0\
                 &attrs=name%2Cstatus&q=status%3D%3D%22closed%22%3Bname~%3D%22a%20b%26c%3Dd%22"
            )
        );
        let pairs: Vec<(String, String)> = requests[0].url.query_pairs().into_owned().collect();
        assert_eq!(pairs.len(), 6, "{pairs:?}");
        assert!(pairs.contains(&("q".to_owned(), q.to_owned())), "{pairs:?}");
    }

    /// T-2513, PF-55: a source that cannot be read is an empty list and a line in the chat; the
    /// sources before and after it keep their rows, whichever order they come in.
    #[tokio::test]
    async fn one_sources_failure_does_not_empty_another_sources_rows() {
        for broken_first in [true, false] {
            let server = MockServer::start().await;
            endpoint(&server, "Good", Holding(4)).await;
            endpoint(
                &server,
                "Broken",
                ResponseTemplate::new(502).set_body_string("gateway"),
            )
            .await;
            let (driver, state) = driver(&server);
            let (good, broken) = (
                source("good", "Good", Some(10)),
                source("broken", "Broken", Some(10)),
            );
            let sources = if broken_first {
                vec![broken, good]
            } else {
                vec![good, broken]
            };

            let data = driver.rows(&spec(sources)).await;
            assert_eq!(count(&data, "good"), 4, "broken first: {broken_first}");
            assert_eq!(count(&data, "broken"), 0, "broken first: {broken_first}");
            let said = thoughts(&state).await;
            assert_eq!(said.len(), 1, "{said:?}");
            assert!(
                said[0].starts_with("The rows of broken could not be read: 502"),
                "{said:?}"
            );
        }
    }

    /// T-2513: pages of at most `PAGE`, up to the source's limit and never beyond `MAX_LIMIT`,
    /// stopping at the first short page. `(limit, entities held, pages read, rows kept)`.
    #[tokio::test]
    async fn a_limit_above_max_limit_is_clamped_before_the_first_request() {
        let server = MockServer::start().await;
        endpoint(&server, "Endless", Holding(100_000)).await;
        let (driver, _) = driver(&server);
        let data = driver
            .rows(&spec(vec![source("all", "Endless", Some(9_000))]))
            .await;
        assert_eq!(count(&data, "all"), kit::MAX_LIMIT as usize);
        let read = pages(&server, "Endless").await;
        assert_eq!(read.len(), (kit::MAX_LIMIT / kit::PAGE) as usize);
        assert!(
            read.iter()
                .all(|(limit, _)| *limit == kit::PAGE.to_string()),
            "{read:?}"
        );
        assert_eq!(read.last().map(|(_, offset)| offset.as_str()), Some("4500"));
    }

    #[tokio::test]
    async fn a_source_at_exactly_the_page_boundary_stops_after_one_page() {
        let server = MockServer::start().await;
        endpoint(&server, "Many", Holding(10_000)).await;
        let (driver, _) = driver(&server);
        let data = driver
            .rows(&spec(vec![source("many", "Many", Some(kit::PAGE))]))
            .await;
        assert_eq!(count(&data, "many"), kit::PAGE as usize);
        assert_eq!(
            pages(&server, "Many").await,
            vec![("500".to_owned(), "0".to_owned())]
        );
    }

    #[tokio::test]
    async fn a_source_whose_limit_is_not_a_multiple_of_page_pages_correctly() {
        let pairs = |list: &[(&str, &str)]| -> Vec<(String, String)> {
            list.iter()
                .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
                .collect()
        };
        for (limit, held, read, kept) in [
            (
                1_234,
                10_000,
                pairs(&[("500", "0"), ("500", "500"), ("234", "1000")]),
                1_234,
            ),
            // Fewer entities than the limit: the short page ends it.
            (1_234, 700, pairs(&[("500", "0"), ("500", "500")]), 700),
            // A full last page of what exists still asks once more and gets nothing.
            (1_234, 500, pairs(&[("500", "0"), ("500", "500")]), 500),
            (1, 10, pairs(&[("1", "0")]), 1),
        ] {
            let server = MockServer::start().await;
            endpoint(&server, "T", Holding(held)).await;
            let (driver, _) = driver(&server);
            let data = driver
                .rows(&spec(vec![source("s", "T", Some(limit))]))
                .await;
            assert_eq!(count(&data, "s"), kept, "limit {limit}, held {held}");
            assert_eq!(
                pages(&server, "T").await,
                read,
                "limit {limit}, held {held}"
            );
        }
        // No limit is the default, not everything.
        let server = MockServer::start().await;
        endpoint(&server, "T", Holding(100_000)).await;
        let (driver, _) = driver(&server);
        let data = driver.rows(&spec(vec![source("s", "T", None)])).await;
        assert_eq!(count(&data, "s"), kit::DEFAULT_LIMIT as usize);
    }

    /// T-2513: an answer that is JSON but not a list, or not JSON at all, is a failure said in
    /// the chat, never a panic and never rows.
    #[tokio::test]
    async fn a_non_array_answer_is_treated_as_a_failure_not_a_panic() {
        for (answer, reason) in [
            (
                ResponseTemplate::new(200).set_body_json(json!({ "id": "urn:x" })),
                "did not answer a list",
            ),
            (
                ResponseTemplate::new(200).set_body_string("<html>"),
                "expected value",
            ),
            (ResponseTemplate::new(200).set_body_string(""), "EOF"),
        ] {
            let server = MockServer::start().await;
            endpoint(&server, "Odd", answer).await;
            let (driver, state) = driver(&server);
            let data = driver
                .rows(&spec(vec![source("odd", "Odd", Some(10))]))
                .await;
            assert_eq!(data, json!({ "odd": [] }));
            let said = thoughts(&state).await;
            assert!(
                said.iter().any(|t| t.contains(reason)),
                "{reason}: {said:?}"
            );
        }
    }

    /// T-2513: no sources, no request and an empty object. A source name used twice is struck:
    /// `rows` is called only on a spec `kit::parse` accepted, and `kit::validate` refuses a
    /// repeated name (kit.rs, `"sources[{index}].name: '{}' is used twice"`).
    #[tokio::test]
    async fn an_empty_sources_list_returns_an_empty_object() {
        let server = MockServer::start().await;
        let (driver, _) = driver(&server);
        assert_eq!(driver.rows(&spec(Vec::new())).await, json!({}));
        assert!(server
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty());
    }

    /// T-2513, AG-76: a `q` in any script travels as UTF-8 percent-encoding and arrives as written.
    #[tokio::test]
    async fn unicode_in_q_is_encoded_and_round_trips() {
        let server = MockServer::start().await;
        endpoint(&server, "Station", Holding(1)).await;
        let (driver, _) = driver(&server);
        let q = r#"name=="Töölöntori ☂ 東京""#;
        let mut stations = source("s", "Station", Some(5));
        stations.q = Some(q.to_owned());
        driver.rows(&spec(vec![stations])).await;
        let requests = server.received_requests().await.unwrap_or_default();
        let raw = requests[0].url.query().unwrap_or_default();
        assert!(
            raw.contains("q=name%3D%3D%22T%C3%B6%C3%B6l%C3%B6ntori%20%E2%98%82%20"),
            "{raw}"
        );
        assert!(raw.is_ascii(), "{raw}");
        let sent: Vec<String> = requests[0]
            .url
            .query_pairs()
            .filter(|(key, _)| key == "q")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(sent, vec![q.to_owned()]);
    }

    /// T-2513, PF-55: an endpoint refusing the run's ticket leaves that source empty, with the
    /// status in the chat line, and reads no further page.
    #[tokio::test]
    async fn an_endpoint_answering_401_leaves_that_source_empty_with_its_reason() {
        let server = MockServer::start().await;
        endpoint(
            &server,
            "Private",
            ResponseTemplate::new(401).set_body_json(json!({ "title": "invalid ticket" })),
        )
        .await;
        let (driver, state) = driver(&server);
        let data = driver
            .rows(&spec(vec![source("private", "Private", Some(2_000))]))
            .await;
        assert_eq!(data, json!({ "private": [] }));
        assert_eq!(pages(&server, "Private").await.len(), 1);
        let said = thoughts(&state).await;
        assert!(
            said.iter()
                .any(|t| t.starts_with("The rows of private could not be read: 401")),
            "{said:?}"
        );
    }
}
