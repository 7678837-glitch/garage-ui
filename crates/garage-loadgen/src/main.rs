use std::path::PathBuf;

use clap::Parser;

use garage_loadgen::{Plan, Remaining, execute};

#[derive(Parser)]
#[command(name = "garage-loadgen")]
struct Cli {
    #[arg(long, default_value_t = 0)]
    buckets: u64,
    #[arg(long, default_value_t = 0)]
    keys: u64,
    #[arg(long, default_value_t = 0)]
    objects: u64,
    #[arg(long, default_value_t = 1)]
    prefix_depth: u32,
    #[arg(long, default_value = "checkpoint.json")]
    resume: PathBuf,
    /// 只打印剩余数量，不写断点，也不访问 Garage。
    #[arg(long)]
    dry_run: bool,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let plan = Plan {
        buckets: cli.buckets,
        keys: cli.keys,
        objects: cli.objects,
        prefix_depth: cli.prefix_depth,
    };
    let left = execute(&plan, &cli.resume, cli.dry_run)?;
    print_remaining(&left);
    Ok(())
}

fn print_remaining(left: &Remaining) {
    println!("buckets_remaining={}", left.buckets);
    println!("keys_remaining={}", left.keys);
    println!("objects_remaining={}", left.objects);
}
