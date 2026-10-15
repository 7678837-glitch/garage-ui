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
    println!("cargo:rerun-if-env-changed=BUILD_VERSION");

    let version = match std::env::var("BUILD_VERSION") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => {
            let source = std::fs::read_to_string(manifest_dir.join("../../VERSION"))
                .expect("VERSION must be readable");
            let stable = source.strip_suffix('\n').unwrap_or(&source);
            assert!(valid_version(stable, false), "VERSION must be YYYYMMDD.N");
            format!("{stable}-local")
        }
        Err(_) => panic!("BUILD_VERSION must contain valid Unicode"),
    };
    assert!(
        valid_version(&version, true),
        "BUILD_VERSION must be YYYYMMDD.N with an optional -dev or -local suffix"
    );
    println!("cargo:rustc-env=GARAGE_UI_VERSION={version}");

    let repo = manifest_dir.join("../..");
    println!("cargo:rerun-if-env-changed=GIT_COMMIT");
    for name in ["HEAD", "packed-refs"] {
        if let Some(path) = git_output(&repo, &["rev-parse", "--git-path", name]) {
            println!("cargo:rerun-if-changed={}", repo.join(path).display());
        }
    }
    if let Some(reference) = git_output(&repo, &["symbolic-ref", "--quiet", "HEAD"])
        && let Some(path) = git_output(&repo, &["rev-parse", "--git-path", &reference])
    {
        println!("cargo:rerun-if-changed={}", repo.join(path).display());
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

fn valid_version(value: &str, allow_suffix: bool) -> bool {
    let value = if allow_suffix {
        value
            .strip_suffix("-dev")
            .or_else(|| value.strip_suffix("-local"))
            .unwrap_or(value)
    } else {
        value
    };
    let Some((date, sequence)) = value.split_once('.') else {
        return false;
    };
    if date.len() != 8
        || !date.bytes().all(|byte| byte.is_ascii_digit())
        || sequence.is_empty()
        || sequence.starts_with('0')
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap();
    let month: u32 = date[4..6].parse().unwrap();
    let day: u32 = date[6..].parse().unwrap();
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    year > 0 && (1..=days).contains(&day)
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
