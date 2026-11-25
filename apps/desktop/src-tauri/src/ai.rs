use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// Model providers. Local providers run on this machine; cloud providers need an API key in the
/// environment *and* the user's explicit opt-in (setting `ai.allowCloud`). Keys are only ever sent
/// to their provider's fixed endpoint, never stored, logged or passed to games.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Local,
    Cloud,
}

pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    pub base: &'static str,
    pub env_keys: &'static [&'static str],
    pub suggested: &'static [&'static str],
    pub docs: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset { id: "ollama", label: "Ollama (local)", kind: Kind::Local, base: "http://127.0.0.1:11434", env_keys: &[], suggested: &[], docs: "https://docs.ollama.com/api" },
    Preset { id: "lmstudio", label: "LM Studio (local)", kind: Kind::Local, base: "http://127.0.0.1:1234", env_keys: &[], suggested: &[], docs: "https://lmstudio.ai/docs/developer/openai-compat" },
    Preset { id: "anthropic", label: "Anthropic Claude", kind: Kind::Cloud, base: "https://api.anthropic.com", env_keys: &["ANTHROPIC_API_KEY"], suggested: &["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"], docs: "https://platform.claude.com/docs" },
    Preset { id: "openai", label: "OpenAI", kind: Kind::Cloud, base: "https://api.openai.com", env_keys: &["OPENAI_API_KEY"], suggested: &["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano"], docs: "https://platform.openai.com/docs" },
    Preset { id: "gemini", label: "Google Gemini", kind: Kind::Cloud, base: "https://generativelanguage.googleapis.com", env_keys: &["GEMINI_API_KEY", "GOOGLE_API_KEY"], suggested: &["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-pro-latest"], docs: "https://ai.google.dev/gemini-api/docs" },
];

pub const ANTHROPIC_VERSION: &str = "2026-10-21";
pub const ANTHROPIC_FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Models that accept Anthropic's server-side refusal fallback (`fallbacks: "default"`).
const ANTHROPIC_FALLBACK_MODELS: &[&str] = &["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];
pub(crate) const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub fn preset(id: &str) -> AppResult<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id).ok_or_else(|| AppError::Invalid(format!("Unknown provider '{id}'")))
}

/// The first usable key for a provider, read from the environment. Placeholders are rejected.
pub fn env_key(p: &Preset) -> Option<(&'static str, String)> {
    for name in p.env_keys {
        if let Ok(v) = std::env::var(name) {
            let v = v.trim().to_string();
            let placeholder = v.is_empty() || v.len() < 16 || v.len() > 512 || v.contains(char::is_whitespace) || v.to_ascii_lowercase().contains("your");
            if !placeholder {
                return Some((name, v));
            }
        }
    }
    None
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub provider: String,
    pub model: String,
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub schema: Value,
    pub schema_name: String,
    pub max_tokens: Option<u32>,
    pub effort: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub text: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub served_by: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResult {
    pub provider: String,
    pub model: String,
    pub text: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub served_by: Option<String>,
    pub notes: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub endpoint: String,
    pub available: bool,
    pub credential: Option<String>,
    pub models: Vec<String>,
    pub suggested_models: Vec<String>,
    pub allowed: bool,
    pub note: Option<String>,
    pub docs: String,
}

pub(crate) fn validate(req: &GenerateRequest) -> AppResult<()> {
    if req.model.trim().is_empty() || req.model.len() > 200 || req.model.contains(char::is_whitespace) {
        return Err(AppError::Invalid("Choose a model".into()));
    }
    if req.messages.is_empty() || req.messages.len() > 40 {
        return Err(AppError::Invalid("A request needs between 1 and 40 messages".into()));
    }
    for m in &req.messages {
        if m.role != "user" && m.role != "assistant" {
            return Err(AppError::Invalid("Messages must be from the user or the assistant".into()));
        }
    }
    let size = req.system.len() + req.messages.iter().map(|m| m.content.len()).sum::<usize>();
    if size > 400_000 {
        return Err(AppError::Invalid("The request is too large; narrow the context".into()));
    }
    if !req.schema.is_object() {
        return Err(AppError::Invalid("A JSON schema object is required".into()));
    }
    Ok(())
}

// ---- Request builders (pure, unit-tested) -----------------------------------------------

pub fn ollama_body(req: &GenerateRequest, think: Option<Value>) -> Value {
    let mut messages = vec![json!({"role": "system", "content": req.system})];
    messages.extend(req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
    let mut body = json!({"model": req.model, "messages": messages, "stream": false, "format": req.schema, "options": {"temperature": 0.2}});
    if let Some(t) = think {
        body["think"] = t;
    }
    body
}

pub fn anthropic_body(req: &GenerateRequest) -> (Value, Vec<(&'static str, String)>) {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(16_000),
        "system": req.system,
        "messages": req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
        "output_config": {"format": {"type": "json_schema", "schema": req.schema}},
    });
    if let Some(effort) = &req.effort {
        body["output_config"]["effort"] = json!(effort);
    }
    let mut headers = vec![("anthropic-version", ANTHROPIC_VERSION.to_string())];
    if ANTHROPIC_FALLBACK_MODELS.contains(&req.model.as_str()) {
        body["fallbacks"] = json!("default");
        headers.push(("anthropic-beta", ANTHROPIC_FALLBACK_BETA.to_string()));
    }
    (body, headers)
}

pub fn openai_body(req: &GenerateRequest, local: bool) -> Value {
    let mut messages = vec![json!({"role": "system", "content": req.system})];
    messages.extend(req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "response_format": {"type": "json_schema", "json_schema": {"name": req.schema_name, "schema": req.schema, "strict": false}},
    });
    if local {
        body["max_tokens"] = json!(req.max_tokens.unwrap_or(8_000));
    } else {
        body["max_completion_tokens"] = json!(req.max_tokens.unwrap_or(16_000));
    }
    body
}

pub fn gemini_body(req: &GenerateRequest) -> Value {
    let contents: Vec<Value> = req.messages.iter().map(|m| json!({"role": if m.role == "assistant" { "model" } else { "user" }, "parts": [{"text": m.content}]})).collect();
    json!({
        "systemInstruction": {"parts": [{"text": req.system}]},
        "contents": contents,
        "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": req.schema, "maxOutputTokens": req.max_tokens.unwrap_or(16_000)},
    })
}

// ---- Response parsers (pure, unit-tested) -----------------------------------------------

fn u(v: &Value) -> Option<u64> {
    v.as_u64()
}

pub fn parse_ollama(v: &Value) -> AppResult<Parsed> {
    let text = v.pointer("/message/content").and_then(|c| c.as_str()).unwrap_or("").to_string();
    if text.trim().is_empty() {
        return Err(AppError::Unavailable("The local model returned an empty answer".into()));
    }
    let mut notes = vec![];
    if v.get("done_reason").and_then(|d| d.as_str()) == Some("length") {
        notes.push("The answer reached the length limit and may be incomplete.".into());
    }
    Ok(Parsed { text, input_tokens: u(&v["prompt_eval_count"]), output_tokens: u(&v["eval_count"]), served_by: v["model"].as_str().map(String::from), notes })
}

pub fn parse_anthropic(v: &Value) -> AppResult<Parsed> {
    match v["stop_reason"].as_str() {
        Some("refusal") => {
            let category = v.pointer("/stop_details/category").and_then(|c| c.as_str()).unwrap_or("unspecified");
            return Err(AppError::Denied(format!("Claude declined this request (category: {category}). Nothing was changed.")));
        }
        Some("max_tokens") => return Err(AppError::Unavailable("The answer was cut off at the token limit; try a narrower request".into())),
        _ => {}
    }
    let mut text = String::new();
    let mut notes = vec![];
    for block in v["content"].as_array().cloned().unwrap_or_default() {
        match block["type"].as_str() {
            Some("text") => text.push_str(block["text"].as_str().unwrap_or("")),
            Some("fallback") => notes.push(format!(
                "{} declined; {} answered instead.",
                block.pointer("/from/model").and_then(|m| m.as_str()).unwrap_or("The first model"),
                block.pointer("/to/model").and_then(|m| m.as_str()).unwrap_or("a fallback model")
            )),
            _ => {}
        }
    }
    if text.trim().is_empty() {
        return Err(AppError::Unavailable("Claude returned no text output".into()));
    }
    Ok(Parsed { text, input_tokens: u(&v["usage"]["input_tokens"]), output_tokens: u(&v["usage"]["output_tokens"]), served_by: v["model"].as_str().map(String::from), notes })
}

pub fn parse_openai(v: &Value) -> AppResult<Parsed> {
    let choice = &v["choices"][0];
    if let Some(refusal) = choice.pointer("/message/refusal").and_then(|r| r.as_str()) {
        return Err(AppError::Denied(format!("The model declined: {}", refusal.chars().take(200).collect::<String>())));
    }
    if choice["finish_reason"].as_str() == Some("length") {
        return Err(AppError::Unavailable("The answer was cut off at the token limit".into()));
    }
    let text = choice.pointer("/message/content").and_then(|c| c.as_str()).unwrap_or("").to_string();
    if text.trim().is_empty() {
        return Err(AppError::Unavailable("The model returned no content".into()));
    }
    Ok(Parsed { text, input_tokens: u(&v["usage"]["prompt_tokens"]), output_tokens: u(&v["usage"]["completion_tokens"]), served_by: v["model"].as_str().map(String::from), notes: vec![] })
}

pub fn parse_gemini(v: &Value) -> AppResult<Parsed> {
    let candidate = &v["candidates"][0];
    match candidate["finishReason"].as_str() {
        Some("SAFETY") | Some("PROHIBITED_CONTENT") | Some("BLOCKLIST") => return Err(AppError::Denied("Gemini declined this request".into())),
        Some("MAX_TOKENS") => return Err(AppError::Unavailable("The answer was cut off at the token limit".into())),
        _ => {}
    }
    let text: String = candidate.pointer("/content/parts").and_then(|p| p.as_array()).map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect()).unwrap_or_default();
    if text.trim().is_empty() {
        return Err(AppError::Unavailable("Gemini returned no content".into()));
    }
    Ok(Parsed { text, input_tokens: u(&v["usageMetadata"]["promptTokenCount"]), output_tokens: u(&v["usageMetadata"]["candidatesTokenCount"]), served_by: v["modelVersion"].as_str().map(String::from), notes: vec![] })
}

/// Error text safe to show: provider error type and a short message, never the request.
pub fn describe_http_error(provider: &str, status: u16, body: &Value) -> String {
    let kind = body.pointer("/error/type").or_else(|| body.pointer("/error/status")).and_then(|t| t.as_str()).unwrap_or("error");
    let message: String = body.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("").chars().take(240).collect();
    format!("{provider} returned HTTP {status} ({kind}){}", if message.is_empty() { String::new() } else { format!(": {message}") })
}

/// What went wrong, in words a user can act on, followed by the provider's own short message.
pub fn http_problem(p: &Preset, model: &str, status: u16, body: &Value) -> String {
    let detail = describe_http_error(p.label, status, body);
    match status {
        401 | 403 => format!("{} rejected the API key. Check the key, then press Refresh. ({detail})", p.label),
        404 => format!("{} does not offer {model} to this key. Choose another model. ({detail})", p.label),
        429 => format!("{model} is over its quota or rate limit for this key. Wait a little or choose another model. ({detail})"),
        500 | 502 | 503 | 529 => format!("{model} is overloaded at {} right now. Try again shortly or choose another model. ({detail})", p.label),
        _ => detail,
    }
}

/// Text-chat models from Gemini's model list: generateContent support, without image, speech,
/// embedding or agent-only models.
pub fn gemini_chat_models(v: &Value) -> Vec<String> {
    const SKIP: &[&str] = &["embedding", "aqa", "imagen", "veo", "tts", "image", "transcribe", "nano-banana", "lyria", "robotics", "computer-use", "live", "audio", "deep-research", "antigravity", "customtools"];
    let mut out: Vec<String> = v["models"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|m| m["supportedGenerationMethods"].as_array().map(|g| g.iter().any(|x| x == "generateContent")).unwrap_or(false))
        .filter_map(|m| m["name"].as_str().map(|n| n.trim_start_matches("models/").to_string()))
        .filter(|n| (n.starts_with("gemini-") || n.starts_with("gemma-")) && !SKIP.iter().any(|s| n.contains(s)))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Chat models from OpenAI's model list, without dated snapshots or audio, image, search and
/// embedding models.
pub fn openai_chat_models(v: &Value) -> Vec<String> {
    const SKIP: &[&str] = &["audio", "realtime", "tts", "transcribe", "image", "embedding", "moderation", "whisper", "dall-e", "davinci", "babbage", "search", "instruct", "codex", "computer-use", "deep-research"];
    let dated = |id: &str| {
        let b = id.as_bytes();
        b.len() > 11 && b[b.len() - 11] == b'-' && b[b.len() - 10..].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
    };
    let mut out: Vec<String> = v["data"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .filter(|id| (id.starts_with("gpt-") || id.starts_with("o3") || id.starts_with("o4")) && !SKIP.iter().any(|s| id.contains(s)) && !dated(id))
        .map(String::from)
        .collect();
    out.sort();
    out.dedup();
    out
}

const MODEL_LIST_TTL: Duration = Duration::from_secs(600);

fn model_lists() -> &'static std::sync::Mutex<std::collections::HashMap<&'static str, (Instant, Vec<String>)>> {
    static LISTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<&'static str, (Instant, Vec<String>)>>> = std::sync::OnceLock::new();
    LISTS.get_or_init(Default::default)
}

/// The chat models a cloud key can use, from the provider's own list. Listing is free and sends no
/// project data; results are kept for ten minutes.
async fn cloud_models(client: &reqwest::Client, p: &Preset, key: &str) -> AppResult<Vec<String>> {
    if let Some((at, models)) = model_lists().lock().map_err(|_| AppError::Internal("model list lock".into()))?.get(p.id) {
        if at.elapsed() < MODEL_LIST_TTL {
            return Ok(models.clone());
        }
    }
    let t = Duration::from_secs(8);
    let fail = |e: reqwest::Error| AppError::Unavailable(if e.is_timeout() { "the model list did not arrive in time".into() } else { "could not reach the provider".into() });
    let request = match p.id {
        "openai" => client.get(format!("{}/v1/models", p.base)).bearer_auth(key),
        "gemini" => client.get(format!("{}/v1beta/models?pageSize=1000", p.base)).header("x-goog-api-key", key),
        _ => return Ok(vec![]),
    };
    let (status, body) = read_json(request.timeout(t).send().await.map_err(fail)?).await?;
    if !(200..300).contains(&status) {
        return Err(AppError::Unavailable(http_problem(p, "", status, &body)));
    }
    let models = if p.id == "gemini" { gemini_chat_models(&body) } else { openai_chat_models(&body) };
    model_lists().lock().map_err(|_| AppError::Internal("model list lock".into()))?.insert(p.id, (Instant::now(), models.clone()));
    Ok(models)
}

// ---- Network ------------------------------------------------------------------------------

/// No redirects: a provider endpoint never needs one, and following them could leak a key.
pub fn ai_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .user_agent("UniversalAIGameStudio/0.1")
        .build()
        .expect("ai client")
}

pub(crate) async fn read_json(resp: reqwest::Response) -> AppResult<(u16, Value)> {
    let status = resp.status().as_u16();
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| AppError::Unavailable(format!("Connection interrupted: {e}")))? {
        buf.extend_from_slice(&chunk);
        if buf.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::Invalid("The provider response was unexpectedly large".into()));
        }
    }
    let value = serde_json::from_slice(&buf).unwrap_or(Value::Null);
    Ok((status, value))
}

fn local_models_from_tags(v: &Value) -> (Vec<String>, Vec<String>) {
    let mut models = vec![];
    let mut skipped = vec![];
    for m in v["models"].as_array().cloned().unwrap_or_default() {
        let name = m["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let remote = m.get("remote_host").is_some() || m.get("remote_model").is_some() || name.ends_with(":cloud") || name.contains("-cloud");
        if remote {
            skipped.push(name);
        } else if !name.starts_with("llamacpp:") && !name.contains("embed") {
            models.push(name);
        }
    }
    models.sort();
    models.dedup();
    (models, skipped)
}

pub async fn statuses(client: &reqwest::Client, allow_cloud: bool) -> Vec<ProviderStatus> {
    let mut out = vec![];
    for p in PRESETS {
        let mut status = ProviderStatus {
            id: p.id.into(),
            label: p.label.into(),
            kind: if p.kind == Kind::Local { "local" } else { "cloud" }.into(),
            endpoint: p.base.into(),
            available: false,
            credential: None,
            models: vec![],
            suggested_models: p.suggested.iter().map(|s| s.to_string()).collect(),
            allowed: p.kind == Kind::Local || allow_cloud,
            note: None,
            docs: p.docs.into(),
        };
        match p.id {
            "ollama" => match client.get(format!("{}/api/tags", p.base)).timeout(Duration::from_secs(3)).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok((_, v)) = read_json(resp).await {
                        let (models, skipped) = local_models_from_tags(&v);
                        status.available = !models.is_empty();
                        status.note = Some(if models.is_empty() { "Ollama is running but has no local chat models installed.".to_string() } else if skipped.is_empty() { "Runs on this Mac. Nothing leaves your computer.".to_string() } else { format!("Runs on this Mac. Cloud-routed models are hidden: {}", skipped.join(", ")) });
                        status.models = models;
                    }
                }
                _ => status.note = Some("Ollama is not running. Start the Ollama app to use local models.".into()),
            },
            "lmstudio" => match client.get(format!("{}/v1/models", p.base)).timeout(Duration::from_secs(2)).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok((_, v)) = read_json(resp).await {
                        status.models = v["data"].as_array().cloned().unwrap_or_default().iter().filter_map(|m| m["id"].as_str().map(String::from)).collect();
                        status.available = !status.models.is_empty();
                    }
                }
                _ => status.note = Some("LM Studio's local server is not running.".into()),
            },
            _ => {
                let key = env_key(p);
                status.credential = key.as_ref().map(|(name, _)| name.to_string());
                status.available = key.is_some();
                status.note = Some(match (key.is_some(), allow_cloud) {
                    (false, _) => format!("Set {} in your environment to use this provider.", p.env_keys.join(" or ")),
                    (true, false) => "Key found. Cloud providers are off until you allow them in Settings.".into(),
                    (true, true) => "Allowed. Requests send project context to this provider and are billed to your account.".into(),
                });
                if let (Some((_, k)), true) = (&key, allow_cloud) {
                    match cloud_models(client, p, k).await {
                        Ok(models) => status.models = models,
                        Err(e) => status.note = Some(format!("{} Could not list its models: {e}", status.note.take().unwrap_or_default())),
                    }
                }
            }
        }
        out.push(status);
    }
    out
}

pub(crate) async fn ollama_think(client: &reqwest::Client, model: &str) -> Option<Value> {
    let resp = client.post("http://127.0.0.1:11434/api/show").json(&json!({"model": model})).timeout(Duration::from_secs(5)).send().await.ok()?;
    let (_, v) = read_json(resp).await.ok()?;
    let thinking = v["capabilities"].as_array().map(|c| c.iter().any(|x| x == "thinking")).unwrap_or(false);
    if !thinking {
        None
    } else if model.starts_with("gpt-oss") {
        Some(json!("low"))
    } else {
        Some(json!(false))
    }
}

/// Sends one request to the provider and returns its HTTP status and JSON body.
async fn send_request(client: &reqwest::Client, p: &Preset, req: &GenerateRequest) -> AppResult<(u16, Value)> {
    // Cloud calls give up sooner: a busy model can hold a request open for minutes.
    let timeout = Duration::from_secs(if p.kind == Kind::Cloud { 180 } else { 300 });
    let send_err = |e: reqwest::Error| AppError::Unavailable(if e.is_timeout() { format!("{} did not answer in time", p.label) } else if e.is_connect() { format!("Could not connect to {}", p.label) } else { format!("{} request failed", p.label) });
    let (status, body) = match p.id {
        "ollama" => {
            let think = ollama_think(client, &req.model).await;
            let resp = client.post(format!("{}/api/chat", p.base)).json(&ollama_body(req, think)).timeout(timeout).send().await.map_err(send_err)?;
            read_json(resp).await?
        }
        "lmstudio" => {
            let resp = client.post(format!("{}/v1/chat/completions", p.base)).json(&openai_body(req, true)).timeout(timeout).send().await.map_err(send_err)?;
            read_json(resp).await?
        }
        "anthropic" => {
            let (_, key) = env_key(p).ok_or_else(|| AppError::Unavailable("ANTHROPIC_API_KEY is not set".into()))?;
            let (body, headers) = anthropic_body(req);
            let mut builder = client.post(format!("{}/v1/messages", p.base)).header("x-api-key", key).header("content-type", "application/json");
            for (k, v) in headers {
                builder = builder.header(k, v);
            }
            read_json(builder.json(&body).timeout(timeout).send().await.map_err(send_err)?).await?
        }
        "openai" => {
            let (_, key) = env_key(p).ok_or_else(|| AppError::Unavailable("OPENAI_API_KEY is not set".into()))?;
            read_json(client.post(format!("{}/v1/chat/completions", p.base)).bearer_auth(key).json(&openai_body(req, false)).timeout(timeout).send().await.map_err(send_err)?).await?
        }
        "gemini" => {
            let (_, key) = env_key(p).ok_or_else(|| AppError::Unavailable("GEMINI_API_KEY is not set".into()))?;
            if !req.model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')) {
                return Err(AppError::Invalid("Invalid Gemini model name".into()));
            }
            read_json(client.post(format!("{}/v1beta/models/{}:generateContent", p.base, req.model)).header("x-goog-api-key", key).json(&gemini_body(req)).timeout(timeout).send().await.map_err(send_err)?).await?
        }
        _ => return Err(AppError::Invalid("Unsupported provider".into())),
    };
    Ok((status, body))
}

pub(crate) fn cloud_denied(p: &Preset) -> AppError {
    AppError::Denied(format!("{} is a cloud provider. Allow cloud providers in Settings first: requests send project context to the provider and are billed to your account.", p.label))
}

pub async fn generate(client: &reqwest::Client, req: &GenerateRequest, allow_cloud: bool) -> AppResult<GenerateResult> {
    validate(req)?;
    let p = preset(&req.provider)?;
    if p.kind == Kind::Cloud && !allow_cloud {
        return Err(cloud_denied(p));
    }
    let started = Instant::now();
    // A busy cloud model (HTTP 500, 502, 503 or Anthropic's 529) often answers a few seconds later.
    let mut retries = 0;
    let (status, body) = loop {
        let (status, body) = send_request(client, p, req).await?;
        if p.kind == Kind::Cloud && matches!(status, 500 | 502 | 503 | 529) && retries < 2 {
            retries += 1;
            tokio::time::sleep(Duration::from_secs(if retries == 1 { 2 } else { 6 })).await;
            continue;
        }
        break (status, body);
    };
    if !(200..300).contains(&status) {
        return Err(AppError::Unavailable(http_problem(p, &req.model, status, &body)));
    }
    let parsed = match p.id {
        "ollama" => parse_ollama(&body)?,
        "anthropic" => parse_anthropic(&body)?,
        "gemini" => parse_gemini(&body)?,
        _ => parse_openai(&body)?,
    };
    Ok(GenerateResult {
        provider: p.id.into(),
        model: req.model.clone(),
        text: parsed.text,
        input_tokens: parsed.input_tokens,
        output_tokens: parsed.output_tokens,
        served_by: parsed.served_by,
        notes: parsed.notes,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_from_the_frontend_keep_their_property_order() {
        // Constrained decoding follows the schema's property order; the studio lists "summary" before
        // "operations" and "op" before "id" on purpose. Sorting the keys changes what local models write.
        let raw = r#"{"provider":"ollama","model":"qwen3:8b","system":"s","messages":[{"role":"user","content":"x"}],
            "schema":{"type":"object","properties":{"summary":{"type":"string"},"operations":{"type":"array","items":{"type":"object","properties":{"op":{"const":"world.add"},"objectType":{"type":"string"},"id":{"type":"string"}}}}}},
            "schemaName":"proposal"}"#;
        let request: GenerateRequest = serde_json::from_str(raw).unwrap();
        let body = serde_json::to_string(&ollama_body(&request, None)).unwrap();
        let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("missing {needle}"));
        assert!(at("\"summary\"") < at("\"operations\""), "{body}");
        assert!(at("\"op\"") < at("\"objectType\"") && at("\"objectType\"") < at("\"id\""), "{body}");
    }

    fn req(provider: &str, model: &str) -> GenerateRequest {
        GenerateRequest {
            provider: provider.into(),
            model: model.into(),
            system: "You edit game projects.".into(),
            messages: vec![ChatMessage { role: "user".into(), content: "Add a tree".into() }],
            schema: json!({"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"], "additionalProperties": false}),
            schema_name: "proposal".into(),
            max_tokens: None,
            effort: Some("low".into()),
        }
    }

    #[test]
    fn anthropic_request_uses_structured_outputs_current_version_and_fallbacks() {
        let (body, headers) = anthropic_body(&req("anthropic", "claude-opus-5-5"));
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert_eq!(body["output_config"]["effort"], "low");
        assert_eq!(body["fallbacks"], "default");
        assert!(body.get("temperature").is_none(), "sampling parameters are rejected on 2026-10-21");
        assert!(body.get("tool_choice").is_none(), "forced tool use is rejected on current models");
        assert!(headers.contains(&("anthropic-version", "2026-10-21".to_string())));
        assert!(headers.contains(&("anthropic-beta", "server-side-fallback-2026-07-01".to_string())));
        let (haiku, haiku_headers) = anthropic_body(&req("anthropic", "claude-haiku-5-5"));
        assert!(haiku.get("fallbacks").is_none());
        assert_eq!(haiku_headers.len(), 1);
    }

    #[test]
    fn parses_anthropic_answers_refusals_truncation_and_fallbacks() {
        let ok = json!({"model": "claude-opus-5-5", "stop_reason": "end_turn", "content": [{"type": "thinking", "thinking": ""}, {"type": "text", "text": "{\"summary\":\"x\"}"}], "usage": {"input_tokens": 120, "output_tokens": 30}});
        assert_eq!(parse_anthropic(&ok).unwrap(), Parsed { text: "{\"summary\":\"x\"}".into(), input_tokens: Some(120), output_tokens: Some(30), served_by: Some("claude-opus-5-5".into()), notes: vec![] });
        let refusal = json!({"stop_reason": "refusal", "stop_details": {"type": "refusal", "category": "cyber"}, "content": []});
        assert!(matches!(parse_anthropic(&refusal), Err(AppError::Denied(m)) if m.contains("cyber")));
        assert!(matches!(parse_anthropic(&json!({"stop_reason": "max_tokens", "content": []})), Err(AppError::Unavailable(_))));
        let fell_back = json!({"model": "claude-opus-4-8", "stop_reason": "end_turn", "content": [{"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}}, {"type": "text", "text": "{}"}], "usage": {}});
        assert_eq!(parse_anthropic(&fell_back).unwrap().notes, vec!["claude-opus-5-5 declined; claude-opus-4-8 answered instead.".to_string()]);
    }

    #[test]
    fn builds_and_parses_the_other_providers() {
        let body = ollama_body(&req("ollama", "qwen3:8b"), Some(json!(false)));
        assert_eq!(body["format"]["type"], "object");
        assert_eq!(body["think"], false);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(parse_ollama(&json!({"model": "qwen3:8b", "message": {"content": "{}"}, "prompt_eval_count": 5, "eval_count": 7})).unwrap().output_tokens, Some(7));
        assert!(parse_ollama(&json!({"message": {"content": "  "}})).is_err());

        let oa = openai_body(&req("openai", "gpt-x"), false);
        assert_eq!(oa["response_format"]["json_schema"]["name"], "proposal");
        assert!(oa.get("max_completion_tokens").is_some());
        assert!(matches!(parse_openai(&json!({"choices": [{"message": {"refusal": "no"}}]})), Err(AppError::Denied(_))));
        assert_eq!(parse_openai(&json!({"choices": [{"finish_reason": "stop", "message": {"content": "{}"}}], "usage": {"prompt_tokens": 3, "completion_tokens": 4}})).unwrap().input_tokens, Some(3));

        let g = gemini_body(&req("gemini", "gemini-x"));
        assert_eq!(g["generationConfig"]["responseMimeType"], "application/json");
        assert_eq!(parse_gemini(&json!({"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "{"}, {"text": "}"}]}}]})).unwrap().text, "{}");
        assert!(matches!(parse_gemini(&json!({"candidates": [{"finishReason": "SAFETY"}]})), Err(AppError::Denied(_))));
    }

    #[test]
    fn hides_cloud_routed_ollama_models() {
        let (models, skipped) = local_models_from_tags(&json!({"models": [{"name": "qwen3:8b"}, {"name": "gpt-oss:20b"}, {"name": "gpt-oss:120b-cloud"}, {"name": "big", "remote_host": "https://ollama.com"}, {"name": "nomic-embed-text:latest"}, {"name": "llamacpp:abc"}]}));
        assert_eq!(models, vec!["gpt-oss:20b", "qwen3:8b"]);
        assert_eq!(skipped, vec!["gpt-oss:120b-cloud", "big"]);
    }

    #[test]
    fn describes_provider_errors_without_echoing_requests() {
        let msg = describe_http_error("Anthropic Claude", 400, &json!({"type": "error", "error": {"type": "invalid_request_error", "message": "model: claude-x not found"}}));
        assert_eq!(msg, "Anthropic Claude returned HTTP 400 (invalid_request_error): model: claude-x not found");
    }

    #[tokio::test]
    async fn refuses_cloud_calls_without_opt_in_and_bad_requests() {
        let client = ai_client();
        let err = generate(&client, &req("anthropic", "claude-opus-5-5"), false).await.unwrap_err();
        assert!(matches!(err, AppError::Denied(_)));
        let mut bad = req("ollama", "qwen3:8b");
        bad.messages[0].role = "system".into();
        assert!(matches!(generate(&client, &bad, true).await.unwrap_err(), AppError::Invalid(_)));
        assert!(matches!(generate(&client, &req("nope", "m"), true).await.unwrap_err(), AppError::Invalid(_)));
    }

    /// Live check against the local Ollama service (no cost). Run with: cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_local_ollama_structured_output() {
        let client = ai_client();
        let mut r = req("ollama", "qwen3:8b");
        r.messages[0].content = "Reply with a one-sentence summary saying hello.".into();
        let out = generate(&client, &r, false).await.expect("ollama answered");
        let v: Value = serde_json::from_str(&out.text).expect("valid JSON");
        assert!(v["summary"].is_string(), "{}", out.text);
    }

    #[test]
    fn lists_only_text_chat_models() {
        let g = json!({"models": [
            {"name": "models/gemini-flash-lite-latest", "supportedGenerationMethods": ["generateContent", "countTokens"]},
            {"name": "models/gemini-3.5-flash", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-embedding-001", "supportedGenerationMethods": ["embedContent"]},
            {"name": "models/gemini-3.5-transcribe", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/nano-banana-pro-preview", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/lyria-3.5", "supportedGenerationMethods": ["generateContent"]}
        ]});
        assert_eq!(gemini_chat_models(&g), vec!["gemini-3.5-flash", "gemini-flash-lite-latest"]);
        let o = json!({"data": [{"id": "gpt-5.5"}, {"id": "gpt-5.5-2026-04-23"}, {"id": "gpt-5.4-mini"}, {"id": "gpt-4o-mini-tts"}, {"id": "gpt-5.3-codex"}, {"id": "text-embedding-3-large"}, {"id": "chatgpt-image-latest"}, {"id": "o3"}]});
        assert_eq!(openai_chat_models(&o), vec!["gpt-5.4-mini", "gpt-5.5", "o3"]);
    }

    #[test]
    fn explains_http_failures_in_plain_words() {
        let p = preset("gemini").unwrap();
        let busy = json!({"error": {"code": 503, "status": "UNAVAILABLE", "message": "This model is currently experiencing high demand."}});
        let text = http_problem(p, "gemini-flash-latest", 503, &busy);
        assert!(text.starts_with("gemini-flash-latest is overloaded at Google Gemini right now"), "{text}");
        assert!(text.contains("high demand"), "the provider's own words are kept: {text}");
        let quota = json!({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "You exceeded your current quota"}});
        assert!(http_problem(p, "gemini-pro-latest", 429, &quota).contains("over its quota"));
        assert!(http_problem(p, "x", 401, &json!({})).contains("rejected the API key"));
    }

    /// Live check against Google Gemini, billed to the key's project (a few hundred tokens).
    /// Run with GEMINI_API_KEY set: cargo test live_gemini -- --ignored (GEMINI_MODEL overrides the model).
    #[tokio::test]
    #[ignore]
    async fn live_gemini_structured_output() {
        let model = std::env::var("GEMINI_MODEL").ok().or_else(|| preset("gemini").unwrap().suggested.first().map(|m| m.to_string())).expect("GEMINI_MODEL or a suggested Gemini model");
        let client = ai_client();
        let mut r = req("gemini", &model);
        r.messages[0].content = "Reply with a one-sentence summary saying hello.".into();
        let out = generate(&client, &r, true).await.expect("gemini answered");
        let v: Value = serde_json::from_str(&out.text).expect("valid JSON");
        assert!(v["summary"].is_string(), "{}", out.text);
        assert!(out.input_tokens.unwrap_or(0) > 0 && out.output_tokens.unwrap_or(0) > 0, "usage reported");
    }
}
