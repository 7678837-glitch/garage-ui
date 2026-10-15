pub const SHARE_TTL_MAX_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Op {
    ViewCluster = 0,
    ViewStats = 1,
    ViewMetrics = 2,
    ChangeLayout = 3,
    ViewBuckets = 4,
    ChangeBuckets = 5,
    // 矩阵项。阶段 1 的路由还不构造桶密钥列表。
    #[allow(dead_code)]
    ViewBucketKeys = 6,
    ChangeBucketKeys = 7,
    ViewKeys = 8,
    ViewSecret = 9,
    ChangeKeys = 10,
    // 矩阵项。对象列表还没有路由。
    #[allow(dead_code)]
    ViewObjects = 11,
    ReadObjects = 12,
    WriteObjects = 13,
    Share = 14,
    InspectObject = 15,
    ViewOps = 16,
    RunOps = 17,
    AdminTokens = 18,
    // 矩阵项。审计页还没有路由。
    #[allow(dead_code)]
    ViewAudit = 19,
    ManageUsers = 20,
    // 矩阵项。改密走独立处理器，不经过这个变体。
    #[allow(dead_code)]
    ChangeOwnPassword = 21,
    CleanupUploads = 22,
}

#[cfg(test)]
pub const ALL_OPS: [Op; 23] = [
    Op::ViewCluster,
    Op::ViewStats,
    Op::ViewMetrics,
    Op::ChangeLayout,
    Op::ViewBuckets,
    Op::ChangeBuckets,
    Op::ViewBucketKeys,
    Op::ChangeBucketKeys,
    Op::ViewKeys,
    Op::ViewSecret,
    Op::ChangeKeys,
    Op::ViewObjects,
    Op::ReadObjects,
    Op::WriteObjects,
    Op::Share,
    Op::InspectObject,
    Op::ViewOps,
    Op::RunOps,
    Op::AdminTokens,
    Op::ViewAudit,
    Op::ManageUsers,
    Op::ChangeOwnPassword,
    Op::CleanupUploads,
];

#[derive(Clone, Copy, Debug)]
pub struct Actor {
    pub admin: bool,
    pub download: bool,
    pub share: bool,
    pub tenant: bool,
}

pub fn permits(actor: Actor, op: Op) -> bool {
    if actor.admin {
        return true;
    }
    if actor.tenant {
        return tenant_permits(actor, op);
    }
    match op {
        Op::ViewCluster
        | Op::ViewStats
        | Op::ViewMetrics
        | Op::ViewBuckets
        | Op::ViewBucketKeys
        | Op::ViewKeys
        | Op::ViewObjects
        | Op::ChangeOwnPassword => true,
        Op::ReadObjects => actor.download,
        Op::Share => actor.share && actor.download,
        Op::ChangeLayout
        | Op::ChangeBuckets
        | Op::ChangeBucketKeys
        | Op::ChangeKeys
        | Op::ViewSecret
        | Op::WriteObjects
        | Op::CleanupUploads
        | Op::InspectObject
        | Op::ViewOps
        | Op::RunOps
        | Op::AdminTokens
        | Op::ViewAudit
        | Op::ManageUsers => false,
    }
}

// A tenant reaches only its granted buckets. Garage enforces read and write on each S3 request,
// because the request is signed with the tenant's bound key.
fn tenant_permits(actor: Actor, op: Op) -> bool {
    match op {
        Op::ViewBuckets | Op::ViewObjects | Op::WriteObjects | Op::ChangeOwnPassword => true,
        Op::ReadObjects => actor.download,
        Op::Share => actor.share && actor.download,
        Op::ViewCluster
        | Op::ViewStats
        | Op::ViewMetrics
        | Op::ChangeLayout
        | Op::ChangeBuckets
        | Op::ViewBucketKeys
        | Op::ChangeBucketKeys
        | Op::ViewKeys
        | Op::ViewSecret
        | Op::ChangeKeys
        | Op::CleanupUploads
        | Op::InspectObject
        | Op::ViewOps
        | Op::RunOps
        | Op::AdminTokens
        | Op::ViewAudit
        | Op::ManageUsers => false,
    }
}

pub fn cap_share_ttl(seconds: u64) -> u64 {
    seconds.min(SHARE_TTL_MAX_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(admin: bool, download: bool, share: bool, tenant: bool) -> Actor {
        Actor {
            admin,
            download,
            share,
            tenant,
        }
    }

    fn columns(op: Op) -> [bool; 5] {
        [
            permits(actor(true, false, false, false), op),
            permits(actor(false, false, false, false), op),
            permits(actor(false, true, false, false), op),
            permits(actor(false, true, true, false), op),
            permits(actor(false, true, true, true), op),
        ]
    }

    // Columns: A, V, V+D, V+D+S, T (with D and S on).
    fn expected(op: Op) -> [bool; 5] {
        match op {
            Op::ViewCluster => [true, true, true, true, false],
            Op::ViewStats => [true, true, true, true, false],
            Op::ViewMetrics => [true, true, true, true, false],
            Op::ChangeLayout => [true, false, false, false, false],
            Op::ViewBuckets => [true, true, true, true, true],
            Op::ChangeBuckets => [true, false, false, false, false],
            Op::ViewBucketKeys => [true, true, true, true, false],
            Op::ChangeBucketKeys => [true, false, false, false, false],
            Op::ViewKeys => [true, true, true, true, false],
            Op::ViewSecret => [true, false, false, false, false],
            Op::ChangeKeys => [true, false, false, false, false],
            Op::ViewObjects => [true, true, true, true, true],
            Op::ReadObjects => [true, false, true, true, true],
            Op::WriteObjects => [true, false, false, false, true],
            Op::Share => [true, false, false, true, true],
            Op::CleanupUploads => [true, false, false, false, false],
            Op::InspectObject => [true, false, false, false, false],
            Op::ViewOps => [true, false, false, false, false],
            Op::RunOps => [true, false, false, false, false],
            Op::AdminTokens => [true, false, false, false, false],
            Op::ViewAudit => [true, false, false, false, false],
            Op::ManageUsers => [true, false, false, false, false],
            Op::ChangeOwnPassword => [true, true, true, true, true],
        }
    }

    #[test]
    fn role_matrix_covers_every_operation() {
        let mut seen = [false; 23];
        assert_eq!(ALL_OPS.len(), 23);
        for op in ALL_OPS {
            seen[op as usize] = true;
            assert_eq!(columns(op), expected(op), "{op:?}");
        }
        assert_eq!(seen, [true; 23]);
        assert!(!permits(actor(false, false, true, false), Op::Share));
    }

    #[test]
    fn tenant_download_and_share_bits_keep_their_meaning() {
        let no_download = actor(false, false, false, true);
        let download_only = actor(false, true, false, true);
        let share_without_download = actor(false, false, true, true);
        assert!(!permits(no_download, Op::ReadObjects));
        assert!(!permits(no_download, Op::Share));
        assert!(permits(download_only, Op::ReadObjects));
        assert!(!permits(download_only, Op::Share));
        assert!(!permits(share_without_download, Op::ReadObjects));
        assert!(!permits(share_without_download, Op::Share));
        for tenant in [no_download, download_only, share_without_download] {
            assert!(permits(tenant, Op::ViewBuckets));
            assert!(permits(tenant, Op::ViewObjects));
            assert!(permits(tenant, Op::WriteObjects));
            assert!(permits(tenant, Op::ChangeOwnPassword));
            assert!(!permits(tenant, Op::CleanupUploads));
        }
    }

    #[test]
    fn share_ttl_caps_at_seven_days() {
        assert_eq!(cap_share_ttl(60 * 60), 60 * 60);
        assert_eq!(cap_share_ttl(24 * 60 * 60), 24 * 60 * 60);
        assert_eq!(cap_share_ttl(SHARE_TTL_MAX_SECS), SHARE_TTL_MAX_SECS);
        assert_eq!(cap_share_ttl(SHARE_TTL_MAX_SECS + 1), SHARE_TTL_MAX_SECS);
        assert_eq!(cap_share_ttl(30 * 24 * 60 * 60), SHARE_TTL_MAX_SECS);
    }
}
