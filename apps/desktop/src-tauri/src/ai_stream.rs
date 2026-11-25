//! Streamed model replies for the chat: text arrives piece by piece, so the studio can show a reply
//! while it is being written. Ollama sends JSON lines; OpenAI-style servers and Gemini send
//! server-sent events. Providers without a streaming path here answer in one piece through
//! `ai::generate`. The same rules apply as for one-shot calls: cloud providers need the user's
//! opt-in, keys go only to their provider, and busy cloud models are retried twice.

use crate::ai::{self, GenerateRequest, GenerateResult, Kind, Preset};
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// What one streamed chunk can tell us.
#[derive(Debug, PartialEq)]
pub enum Piece {
    Text(String),
    Usage { input: Option<u64>, output: Option<u64> },
    Finish(String),
    ServedBy(String),
    Problem(String),
    /// The provider was overloaded and broke the answer off partway; asking again usually works.
    Busy(String),
}

/// Splits a byte stream into lines, keeping an unfinished line for the next chunk.
#[derive(Default)]
pub struct Lines {
    buf: Vec<u8>,
}

impl Lines {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = vec![];
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            out.push(String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_string());
        }
        out
    }

    pub fn rest(&mut self) -> Option<String> {
        let s = String::from_utf8_lossy(&self.buf).trim().to_string();
        self.buf.clear();
        (!s.is_empty()).then_some(s)
    }
}

/// The payload of a server-sent-events `data:` line.
pub fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(|d| d.strip_prefix(' ').unwrap_or(d))
}

pub fn openai_pieces(v: &Value) -> Vec<Piece> {
    let mut out = vec![];
    if let Some(m) = v["model"].as_str() {
        out.push(Piece::ServedBy(m.into()));
    }
    if let Some(e) = v.pointer("/error/message").and_then(|m| m.as_str()) {
        out.push(Piece::Problem(e.chars().take(240).collect()));
    }
    let choice = &v["choices"][0];
    if let Some(t) = choice.pointer("/delta/content").and_then(|c| c.as_str()).filter(|t| !t.is_empty()) {
        out.push(Piece::Text(t.into()));
    }
    if choice.pointer("/delta/refusal").and_then(|c| c.as_str()).is_some_and(|r| !r.is_empty()) {
        out.push(Piece::Problem("The model declined this request.".into()));
    }
    if let Some(f) = choice["finish_reason"].as_str() {
        out.push(Piece::Finish(f.into()));
    }
    if v["usage"].is_object() {
        out.push(Piece::Usage { input: v["usage"]["prompt_tokens"].as_u64(), output: v["usage"]["completion_tokens"].as_u64() });
    }
    out
}

pub fn gemini_pieces(v: &Value) -> Vec<Piece> {
    let mut out = vec![];
    if let Some(m) = v["modelVersion"].as_str() {
        out.push(Piece::ServedBy(m.into()));
    }
    if let Some(e) = v.pointer("/error/message").and_then(|m| m.as_str()) {
        let message: String = e.chars().take(240).collect();
        // Gemini can answer HTTP 200, stream part of an answer and then send an error such as
        // {"code": 503, "status": "UNAVAILABLE", "message": "This model is currently experiencing high demand..."}.
        let code = v.pointer("/error/code").and_then(|c| c.as_u64());
        let status = v.pointer("/error/status").and_then(|c| c.as_str());
        let busy = matches!(code, Some(500 | 503 | 504)) || matches!(status, Some("UNAVAILABLE" | "INTERNAL" | "DEADLINE_EXCEEDED"));
        out.push(if busy { Piece::Busy(message) } else { Piece::Problem(message) });
    }
    let candidate = &v["candidates"][0];
    for part in candidate.pointer("/content/parts").and_then(|p| p.as_array()).map(|a| a.as_slice()).unwrap_or_default() {
        // Thought summaries are not part of the answer.
        if part["thought"].as_bool() == Some(true) {
            continue;
        }
        if let Some(t) = part["text"].as_str().filter(|t| !t.is_empty()) {
            out.push(Piece::Text(t.into()));
        }
    }
    if let Some(f) = candidate["finishReason"].as_str() {
        out.push(Piece::Finish(f.into()));
    }
    if v["usageMetadata"].is_object() {
        out.push(Piece::Usage { input: v["usageMetadata"]["promptTokenCount"].as_u64(), output: v["usageMetadata"]["candidatesTokenCount"].as_u64() });
    }
    out
}

pub fn ollama_pieces(v: &Value) -> Vec<Piece> {
    let mut out = vec![];
    if let Some(m) = v["model"].as_str() {
        out.push(Piece::ServedBy(m.into()));
    }
    if let Some(e) = v["error"].as_str() {
        out.push(Piece::Problem(e.chars().take(240).collect()));
    }
    if let Some(t) = v.pointer("/message/content").and_then(|c| c.as_str()).filter(|t| !t.is_empty()) {
        out.push(Piece::Text(t.into()));
    }
    if v["done"].as_bool() == Some(true) {
        out.push(Piece::Finish(v["done_reason"].as_str().unwrap_or("stop").into()));
        out.push(Piece::Usage { input: v["prompt_eval_count"].as_u64(), output: v["eval_count"].as_u64() });
    }
    out
}

/// Collects the pieces of one reply.
#[derive(Default)]
struct Reply {
    text: String,
    input: Option<u64>,
    output: Option<u64>,
    served_by: Option<String>,
    finish: Option<String>,
    problem: Option<String>,
    busy: Option<String>,
}

impl Reply {
    fn take(&mut self, piece: Piece, on_text: &(dyn Fn(&str) + Send + Sync)) {
        match piece {
            Piece::Text(t) => {
                self.text.push_str(&t);
                on_text(&t);
            }
            Piece::Usage { input, output } => {
                self.input = input.or(self.input);
                self.output = output.or(self.output);
            }
            Piece::Finish(f) => self.finish = Some(f),
            Piece::ServedBy(m) => self.served_by = Some(m),
            Piece::Problem(p) => {
                self.problem.get_or_insert(p);
            }
            Piece::Busy(p) => {
                self.busy.get_or_insert(p);
            }
        }
    }
}

fn stopped() -> AppError {
    AppError::Unavailable("Stopped.".into())
}

/// Opens the streaming request for providers that have a streaming path here.
async fn open(client: &reqwest::Client, p: &Preset, req: &GenerateRequest) -> AppResult<reqwest::Response> {
    let timeout = Duration::from_secs(if p.kind == Kind::Cloud { 180 } else { 300 });
    let send_err = |e: reqwest::Error| AppError::Unavailable(if e.is_timeout() { format!("{} did not answer in time", p.label) } else if e.is_connect() { format!("Could not connect to {}", p.label) } else { format!("{} request failed", p.label) });
    let builder = match p.id {
        "ollama" => {
            let think = ai::ollama_think(client, &req.model).await;
            let mut body = ai::ollama_body(req, think);
            body["stream"] = json!(true);
            client.post(format!("{}/api/chat", p.base)).json(&body)
        }
        "lmstudio" | "openai" => {
            let mut body = ai::openai_body(req, p.id == "lmstudio");
            body["stream"] = json!(true);
            body["stream_options"] = json!({"include_usage": true});
            let b = client.post(format!("{}/v1/chat/completions", p.base)).json(&body);
            if p.id == "openai" {
                let (_, key) = ai::env_key(p).ok_or_else(|| AppError::Unavailable("OPENAI_API_KEY is not set".into()))?;
                b.bearer_auth(key)
            } else {
                b
            }
        }
        "gemini" => {
            let (_, key) = ai::env_key(p).ok_or_else(|| AppError::Unavailable("GEMINI_API_KEY is not set".into()))?;
            if !req.model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')) {
                return Err(AppError::Invalid("Invalid Gemini model name".into()));
            }
            client.post(format!("{}/v1beta/models/{}:streamGenerateContent?alt=sse", p.base, req.model)).header("x-goog-api-key", key).json(&ai::gemini_body(req))
        }
        _ => return Err(AppError::Invalid("This provider has no streaming path".into())),
    };
    builder.timeout(timeout).send().await.map_err(send_err)
}

/// Streams one reply, calling `on_text` with each new piece of text. Sending on `cancel` stops it.
/// When a cloud model is overloaded, before answering or partway through, the request is made again
/// (at most twice in all); before asking again after a broken-off answer, `on_restart` is called so
/// the text shown so far can be cleared.
pub async fn stream(client: &reqwest::Client, req: &GenerateRequest, allow_cloud: bool, on_text: &(dyn Fn(&str) + Send + Sync), on_restart: &(dyn Fn() + Send + Sync), mut cancel: oneshot::Receiver<()>) -> AppResult<GenerateResult> {
    ai::validate(req)?;
    let p = ai::preset(&req.provider)?;
    if p.kind == Kind::Cloud && !allow_cloud {
        return Err(ai::cloud_denied(p));
    }
    if !matches!(p.id, "ollama" | "lmstudio" | "openai" | "gemini") {
        let r = tokio::select! {
            r = ai::generate(client, req, allow_cloud) => r?,
            _ = &mut cancel => return Err(stopped()),
        };
        on_text(&r.text);
        return Ok(r);
    }
    stream_with(p, req, on_text, on_restart, cancel, || open(client, p, req), |n| Duration::from_secs(if n == 1 { 2 } else { 6 })).await
}

/// The streaming loop, apart from how a request is sent and how long to wait before asking again,
/// so tests can feed it prepared replies.
async fn stream_with<F, Fut>(p: &Preset, req: &GenerateRequest, on_text: &(dyn Fn(&str) + Send + Sync), on_restart: &(dyn Fn() + Send + Sync), mut cancel: oneshot::Receiver<()>, mut connect: F, pause: fn(u32) -> Duration) -> AppResult<GenerateResult>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<reqwest::Response>>,
{
    let started = Instant::now();
    // One budget for both kinds of overload, refused before answering (HTTP 5xx) or broken off
    // partway (an error event in the stream): each retry is another request, so at most two.
    let mut retries = 0;
    loop {
        let resp = loop {
            let resp = tokio::select! {
                r = connect() => r?,
                _ = &mut cancel => return Err(stopped()),
            };
            let status = resp.status().as_u16();
            if (200..300).contains(&status) {
                break resp;
            }
            if p.kind == Kind::Cloud && matches!(status, 500 | 502 | 503 | 529) && retries < 2 {
                retries += 1;
                tokio::select! {
                    _ = tokio::time::sleep(pause(retries)) => {}
                    _ = &mut cancel => return Err(stopped()),
                }
                continue;
            }
            let (_, body) = ai::read_json(resp).await?;
            return Err(AppError::Unavailable(ai::http_problem(p, &req.model, status, &body)));
        };
        let reply = read_reply(p, resp, on_text, &mut cancel).await?;
        if reply.busy.is_some() && p.kind == Kind::Cloud && retries < 2 {
            retries += 1;
            on_restart();
            tokio::select! {
                _ = tokio::time::sleep(pause(retries)) => {}
                _ = &mut cancel => return Err(stopped()),
            }
            continue;
        }
        return finish(p, req, reply, started);
    }
}

/// Reads one streamed response, passing each new piece of text to `on_text`.
async fn read_reply(p: &Preset, mut resp: reqwest::Response, on_text: &(dyn Fn(&str) + Send + Sync), cancel: &mut oneshot::Receiver<()>) -> AppResult<Reply> {
    let sse = p.id != "ollama";
    let mut lines = Lines::default();
    let mut reply = Reply::default();
    let mut bytes = 0usize;
    let handle = |line: String, reply: &mut Reply| {
        let payload = if sse { sse_data(&line).map(str::to_string) } else { Some(line) };
        let Some(payload) = payload.filter(|d| !d.is_empty() && d != "[DONE]") else { return };
        let Ok(v) = serde_json::from_str::<Value>(&payload) else { return };
        let pieces = match p.id {
            "gemini" => gemini_pieces(&v),
            "ollama" => ollama_pieces(&v),
            _ => openai_pieces(&v),
        };
        for piece in pieces {
            reply.take(piece, on_text);
        }
    };
    loop {
        let chunk = tokio::select! {
            c = resp.chunk() => c.map_err(|e| AppError::Unavailable(format!("Connection interrupted: {e}")))?,
            _ = &mut *cancel => return Err(stopped()),
        };
        let Some(chunk) = chunk else { break };
        bytes += chunk.len();
        if bytes > ai::MAX_RESPONSE_BYTES {
            return Err(AppError::Invalid("The provider response was unexpectedly large".into()));
        }
        for line in lines.push(&chunk) {
            handle(line, &mut reply);
        }
    }
    if let Some(line) = lines.rest() {
        handle(line, &mut reply);
    }
    Ok(reply)
}

fn finish(p: &Preset, req: &GenerateRequest, reply: Reply, started: Instant) -> AppResult<GenerateResult> {
    let mut notes = vec![];
    match reply.finish.as_deref() {
        Some("SAFETY") | Some("PROHIBITED_CONTENT") | Some("BLOCKLIST") => return Err(AppError::Denied(format!("{} declined this request", p.label))),
        Some("length") if p.id == "ollama" => notes.push("The answer reached the length limit and may be incomplete.".to_string()),
        Some("length") | Some("MAX_TOKENS") => return Err(AppError::Unavailable("The answer was cut off at the token limit".into())),
        _ => {}
    }
    // An error in the stream means the answer did not finish, however much text came before it.
    let partway = !reply.text.trim().is_empty();
    if let Some(busy) = reply.busy {
        let how = if partway { " and stopped partway through its answer" } else { "" };
        return Err(AppError::Unavailable(format!("{} is overloaded at {} right now{how}. Try again shortly or choose another model. ({busy})", req.model, p.label)));
    }
    if let Some(problem) = reply.problem {
        if problem.starts_with("The model declined") {
            return Err(AppError::Denied(problem));
        }
        return Err(AppError::Unavailable(if partway { format!("{} stopped partway through its answer: {problem}", p.label) } else { format!("{}: {problem}", p.label) }));
    }
    if reply.text.trim().is_empty() {
        return Err(AppError::Unavailable(format!("{} returned no content", p.label)));
    }
    Ok(GenerateResult {
        provider: p.id.into(),
        model: req.model.clone(),
        text: reply.text,
        input_tokens: reply.input,
        output_tokens: reply.output,
        served_by: reply.served_by,
        notes,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn splits_lines_across_chunks() {
        let mut l = Lines::default();
        assert_eq!(l.push(b"data: {\"a\""), Vec::<String>::new());
        assert_eq!(l.push(b":1}\r\n\r\ndata: [DO"), vec!["data: {\"a\":1}".to_string(), String::new()]);
        assert_eq!(l.push(b"NE]\n"), vec!["data: [DONE]".to_string()]);
        assert_eq!(l.rest(), None);
        l.push(b"{\"done\":true}");
        assert_eq!(l.rest().as_deref(), Some("{\"done\":true}"));
        assert_eq!(sse_data("data: x"), Some("x"));
        assert_eq!(sse_data("data:x"), Some("x"));
        assert_eq!(sse_data("event: ping"), None);
    }

    #[test]
    fn reads_pieces_from_each_provider() {
        let o = json!({"model": "gpt-x", "choices": [{"delta": {"content": "He"}, "finish_reason": null}]});
        assert_eq!(openai_pieces(&o), vec![Piece::ServedBy("gpt-x".into()), Piece::Text("He".into())]);
        let o_end = json!({"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 3}});
        assert_eq!(openai_pieces(&o_end), vec![Piece::Usage { input: Some(9), output: Some(3) }]);
        let g = json!({"candidates": [{"content": {"parts": [{"text": "plan", "thought": true}, {"text": "{\"summary\""}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2}, "modelVersion": "gemini-3.5-flash-lite"});
        assert_eq!(gemini_pieces(&g), vec![Piece::ServedBy("gemini-3.5-flash-lite".into()), Piece::Text("{\"summary\"".into()), Piece::Finish("STOP".into()), Piece::Usage { input: Some(5), output: Some(2) }]);
        let ol = json!({"model": "qwen3:8b", "message": {"content": "", "thinking": "hmm"}, "done": true, "done_reason": "stop", "prompt_eval_count": 7, "eval_count": 4});
        assert_eq!(ollama_pieces(&ol), vec![Piece::ServedBy("qwen3:8b".into()), Piece::Finish("stop".into()), Piece::Usage { input: Some(7), output: Some(4) }]);
    }

    #[test]
    fn finishing_reports_cut_offs_refusals_and_empty_answers() {
        let req = GenerateRequest { provider: "gemini".into(), model: "m".into(), system: "s".into(), messages: vec![], schema: json!({}), schema_name: "p".into(), max_tokens: None, effort: None };
        let p = ai::preset("gemini").unwrap();
        let reply = |text: &str, finish: &str| Reply { text: text.into(), finish: Some(finish.into()), ..Default::default() };
        assert!(matches!(finish(p, &req, reply("{}", "MAX_TOKENS"), Instant::now()), Err(AppError::Unavailable(_))));
        assert!(matches!(finish(p, &req, reply("", "SAFETY"), Instant::now()), Err(AppError::Denied(_))));
        assert!(matches!(finish(p, &req, reply(" ", "STOP"), Instant::now()), Err(AppError::Unavailable(_))));
        let ok = finish(p, &req, reply("{\"summary\":\"hi\"}", "STOP"), Instant::now()).unwrap();
        assert_eq!(ok.text, "{\"summary\":\"hi\"}");
        let seen = Mutex::new(String::new());
        let mut r = Reply::default();
        r.take(Piece::Text("a".into()), &|t| seen.lock().unwrap().push_str(t));
        r.take(Piece::Problem("first".into()), &|_| {});
        r.take(Piece::Problem("second".into()), &|_| {});
        assert_eq!((seen.lock().unwrap().as_str(), r.problem.as_deref()), ("a", Some("first")));
    }

    fn sse(events: &[Value]) -> reqwest::Response {
        let body: String = events.iter().map(|e| format!("data: {e}\r\n\r\n")).collect();
        reqwest::Response::from(tauri::http::Response::builder().status(200).header("content-type", "text/event-stream").body(body).unwrap())
    }

    fn gemini_request() -> GenerateRequest {
        GenerateRequest { provider: "gemini".into(), model: "gemini-flash-lite-latest".into(), system: "s".into(), messages: vec![], schema: json!({}), schema_name: "p".into(), max_tokens: None, effort: None }
    }

    fn part(t: &str) -> Value {
        json!({"candidates": [{"content": {"parts": [{"text": t}]}}], "modelVersion": "gemini-3.5-flash-lite"})
    }

    fn overloaded() -> Value {
        json!({"error": {"code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", "status": "UNAVAILABLE"}})
    }

    fn stop(t: &str) -> Value {
        json!({"candidates": [{"content": {"parts": [{"text": t}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 3}})
    }

    #[test]
    fn tells_an_overload_partway_from_other_stream_errors() {
        assert_eq!(gemini_pieces(&overloaded()), vec![Piece::Busy("This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.".into())]);
        let bad = json!({"error": {"code": 400, "message": "Invalid schema", "status": "INVALID_ARGUMENT"}});
        assert_eq!(gemini_pieces(&bad), vec![Piece::Problem("Invalid schema".into())]);
        // Whatever arrived before an error is not an answer.
        let req = gemini_request();
        let p = ai::preset("gemini").unwrap();
        let cut = Reply { text: "{\"reply\": \"Half".into(), busy: Some("high demand".into()), ..Default::default() };
        let e = finish(p, &req, cut, Instant::now()).unwrap_err().to_string();
        assert!(e.contains("overloaded") && e.contains("stopped partway"), "{e}");
        let broken = Reply { text: "{\"re".into(), problem: Some("Invalid schema".into()), ..Default::default() };
        assert!(matches!(finish(p, &req, broken, Instant::now()), Err(AppError::Unavailable(ref m)) if m.contains("stopped partway")));
    }

    #[tokio::test]
    async fn asks_again_when_an_answer_breaks_off_and_clears_what_was_shown() {
        let req = gemini_request();
        let p = ai::preset("gemini").unwrap();
        // A refused request (HTTP 503), then an answer broken off partway, then a whole answer.
        let refused = reqwest::Response::from(tauri::http::Response::builder().status(503).body(r#"{"error": {"code": 503, "status": "UNAVAILABLE"}}"#).unwrap());
        let mut replies = vec![refused, sse(&[part("{\"reply\": \"Half"), overloaded()]), sse(&[part("{\"reply\": \"Whole\""), stop("}")])].into_iter();
        let shown = Mutex::new(String::new());
        let restarts = Mutex::new(0);
        let (_tx, rx) = oneshot::channel();
        let out = stream_with(p, &req, &|t| shown.lock().unwrap().push_str(t), &|| {
            *restarts.lock().unwrap() += 1;
            shown.lock().unwrap().clear();
        }, rx, || {
            let r = replies.next();
            async move { r.ok_or_else(|| AppError::Unavailable("asked too often".into())) }
        }, |_| Duration::ZERO)
        .await
        .unwrap();
        assert_eq!(out.text, "{\"reply\": \"Whole\"}");
        assert_eq!(*restarts.lock().unwrap(), 1);
        assert_eq!(shown.lock().unwrap().as_str(), out.text);
        assert_eq!(out.output_tokens, Some(3));
    }

    #[tokio::test]
    async fn gives_up_after_asking_twice_more() {
        let req = gemini_request();
        let p = ai::preset("gemini").unwrap();
        let calls = Mutex::new(0);
        let (_tx, rx) = oneshot::channel();
        let e = stream_with(p, &req, &|_| {}, &|| {}, rx, || {
            *calls.lock().unwrap() += 1;
            let r = sse(&[part("{\"re"), overloaded()]);
            async move { Ok(r) }
        }, |_| Duration::ZERO)
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(*calls.lock().unwrap(), 3);
        assert!(e.contains("gemini-flash-lite-latest is overloaded at Google Gemini") && e.contains("stopped partway") && e.contains("high demand"), "{e}");
    }

    #[tokio::test]
    async fn a_local_model_that_breaks_off_is_not_asked_again() {
        let req = GenerateRequest { provider: "ollama".into(), model: "qwen3:8b".into(), ..gemini_request() };
        let p = ai::preset("ollama").unwrap();
        let body = format!("{}\n{}\n", json!({"model": "qwen3:8b", "message": {"content": "{\"re"}}), json!({"error": "model runner has unexpectedly stopped"}));
        let calls = Mutex::new(0);
        let (_tx, rx) = oneshot::channel();
        let e = stream_with(p, &req, &|_| {}, &|| {}, rx, || {
            *calls.lock().unwrap() += 1;
            let r = reqwest::Response::from(tauri::http::Response::builder().status(200).body(body.clone()).unwrap());
            async move { Ok(r) }
        }, |_| Duration::ZERO)
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(*calls.lock().unwrap(), 1);
        assert!(e.contains("stopped partway through its answer: model runner has unexpectedly stopped"), "{e}");
    }

    /// Live check: streams one short reply from Google Gemini (billed to the key's project).
    /// Run with GEMINI_API_KEY set: cargo test live_gemini_stream -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_gemini_stream() {
        let model = std::env::var("GEMINI_MODEL").unwrap_or_else(|_| ai::preset("gemini").unwrap().suggested[0].to_string());
        let req = GenerateRequest {
            provider: "gemini".into(),
            model,
            system: "You edit game projects.".into(),
            messages: vec![ai::ChatMessage { role: "user".into(), content: "In two sentences, suggest one idea for a valley level.".into() }],
            schema: json!({"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"], "additionalProperties": false}),
            schema_name: "reply".into(),
            max_tokens: None,
            effort: None,
        };
        let pieces = Mutex::new(Vec::<String>::new());
        let restarts = Mutex::new(0);
        let (_tx, rx) = oneshot::channel();
        // Like the page: when Gemini breaks an answer off and is asked again, the pieces so far no longer count.
        let restart = || {
            *restarts.lock().unwrap() += 1;
            pieces.lock().unwrap().clear();
        };
        let out = stream(&ai::ai_client(), &req, true, &|t| pieces.lock().unwrap().push(t.to_string()), &restart, rx).await.expect("gemini streamed");
        let pieces = pieces.into_inner().unwrap();
        assert_eq!(pieces.concat(), out.text);
        let v: Value = serde_json::from_str(&out.text).expect("valid JSON");
        assert!(v["summary"].is_string(), "{}", out.text);
        eprintln!("{} pieces, {} chars, {} restarts, served by {:?}", pieces.len(), out.text.len(), restarts.into_inner().unwrap(), out.served_by);
    }
}
