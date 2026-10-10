use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub buckets: u64,
    pub keys: u64,
    pub objects: u64,
    pub prefix_depth: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub plan: Plan,
    pub buckets_done: u64,
    pub keys_done: u64,
    pub objects_done: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remaining {
    pub buckets: u64,
    pub keys: u64,
    pub objects: u64,
}

pub fn load_checkpoint(path: &Path) -> anyhow::Result<Option<Checkpoint>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("读取断点失败: {}", path.display()))?;
    let checkpoint = serde_json::from_str(&text)
        .with_context(|| format!("断点不是有效 JSON: {}", path.display()))?;
    Ok(Some(checkpoint))
}

pub fn remaining(plan: &Plan, done: Option<&Checkpoint>) -> anyhow::Result<Remaining> {
    let Some(done) = done else {
        return Ok(Remaining {
            buckets: plan.buckets,
            keys: plan.keys,
            objects: plan.objects,
        });
    };
    if &done.plan != plan {
        anyhow::bail!("断点里的计划与本次参数不一致");
    }
    if done.buckets_done > plan.buckets
        || done.keys_done > plan.keys
        || done.objects_done > plan.objects
    {
        anyhow::bail!("断点进度超过本次计划");
    }
    Ok(Remaining {
        buckets: plan.buckets - done.buckets_done,
        keys: plan.keys - done.keys_done,
        objects: plan.objects - done.objects_done,
    })
}

/// 按序号给出固定的对象大小，方便以后接上真实写入时复现同一次计划。
pub fn object_size(index: u64) -> u64 {
    match index % 10 {
        0 => 1024,
        1..=7 => 64 * 1024,
        8 => 1024 * 1024,
        _ => 8 * 1024 * 1024,
    }
}

pub fn object_key(index: u64, prefix_depth: u32) -> String {
    let mut parts = Vec::with_capacity(prefix_depth as usize + 1);
    let mut value = index;
    for _ in 0..prefix_depth {
        parts.push(format!("p{}", value % 16));
        value /= 16;
    }
    parts.push(format!("obj-{index}"));
    parts.join("/")
}

/// `--dry-run` 只返回剩余数量，不写断点。未加 `--dry-run` 时直接失败，不创建任何对象。
pub fn execute(plan: &Plan, checkpoint_path: &Path, dry_run: bool) -> anyhow::Result<Remaining> {
    let saved = load_checkpoint(checkpoint_path)?;
    let left = remaining(plan, saved.as_ref())?;
    if !dry_run {
        anyhow::bail!("尚未接入 Garage，不能创建桶、密钥或对象。需要只看计划时加 --dry-run");
    }
    Ok(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Plan {
        Plan {
            buckets: 3,
            keys: 2,
            objects: 10,
            prefix_depth: 2,
        }
    }

    #[test]
    fn fresh_plan_counts_everything() {
        let left = remaining(&plan(), None).unwrap();
        assert_eq!(
            left,
            Remaining {
                buckets: 3,
                keys: 2,
                objects: 10,
            }
        );
    }

    #[test]
    fn resume_skips_completed_counts() {
        let saved = Checkpoint {
            plan: plan(),
            buckets_done: 1,
            keys_done: 2,
            objects_done: 4,
        };
        let left = remaining(&plan(), Some(&saved)).unwrap();
        assert_eq!(
            left,
            Remaining {
                buckets: 2,
                keys: 0,
                objects: 6,
            }
        );
    }

    #[test]
    fn plan_mismatch_is_an_error() {
        let mut other = plan();
        other.objects = 11;
        let saved = Checkpoint {
            plan: other,
            buckets_done: 0,
            keys_done: 0,
            objects_done: 0,
        };
        let error = remaining(&plan(), Some(&saved)).unwrap_err();
        assert!(error.to_string().contains("不一致"));
    }

    #[test]
    fn dry_run_reads_checkpoint_and_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("garage-loadgen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("checkpoint.json");
        let saved = Checkpoint {
            plan: plan(),
            buckets_done: 3,
            keys_done: 0,
            objects_done: 1,
        };
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let before = std::fs::read(&path).unwrap();
        let left = execute(&plan(), &path, true).unwrap();
        assert_eq!(left.buckets, 0);
        assert_eq!(left.objects, 9);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_mode_errors_without_creating_a_checkpoint() {
        let path = std::env::temp_dir().join(format!(
            "garage-loadgen-missing-{}-{}.json",
            std::process::id(),
            object_size(0)
        ));
        let _ = std::fs::remove_file(&path);
        let error = execute(&plan(), &path, false).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("尚未接入"));
        assert!(message.contains("--dry-run"));
        assert!(!path.exists());
    }

    #[test]
    fn size_and_key_are_stable() {
        assert_eq!(object_size(0), 1024);
        assert_eq!(object_size(3), 64 * 1024);
        assert_eq!(object_size(8), 1024 * 1024);
        assert_eq!(object_size(9), 8 * 1024 * 1024);
        assert_eq!(object_key(17, 0), "obj-17");
        assert_eq!(object_key(17, 2), "p1/p1/obj-17");
    }
}
