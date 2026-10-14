use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let index = manifest_dir.join("../../web/dist/index.html");
    if !index.is_file() {
        panic!(
            "Frontend bundle missing: run bun run build in web first. Missing {}",
            index.display()
        );
    }
    println!("cargo:rerun-if-changed=../../web/dist");
    println!("cargo:rerun-if-changed=../../VERSION");

    let version = std::fs::read_to_string(manifest_dir.join("../../VERSION"))
        .unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=GARAGE_UI_VERSION={}", version.trim());

    let repo = manifest_dir.join("../..");
    println!("cargo:rerun-if-env-changed=GIT_COMMIT");
    for name in ["HEAD", "packed-refs"] {
        if let Some(path) = git_output(&repo, &["rev-parse", "--git-path", name]) {
            println!("cargo:rerun-if-changed={}", repo.join(path).display());
        }
    }
    if let Some(reference) = git_output(&repo, &["symbolic-ref", "--quiet", "HEAD"]) {
        if let Some(path) = git_output(&repo, &["rev-parse", "--git-path", &reference]) {
            println!("cargo:rerun-if-changed={}", repo.join(path).display());
        }
    }
    let commit = match std::env::var("GIT_COMMIT") {
        Ok(value) if value == "unknown" || valid_commit(&value) => value,
        Ok(_) => panic!("GIT_COMMIT must be a full hexadecimal Git commit ID or unknown"),
        Err(std::env::VarError::NotPresent) => git_output(&repo, &["rev-parse", "HEAD"])
            .filter(|value| valid_commit(value))
            .unwrap_or_else(|| "unknown".to_string()),
        Err(_) => panic!("GIT_COMMIT must contain valid Unicode"),
    };
    println!("cargo:rustc-env=GARAGE_UI_COMMIT={commit}");

    let build_time = Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=GARAGE_UI_BUILD_TIME={build_time}");
}

fn valid_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn git_output(repo: &std::path::Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
