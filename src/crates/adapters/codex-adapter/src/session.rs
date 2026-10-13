//! Bounded, read-only Codex rollout import. Discovery reads headers, never full histories.
use openbitfun_product_domains::session_import::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const SOURCE_REVISION: &str = "codex-rollout-jsonl-v1";
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 128 * 1024 * 1024;
const HEADER_BYTES: usize = 256 * 1024;
const MAX_FILES: usize = 100_000;
const MAX_TURNS: usize = 4096;

struct WorkspaceSources {
    key: String,
    cwd: Option<String>,
    paths: Vec<PathBuf>,
}

#[derive(Clone)]
pub struct CodexSessionReader {
    pub codex_home: PathBuf,
}
impl Default for CodexSessionReader {
    fn default() -> Self {
        Self {
            codex_home: std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
                .unwrap_or_default(),
        }
    }
}
impl CodexSessionReader {
    pub fn new(codex_home: PathBuf) -> Self {
        Self { codex_home }
    }
    pub fn source_revision(&self) -> &'static str {
        SOURCE_REVISION
    }
    fn paths(&self) -> Result<Vec<PathBuf>, String> {
        if !self.codex_home.is_absolute() {
            return Err("Codex home must be an absolute host path".into());
        }
        let mut paths = Vec::new();
        let mut visits = 0usize;
        for name in ["sessions", "archived_sessions"] {
            let root = self.codex_home.join(name);
            if root.exists() {
                collect(&root, &mut paths, 0, &mut visits)?;
            }
        }
        Ok(paths)
    }
    pub fn discover(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        let mut paths = self.paths()?;
        paths.sort_by_cached_key(|p| {
            std::cmp::Reverse(fs::metadata(p).ok().and_then(|m| m.modified().ok()))
        });
        let mut diagnostics = Vec::new();
        let mut candidates = Vec::new();
        let mut matched = 0usize;
        let mut has_more = false;
        let limit = limit.clamp(1, 50);
        let query = query.to_lowercase();
        for path in paths {
            let candidate = match self.inspect_path(&path) {
                Ok(candidate) => candidate,
                Err(error) => {
                    if diagnostics.len() < 20 {
                        diagnostics.push(warning("source_unreadable", &error));
                    }
                    continue;
                }
            };
            if !query.is_empty()
                && !format!(
                    "{} {}",
                    candidate.title.as_deref().unwrap_or(""),
                    candidate.cwd.as_deref().unwrap_or("")
                )
                .to_lowercase()
                .contains(&query)
            {
                continue;
            }
            matched += 1;
            if matched <= cursor {
                continue;
            }
            if candidates.len() == limit {
                has_more = true;
                break;
            }
            candidates.push(candidate);
        }
        Ok(ExternalSessionCatalog {
            schema_version: 1,
            ecosystem_id: "codex".into(),
            source_revision: SOURCE_REVISION.into(),
            next_cursor: has_more.then_some(cursor + candidates.len()),
            candidates,
            diagnostics,
            workspaces: None,
        })
    }

    pub fn discover_workspaces(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
        scope: ExternalSessionCatalogScope,
    ) -> Result<ExternalSessionCatalog, String> {
        let mut paths = self.paths()?;
        paths.sort_by_cached_key(|path| {
            (
                std::cmp::Reverse(
                    fs::metadata(path)
                        .ok()
                        .and_then(|meta| meta.modified().ok()),
                ),
                path.clone(),
            )
        });
        let mut diagnostics = Vec::new();
        let mut groups: Vec<WorkspaceSources> = Vec::new();
        let mut positions = HashMap::new();
        let query = query.to_lowercase();
        for path in paths {
            // Group discovery only needs the source header. Read title previews
            // for the selected sessions, not the full prefix of every rollout.
            let cwd = if query.is_empty() {
                self.inspect_workspace(&path)
            } else {
                match self.inspect_path(&path) {
                    Ok(candidate) => {
                        if !format!(
                            "{} {}",
                            candidate.title.as_deref().unwrap_or(""),
                            candidate.cwd.as_deref().unwrap_or("")
                        )
                        .to_lowercase()
                        .contains(&query)
                        {
                            continue;
                        }
                        Ok(candidate.cwd)
                    }
                    Err(error) => Err(error),
                }
            };
            let cwd = match cwd {
                Ok(cwd) => cwd,
                Err(error) => {
                    if diagnostics.len() < 20 {
                        diagnostics.push(warning("source_unreadable", &error));
                    }
                    continue;
                }
            };
            let key = workspace_key(cwd.as_deref());
            let position = *positions.entry(key.clone()).or_insert_with(|| {
                groups.push(WorkspaceSources {
                    key,
                    cwd,
                    paths: Vec::new(),
                });
                groups.len() - 1
            });
            groups[position].paths.push(path);
        }
        let limit = limit.clamp(1, 50);
        let (workspaces, next_cursor) = match scope {
            ExternalSessionCatalogScope::Workspaces { preview_limit } => {
                let end = cursor.saturating_add(limit).min(groups.len());
                let next_cursor = (end < groups.len()).then_some(end);
                let workspaces = groups
                    .iter()
                    .skip(cursor)
                    .take(limit)
                    .map(|group| self.workspace_page(group, 0, preview_limit.clamp(1, 50)))
                    .collect::<Result<Vec<_>, _>>()?;
                (workspaces, next_cursor)
            }
            ExternalSessionCatalogScope::Workspace { workspace_key } => {
                let group = groups
                    .iter()
                    .find(|group| group.key == workspace_key)
                    .ok_or("Codex workspace sessions were removed or moved; refresh the list")?;
                (vec![self.workspace_page(group, cursor, limit)?], None)
            }
        };
        Ok(ExternalSessionCatalog {
            schema_version: 1,
            ecosystem_id: "codex".into(),
            source_revision: SOURCE_REVISION.into(),
            candidates: Vec::new(),
            diagnostics,
            next_cursor,
            workspaces: Some(workspaces),
        })
    }

    fn inspect_workspace(&self, path: &Path) -> Result<Option<String>, String> {
        let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?)
            .take(HEADER_BYTES as u64);
        let mut line = Vec::new();
        while reader
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?
            > 0
        {
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if value["type"] == "session_meta" {
                    let meta = value["payload"].get("meta").unwrap_or(&value["payload"]);
                    if meta["id"]
                        .as_str()
                        .or_else(|| meta["session_id"].as_str())
                        .is_some()
                    {
                        return Ok(meta["cwd"].as_str().map(str::to_owned));
                    }
                }
            }
            line.clear();
        }
        Err("Rollout header not found in the bounded prefix".into())
    }

    fn workspace_page(
        &self,
        group: &WorkspaceSources,
        cursor: usize,
        limit: usize,
    ) -> Result<ExternalSessionWorkspaceGroup, String> {
        let end = cursor.saturating_add(limit).min(group.paths.len());
        let candidates = group
            .paths
            .iter()
            .skip(cursor)
            .take(limit)
            .map(|path| self.inspect_path(path))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ExternalSessionWorkspaceGroup {
            workspace_key: group.key.clone(),
            cwd: group.cwd.clone(),
            total_count: group.paths.len(),
            candidates,
            next_cursor: (end < group.paths.len()).then_some(end),
        })
    }
    pub fn read_candidate(
        &self,
        id: &str,
        mode: ExternalSessionImportMode,
    ) -> Result<CodexSessionDocument, String> {
        let path = self
            .paths()?
            .into_iter()
            .find(|path| candidate_id(path) == id)
            .ok_or("Codex session was removed or moved; refresh the list")?;
        self.read_path(&path, mode)
    }
    pub fn inspect_path(&self, path: &Path) -> Result<ExternalSessionCandidate, String> {
        let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Codex rollout is not a regular file".into());
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|e| e.to_string())?
            .take(HEADER_BYTES as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let mut session = None;
        let mut title = None;
        let mut model = None;
        for line in bytes.split(|b| *b == b'\n') {
            let Ok(value) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            match value["type"].as_str().unwrap_or("") {
                "session_meta" => {
                    session = Some(
                        value["payload"]
                            .get("meta")
                            .unwrap_or(&value["payload"])
                            .clone(),
                    )
                }
                "turn_context" => model = value["payload"]["model"].as_str().map(str::to_owned),
                "response_item" => {
                    let p = value["payload"].get("item").unwrap_or(&value["payload"]);
                    if p["type"] == "message" && p["role"] == "user" && title.is_none() {
                        let text = content_text(&p["content"]);
                        if !text.is_empty() && !is_injected(&text) {
                            title = Some(preview(&text, 120));
                        }
                    }
                }
                _ => {}
            }
        }
        let session = session.ok_or("Rollout header not found in the bounded prefix")?;
        let source_id = session["id"]
            .as_str()
            .or_else(|| session["session_id"].as_str())
            .ok_or("Codex session id is missing")?
            .to_owned();
        let updated = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        Ok(ExternalSessionCandidate {
            candidate_id: candidate_id(path),
            ecosystem_id: "codex".into(),
            source_session_id: source_id,
            title,
            cwd: session["cwd"].as_str().map(str::to_owned),
            created_at: timestamp(&session["timestamp"]),
            updated_at: updated,
            model_provider: session["model_provider"].as_str().map(str::to_owned),
            model_name: model,
            turn_count: None,
            file_size_bytes: meta.len(),
            format_version: session["cli_version"].as_str().map(str::to_owned),
            status: if meta.len() > MAX_FILE_BYTES {
                ExternalSessionStatus::Unsupported
            } else {
                ExternalSessionStatus::Complete
            },
            fingerprint: format!("metadata:{}:{}", meta.len(), updated.unwrap_or(0)),
            source_location: path
                .strip_prefix(&self.codex_home)
                .ok()
                .map(|p| format!("$CODEX_HOME/{}", p.to_string_lossy().replace('\\', "/"))),
            target_workspace_id: None,
            target_workspace_name: None,
            imported_session_id: None,
        })
    }
    fn read_path(
        &self,
        path: &Path,
        mode: ExternalSessionImportMode,
    ) -> Result<CodexSessionDocument, String> {
        let mut candidate = self.inspect_path(path)?;
        if candidate.file_size_bytes > MAX_FILE_BYTES {
            return Err("Source exceeds the 256 MiB import limit".into());
        }
        let mut reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
        let mut hasher = Sha256::new();
        let mut state = Materializer::default();
        let mut line = Vec::new();
        let mut warnings = BTreeSet::new();
        let mut total = 0usize;
        let mut compacted = false;
        loop {
            line.clear();
            let read = reader
                .by_ref()
                .take((MAX_LINE_BYTES + 1) as u64)
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            if read > MAX_LINE_BYTES {
                return Err("JSONL line exceeds the 8 MiB import limit".into());
            }
            total += read;
            if total as u64 > MAX_FILE_BYTES {
                return Err("Source grew beyond the import limit".into());
            }
            hasher.update(&line);
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let record: Value = match serde_json::from_slice(&line) {
                Ok(record) => record,
                Err(_)
                    if !line.ends_with(b"\n")
                        && reader.fill_buf().map_err(|e| e.to_string())?.is_empty() =>
                {
                    warnings.insert("torn_tail");
                    state.interrupt();
                    break;
                }
                Err(_) => {
                    return Err(
                        "Malformed JSONL inside the rollout; no partial import was created".into(),
                    )
                }
            };
            let time = timestamp(&record["timestamp"])
                .or(candidate.created_at)
                .unwrap_or(0);
            match record["type"].as_str().unwrap_or("") {
                "response_item" => state.item(
                    record["payload"].get("item").unwrap_or(&record["payload"]),
                    time,
                    mode,
                    &mut warnings,
                )?,
                "turn_context" => {
                    if let Some(model) = record["payload"]["model"].as_str() {
                        candidate.model_name = Some(model.into());
                    }
                }
                "event_msg" => state.event(&record["payload"], &mut warnings)?,
                "compacted" => {
                    compacted = true;
                    warnings.insert("compaction_present");
                    if mode == ExternalSessionImportMode::LatestCompacted {
                        let payload = &record["payload"];
                        if let Some(items) = payload["replacement_history"].as_array() {
                            state = Materializer::default();
                            for item in items {
                                state.item(item, time, mode, &mut warnings)?;
                            }
                        } else if let Some(summary) =
                            payload["message"].as_str().filter(|s| !s.is_empty())
                        {
                            state = Materializer::default();
                            state.item(
                                &json!({"type":"message","role":"user","content":format!("[Imported Codex compaction summary]\n{summary}")}),
                                time,
                                mode,
                                &mut warnings,
                            )?;
                            warnings.insert("summary_only");
                        } else {
                            return Err(
                                "Codex compaction has no readable replacement history or summary"
                                    .into(),
                            );
                        }
                    }
                }
                "session_meta" | "token_usage_record" | "retained_context" => {}
                _ => {
                    warnings.insert("unknown_records");
                }
            }
        }
        if mode == ExternalSessionImportMode::LatestCompacted && !compacted {
            warnings.insert("no_compaction");
        }
        state.finish();
        if state.turns.is_empty() {
            return Err("No usable human conversation was found".into());
        }
        if state.turns.len() > MAX_TURNS {
            return Err("Conversation exceeds the 4096 turn import limit".into());
        }
        let text_bytes: usize = state
            .turns
            .iter()
            .map(|t| {
                t.user_text.len()
                    + t.items
                        .iter()
                        .map(|i| serde_json::to_vec(i).map_or(0, |v| v.len()))
                        .sum::<usize>()
            })
            .sum();
        if text_bytes > MAX_DOCUMENT_BYTES {
            return Err("Converted history exceeds the 128 MiB storage budget".into());
        }
        candidate.fingerprint = format!("sha256:{}", hex::encode(hasher.finalize()));
        candidate.turn_count = Some(state.turns.len());
        candidate.status = state.turns.last().unwrap().status;
        Ok(CodexSessionDocument {
            candidate,
            turns: state.turns,
            warnings: warnings
                .into_iter()
                .map(|code| warning(code, code))
                .collect(),
        })
    }
}

#[derive(Default)]
struct Materializer {
    turns: Vec<ExternalSessionTurn>,
    seen: HashSet<String>,
}
impl Materializer {
    fn item(
        &mut self,
        item: &Value,
        time: u64,
        mode: ExternalSessionImportMode,
        warnings: &mut BTreeSet<&'static str>,
    ) -> Result<(), String> {
        if let Some(id) = item["id"].as_str() {
            if !self.seen.insert(id.into()) {
                return Ok(());
            }
        }
        match item["type"].as_str().unwrap_or("") {
            "message" | "agent_message" => {
                let text = content_text(&item["content"]);
                if item["content"].as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|i| matches!(i["type"].as_str(), Some("input_image" | "image")))
                }) {
                    warnings.insert("images_not_imported");
                }
                if text.is_empty() {
                    return Ok(());
                }
                match item["role"].as_str().unwrap_or("assistant") {
                    "user" if !is_injected(&text) => {
                        self.finish();
                        self.turns.push(ExternalSessionTurn {
                            source_turn_id: format!("source-turn-{}", self.turns.len()),
                            timestamp: time,
                            user_text: text,
                            items: Vec::new(),
                            source_event_count: 1,
                            status: ExternalSessionStatus::Interrupted,
                        });
                    }
                    "assistant" => {
                        if let Some(turn) = self.turns.last_mut() {
                            turn.items.push(ExternalSessionItem::Text { text });
                            turn.source_event_count += 1;
                        }
                    }
                    _ => {
                        warnings.insert("source_instructions_not_imported");
                    }
                }
            }
            "reasoning" => {
                let text = content_text(&item["summary"]);
                if let Some(turn) = self.turns.last_mut() {
                    if !text.is_empty() {
                        turn.items.push(ExternalSessionItem::Thinking { text });
                    }
                }
            }
            "function_call" | "custom_tool_call" => {
                if let Some(turn) = self.turns.last_mut() {
                    let id = item["call_id"]
                        .as_str()
                        .or_else(|| item["id"].as_str())
                        .ok_or("Tool call id is missing")?
                        .to_owned();
                    let name = item["name"].as_str().unwrap_or("unknown").to_owned();
                    let raw = item
                        .get("arguments")
                        .or_else(|| item.get("input"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let input = raw
                        .as_str()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(raw);
                    turn.items.push(ExternalSessionItem::Tool {
                        id,
                        name,
                        input,
                        result: None,
                        success: None,
                    });
                    turn.source_event_count += 1;
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let id = item["call_id"].as_str().unwrap_or("");
                let mut matched = false;
                for turn in self.turns.iter_mut().rev() {
                    if let Some(ExternalSessionItem::Tool {
                        result, success, ..
                    }) = turn.items.iter_mut().rev().find(
                        |i| matches!(i, ExternalSessionItem::Tool { id: call, .. } if call == id),
                    ) {
                        *result = Some(item.get("output").cloned().unwrap_or(Value::Null));
                        *success = Some(item["is_error"] != true);
                        matched = true;
                        break;
                    }
                }
                if !matched {
                    warnings.insert("orphan_tool_result");
                }
            }
            "compaction" | "context_compaction" => {
                warnings.insert("compaction_present");
                if mode == ExternalSessionImportMode::LatestCompacted {
                    return Err(
                        "Codex compacted history contains an encrypted context summary; select full history to preserve readable conversation"
                            .into(),
                    );
                }
            }
            _ => {
                warnings.insert("unsupported_response_item");
            }
        }
        Ok(())
    }
    fn event(
        &mut self,
        event: &Value,
        warnings: &mut BTreeSet<&'static str>,
    ) -> Result<(), String> {
        match event["type"].as_str().unwrap_or("") {
            "task_complete" | "turn_complete" => {
                if let Some(t) = self.turns.last_mut() {
                    t.status = ExternalSessionStatus::Complete;
                }
            }
            "turn_aborted" | "error" => self.interrupt(),
            "thread_rolled_back" => {
                let n = event["num_turns"]
                    .as_u64()
                    .ok_or("Invalid rollback count")? as usize;
                self.turns.truncate(self.turns.len().saturating_sub(n));
                self.seen.clear();
                warnings.insert("rolled_back_history");
            }
            // Event mirrors never become additional human prompts or assistant output.
            "user_message" | "agent_message" | "task_started" | "turn_started" | "token_count"
            | "agent_reasoning" | "item_completed" => {}
            _ => {
                warnings.insert("unknown_events");
            }
        }
        Ok(())
    }
    fn interrupt(&mut self) {
        if let Some(t) = self.turns.last_mut() {
            t.status = ExternalSessionStatus::Interrupted;
        }
    }
    fn finish(&mut self) {
        if let Some(t) = self.turns.last_mut() {
            if t.status == ExternalSessionStatus::Interrupted
                && t.items
                    .iter()
                    .any(|i| matches!(i, ExternalSessionItem::Text { .. }))
                && !t
                    .items
                    .iter()
                    .any(|i| matches!(i, ExternalSessionItem::Tool { result: None, .. }))
            {
                t.status = ExternalSessionStatus::Complete;
            }
        }
    }
}
fn collect(
    root: &Path,
    paths: &mut Vec<PathBuf>,
    depth: usize,
    visits: &mut usize,
) -> Result<(), String> {
    if depth > 8 {
        return Err("Codex session directory exceeds the discovery depth limit".into());
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        *visits += 1;
        if *visits > MAX_FILES {
            return Err("Codex discovery exceeds 100000 directory entries".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect(&entry.path(), paths, depth + 1, visits)?;
        } else if kind.is_file()
            && entry.file_name().to_string_lossy().starts_with("rollout-")
            && entry.path().extension().is_some_and(|e| e == "jsonl")
        {
            paths.push(entry.path());
        }
    }
    Ok(())
}
fn workspace_key(cwd: Option<&str>) -> String {
    let path = cwd.unwrap_or("").trim();
    let windows_path = path.as_bytes().get(1) == Some(&b':') || path.starts_with("\\\\");
    let normalized = if windows_path {
        path.replace('\\', "/").trim_end_matches('/').to_lowercase()
    } else if path == "/" {
        path.to_owned()
    } else {
        path.trim_end_matches('/').to_owned()
    };
    format!(
        "codex-workspace:{}",
        hex::encode(Sha256::digest(normalized.as_bytes()))
    )
}

fn candidate_id(path: &Path) -> String {
    format!(
        "codex:{}",
        hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()))
    )
}
fn timestamp(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .and_then(|d| u64::try_from(d.timestamp_millis()).ok())
    })
}
fn content_text(v: &Value) -> String {
    if let Some(text) = v.as_str() {
        return text.into();
    }
    v.as_array()
        .map(|items| {
            items
                .iter()
                .filter(|i| {
                    matches!(
                        i["type"].as_str(),
                        Some("input_text" | "output_text" | "text" | "summary_text")
                    )
                })
                .filter_map(|i| i["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn is_injected(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with("# AGENTS.md instructions for ")
        || text.starts_with("<environment_context>")
        || text.starts_with("<turn_aborted>")
        || text.starts_with("<permissions instructions>")
        || text.starts_with("<codex_internal_context ")
        || (text.starts_with("<external_codex_apps_open_page>")
            && text
                .trim_end()
                .ends_with("</external_codex_apps_open_page>"))
}
pub fn preview(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}
fn warning(code: &str, detail: &str) -> ExternalSessionImportWarning {
    ExternalSessionImportWarning {
        code: code.into(),
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sessions")).unwrap();
        for (id, cwd, modified) in [
            ("a-new", "/a", 60),
            ("a-middle", "/a", 50),
            ("a-old", "/a", 10),
            ("b-new", "/b", 40),
            ("b-old", "/b", 20),
            ("a-other", "/a-other", 30),
        ] {
            let path = dir.path().join(format!("sessions/rollout-{id}.jsonl"));
            fs::write(
                &path,
                format!(
                    "{}\n{}\n",
                    json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}}),
                    msg("user", id)
                ),
            )
            .unwrap();
            File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(modified)),
                )
                .unwrap();
        }
        dir
    }

    #[test]
    fn workspace_pages_follow_recent_activity_with_independent_preview_limits() {
        let dir = workspace_fixture();
        let reader = CodexSessionReader::new(dir.path().into());
        let first = reader
            .discover_workspaces(
                0,
                2,
                "",
                ExternalSessionCatalogScope::Workspaces { preview_limit: 1 },
            )
            .unwrap();
        let groups = first.workspaces.unwrap();
        assert!(first.candidates.is_empty());
        assert_eq!(first.next_cursor, Some(2));
        assert_eq!(
            groups
                .iter()
                .map(|group| group.cwd.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec!["/a", "/b"]
        );
        assert_eq!(groups[0].total_count, 3);
        assert_eq!(groups[0].candidates[0].source_session_id, "a-new");
        assert_eq!(groups[0].next_cursor, Some(1));
        let next = reader
            .discover_workspaces(
                2,
                2,
                "",
                ExternalSessionCatalogScope::Workspaces { preview_limit: 1 },
            )
            .unwrap();
        assert!(next.next_cursor.is_none());
        let groups = next.workspaces.unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].cwd.as_deref(), Some("/a-other"));
        assert!(groups[0].next_cursor.is_none());
    }

    #[test]
    fn workspace_session_cursor_never_includes_other_workspaces() {
        let dir = workspace_fixture();
        let reader = CodexSessionReader::new(dir.path().into());
        let scope = ExternalSessionCatalogScope::Workspace {
            workspace_key: workspace_key(Some("/a")),
        };
        let page = reader.discover_workspaces(1, 1, "", scope.clone()).unwrap();
        assert!(page.next_cursor.is_none());
        let group = &page.workspaces.unwrap()[0];
        assert_eq!(group.candidates[0].source_session_id, "a-middle");
        assert_eq!(group.next_cursor, Some(2));
        let last = reader.discover_workspaces(2, 1, "", scope).unwrap();
        let group = &last.workspaces.unwrap()[0];
        assert_eq!(group.candidates[0].source_session_id, "a-old");
        assert!(group.next_cursor.is_none());
    }

    #[test]
    fn workspace_source_identity_normalizes_windows_paths_without_folding_posix_case() {
        assert_eq!(
            workspace_key(Some("C:\\Work\\Repo\\")),
            workspace_key(Some("c:/work/repo"))
        );
        assert_ne!(
            workspace_key(Some("/Work/Repo")),
            workspace_key(Some("/work/repo"))
        );
        assert_ne!(workspace_key(Some("/")), workspace_key(None));
    }

    fn fixture(records: Vec<Value>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sessions")).unwrap();
        let mut lines = vec![json!({"type":"session_meta","payload":{"id":"s1","cwd":"/repo","timestamp":"2026-10-01T00:00:00Z"}}).to_string()];
        lines.extend(records.iter().map(Value::to_string));
        fs::write(
            dir.path().join("sessions/rollout-test.jsonl"),
            lines.join("\n") + "\n",
        )
        .unwrap();
        dir
    }
    fn msg(role: &str, text: &str) -> Value {
        json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":"input_text","text":text}]}})
    }
    #[test]
    fn deduplicates_mirrors_pairs_tools_and_preserves_turn_order() {
        let dir = fixture(vec![
            msg("user", "first"),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"first"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"c1","name":"exec_command","arguments":"{\"cmd\":\"test\"}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}),
            msg("assistant", "done"),
            msg("user", "second"),
            msg("assistant", "next"),
        ]);
        let reader = CodexSessionReader::new(dir.path().into());
        let list = reader.discover(0, 50, "").unwrap();
        assert_eq!(list.candidates.len(), 1);
        assert_eq!(list.candidates[0].turn_count, None);
        let doc = reader
            .read_candidate(
                &list.candidates[0].candidate_id,
                ExternalSessionImportMode::Full,
            )
            .unwrap();
        assert_eq!(doc.turns.len(), 2);
        assert_eq!(doc.turns[0].items.len(), 2);
        assert!(
            matches!(&doc.turns[0].items[0], ExternalSessionItem::Tool { input, result: Some(_), .. } if input["cmd"] == "test")
        );
    }
    #[test]
    fn compaction_replaces_context_and_rollback_removes_suffix() {
        let dir = fixture(vec![
            msg("user", "old"),
            msg("assistant", "old reply"),
            json!({"type":"compacted","payload":{"replacement_history":[{"type":"message","role":"user","content":"summary"}]}}),
            msg("user", "discard"),
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
            msg("user", "keep"),
        ]);
        let reader = CodexSessionReader::new(dir.path().into());
        let list = reader.discover(0, 50, "").unwrap();
        let doc = reader
            .read_candidate(
                &list.candidates[0].candidate_id,
                ExternalSessionImportMode::LatestCompacted,
            )
            .unwrap();
        assert_eq!(
            doc.turns
                .iter()
                .map(|t| t.user_text.as_str())
                .collect::<Vec<_>>(),
            vec!["summary", "keep"]
        );
    }
    #[test]
    fn encrypted_compaction_requires_full_history_fallback() {
        let dir = fixture(vec![
            msg("user", "before"),
            msg("assistant", "answer"),
            json!({"type":"response_item","payload":{"type":"compaction","id":"compact-1"}}),
            msg("user", "after"),
            msg("assistant", "done"),
        ]);
        let reader = CodexSessionReader::new(dir.path().into());
        let list = reader.discover(0, 50, "").unwrap();
        let id = &list.candidates[0].candidate_id;
        let error = match reader.read_candidate(id, ExternalSessionImportMode::LatestCompacted) {
            Ok(_) => panic!("latest compacted history should require a readable fallback"),
            Err(error) => error,
        };
        assert!(error.contains("encrypted context summary"));
        let document = reader
            .read_candidate(id, ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(document.turns.len(), 2);
        assert!(document
            .warnings
            .iter()
            .any(|warning| warning.code == "compaction_present"));
    }
    #[test]
    fn corrupt_middle_fails_and_torn_tail_is_disclosed() {
        let dir = fixture(vec![msg("user", "hello")]);
        let p = dir.path().join("sessions/rollout-test.jsonl");
        let reader = CodexSessionReader::new(dir.path().into());
        let mut bytes = fs::read(&p).unwrap();
        bytes.extend_from_slice(b"{broken");
        fs::write(&p, &bytes).unwrap();
        let doc = reader
            .read_path(&p, ExternalSessionImportMode::Full)
            .unwrap();
        assert!(doc.warnings.iter().any(|w| w.code == "torn_tail"));
        bytes.extend_from_slice(b"\n");
        fs::write(&p, bytes).unwrap();
        assert!(reader
            .read_path(&p, ExternalSessionImportMode::Full)
            .is_err());
    }
}
