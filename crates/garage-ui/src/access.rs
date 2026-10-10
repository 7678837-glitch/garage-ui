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
}

#[cfg(test)]
pub const ALL_OPS: [Op; 22] = [
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
];

#[derive(Clone, Copy, Debug)]
pub struct Actor {
    pub admin: bool,
    pub download: bool,
    pub share: bool,
}

pub fn permits(actor: Actor, op: Op) -> bool {
    if actor.admin {
        return true;
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

    fn columns(op: Op) -> [bool; 4] {
        let admin = Actor {
            admin: true,
            download: false,
            share: false,
        };
        let viewer = Actor {
            admin: false,
            download: false,
            share: false,
        };
        let download = Actor {
            admin: false,
            download: true,
            share: false,
        };
        let share = Actor {
            admin: false,
            download: true,
            share: true,
        };
        [
            permits(admin, op),
            permits(viewer, op),
            permits(download, op),
            permits(share, op),
        ]
    }

    fn expected(op: Op) -> [bool; 4] {
        match op {
            Op::ViewCluster => [true, true, true, true],
            Op::ViewStats => [true, true, true, true],
            Op::ViewMetrics => [true, true, true, true],
            Op::ChangeLayout => [true, false, false, false],
            Op::ViewBuckets => [true, true, true, true],
            Op::ChangeBuckets => [true, false, false, false],
            Op::ViewBucketKeys => [true, true, true, true],
            Op::ChangeBucketKeys => [true, false, false, false],
            Op::ViewKeys => [true, true, true, true],
            Op::ViewSecret => [true, false, false, false],
            Op::ChangeKeys => [true, false, false, false],
            Op::ViewObjects => [true, true, true, true],
            Op::ReadObjects => [true, false, true, true],
            Op::WriteObjects => [true, false, false, false],
            Op::Share => [true, false, false, true],
            Op::InspectObject => [true, false, false, false],
            Op::ViewOps => [true, false, false, false],
            Op::RunOps => [true, false, false, false],
            Op::AdminTokens => [true, false, false, false],
            Op::ViewAudit => [true, false, false, false],
            Op::ManageUsers => [true, false, false, false],
            Op::ChangeOwnPassword => [true, true, true, true],
        }
    }

    #[test]
    fn role_matrix_covers_every_operation() {
        let mut seen = [false; 22];
        assert_eq!(ALL_OPS.len(), 22);
        for op in ALL_OPS {
            seen[op as usize] = true;
            assert_eq!(columns(op), expected(op), "{op:?}");
        }
        assert_eq!(seen, [true; 22]);
        assert!(!permits(
            Actor {
                admin: false,
                download: false,
                share: true,
            },
            Op::Share
        ));
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
