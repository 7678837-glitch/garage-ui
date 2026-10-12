use std::collections::HashSet;
use std::io::{Cursor, Write};

use crate::error::ApiError;

pub(crate) fn token_is_fresh(age_secs: i64) -> bool {
    (0..60).contains(&age_secs)
}

pub(crate) struct PlannedFile {
    pub key: String,
    pub name: String,
}

pub(crate) fn archive_names(keys: &[String]) -> Vec<PlannedFile> {
    let cleaned: Vec<String> = keys.iter().map(|key| clean_key(key)).collect();
    let stripped = drop_shared_prefix(&cleaned);
    let mut used = HashSet::new();
    stripped
        .into_iter()
        .zip(keys.iter())
        .map(|(name, key)| PlannedFile {
            key: key.clone(),
            name: unique_name(&name, &mut used),
        })
        .collect()
}

pub(crate) fn pack_zip(files: &[(String, Vec<u8>)], errors: &[String]) -> Result<Vec<u8>, ApiError> {
    let mut cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut cursor);
    let options = stored_options();
    for (name, bytes) in files {
        writer
            .start_file(name.as_str(), options)
            .map_err(|_| ApiError::internal())?;
        writer.write_all(bytes).map_err(|_| ApiError::internal())?;
    }
    if !errors.is_empty() {
        writer
            .start_file("_errors.txt", options)
            .map_err(|_| ApiError::internal())?;
        writer
            .write_all(errors.join("\n").as_bytes())
            .map_err(|_| ApiError::internal())?;
        writer.write_all(b"\n").map_err(|_| ApiError::internal())?;
    }
    writer.finish().map_err(|_| ApiError::internal())?;
    Ok(cursor.into_inner())
}

fn stored_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
}

fn clean_key(key: &str) -> String {
    let normalized = key.replace('\\', "/");
    let mut parts = Vec::new();
    for segment in normalized.split('/') {
        let segment = strip_drive(segment);
        if segment.is_empty() || segment == "." || segment == ".." {
            continue;
        }
        parts.push(segment.to_string());
    }
    if parts.is_empty() {
        "object".to_string()
    } else {
        parts.join("/")
    }
}

fn strip_drive(segment: &str) -> &str {
    let bytes = segment.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        &segment[2..]
    } else {
        segment
    }
}

fn drop_shared_prefix(names: &[String]) -> Vec<String> {
    if names.len() < 2 {
        return names.to_vec();
    }
    let split: Vec<Vec<&str>> = names.iter().map(|name| name.split('/').collect()).collect();
    let shortest = split.iter().map(Vec::len).min().unwrap_or(0);
    let mut shared = 0usize;
    for index in 0..shortest.saturating_sub(1) {
        let head = split[0][index];
        if split.iter().all(|parts| parts.get(index) == Some(&head)) {
            shared += 1;
        } else {
            break;
        }
    }
    if shared == 0 {
        return names.to_vec();
    }
    names
        .iter()
        .map(|name| {
            let rest = name.split('/').skip(shared).collect::<Vec<_>>().join("/");
            if rest.is_empty() {
                "object".to_string()
            } else {
                rest
            }
        })
        .collect()
}

fn unique_name(name: &str, used: &mut HashSet<String>) -> String {
    if used.insert(name.to_string()) {
        return name.to_string();
    }
    let (dir, base) = match name.rsplit_once('/') {
        Some((dir, base)) => (Some(dir), base),
        None => (None, name),
    };
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, Some(ext)),
        _ => (base, None),
    };
    let mut suffix = 2u32;
    loop {
        let file = match ext {
            Some(ext) => format!("{stem}-{suffix}.{ext}"),
            None => format!("{stem}-{suffix}"),
        };
        let candidate = match dir {
            Some(dir) => format!("{dir}/{file}"),
            None => file,
        };
        if used.insert(candidate.clone()) {
            return candidate;
        }
        suffix += 1;
    }
}
