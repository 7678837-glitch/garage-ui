use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let index = manifest_dir.join("../../web/dist/index.html");
    if !index.is_file() {
        panic!(
            "前端产物缺失：先在仓库 web 目录执行 bun run build。缺少 {}",
            index.display()
        );
    }
    println!("cargo:rerun-if-changed=../../web/dist");
    println!("cargo:rerun-if-changed=../../VERSION");

    let version = std::fs::read_to_string(manifest_dir.join("../../VERSION"))
        .unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=GARAGE_UI_VERSION={}", version.trim());

    let commit = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
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
