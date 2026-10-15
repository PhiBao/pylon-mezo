//! Pylon server: CLI + HTTP service.
//!
//!   pylon serve                     run the API, keeper and radar refresher
//!   pylon radar [--limit N]         print the live redemption queue from Mezo
//!   pylon loop-quote --coll-add W   quote a flash loop
//!   pylon unwind-quote --repay W    quote a zero-MUSD unwind
//!   pylon exit-quote --address A    quote a full flash exit
//!   pylon prove --phase N           execute a real on-chain proof phase
//!   pylon keep                      run only the keeper in the foreground
//!   pylon approvals --owner A       print every approval an owner has granted

mod abi;
mod api;
mod config;
mod eip712;
mod keeper;
mod mezo;
mod ops;
mod radar;
mod rpc;
mod solver;
mod store;

use std::sync::Arc;

use alloy_primitives::{Address, U256};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "pylon", about = "Pylon execution engine for Mezo")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Port for `serve`
    #[arg(long, env = "PORT", default_value_t = 8787)]
    port: u16,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP API plus the keeper and radar refresher.
    Serve,
    /// Print the live SortedTroves redemption queue.
    Radar {
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    /// Quote a flash loop.
    LoopQuote {
        #[arg(long)]
        coll_add: String,
        #[arg(long)]
        owner: Option<String>,
    },
    /// Quote a zero-MUSD flash unwind.
    UnwindQuote {
        #[arg(long)]
        repay: String,
        #[arg(long)]
        address: Option<String>,
    },
    /// Quote a full flash exit.
    ExitQuote {
        #[arg(long)]
        address: String,
    },
    /// Execute a real proof phase on Mezo (operator key required).
    Prove {
        #[arg(long)]
        phase: u64,
        /// Dry-run: execute as an `eth_call` against live state instead of broadcasting.
        #[arg(long, env = "SIMULATE", default_value_t = false)]
        simulate: bool,
    },
    /// Run the redemption-shield keeper in the foreground.
    Keep,
    /// Print reserve, market and wiring state.
    Status,
    /// Debug helper: print the close-trove ballot (nonce, digest, signature, recovered signer).
    DebugClose,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env when present so operators do not have to export every variable.
    if let Ok(raw) = std::fs::read_to_string(".env") {
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                if std::env::var(k).is_err() {
                    std::env::set_var(k.trim(), v.trim().trim_matches('"'));
                }
            }
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,pylon=debug")),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();
    let config = Arc::new(config::Config::load().context("loading configuration")?);
    let mezo = Arc::new(mezo::Mezo::new(
        rpc::Rpc::new(config.rpc_url.clone()),
        config.chain_id,
        mezo::ContractSet::from(&config.deployment),
    ));
    let radar = Arc::new(radar::Radar::new(60));
    let store = Arc::new(store::Store::open(config.data_dir.clone()));

    let state = api::AppState {
        config: config.clone(),
        mezo: mezo.clone(),
        radar: radar.clone(),
        store: store.clone(),
    };

    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => {
            // warm the radar so the first request is not slow, and keep it warm in the background
            let warm = state.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(std::time::Duration::from_secs(25));
                loop {
                    ticker.tick().await;
                    if let Err(e) = warm.radar.refresh(&warm.mezo).await {
                        tracing::warn!(error = %e, "radar refresh failed");
                    }
                }
            });
            let keeper_state = state.clone();
            tokio::spawn(async move {
                if let Err(e) = keeper::run(keeper_state).await {
                    tracing::error!(error = %e, "keeper stopped");
                }
            });

            let app = api::router(state);
            let listener = tokio::net::TcpListener::bind(("0.0.0.0", cli.port))
                .await
                .with_context(|| format!("binding port {}", cli.port))?;
            tracing::info!(port = cli.port, chain = config.chain_id, rpc = %config.rpc_url, "pylon api listening");
            axum::serve(listener, app).await?;
        }
        Command::Radar { limit } => {
            let radar = state.radar.current(&state.mezo).await?;
            println!(
                "troves={} tcr={} btc={} queue_depth={} MUSD",
                radar.entries.len(),
                mezo::format_units(radar.tcr, 18, 4),
                mezo::format_units(radar.price, 18, 2),
                mezo::format_units(
                    U256::from_str_radix(
                        radar.entries.last().map(|e| e.redemption_buffer_musd.as_str()).unwrap_or("0"),
                        10
                    )
                    .unwrap_or(U256::ZERO),
                    18,
                    0
                ),
            );
            println!("{:<5} {:<44} {:>12} {:>14} {:>9} {:>16}", "rank", "trove", "coll BTC", "debt MUSD", "ICR", "buffer MUSD");
            for entry in radar.tail(limit) {
                println!(
                    "{:<5} {:<44} {:>12} {:>14} {:>9} {:>16}",
                    entry.rank,
                    format!("{:#x}", entry.address),
                    mezo::format_units(U256::from_str_radix(&entry.coll, 10).unwrap_or(U256::ZERO), 18, 6),
                    mezo::format_units(U256::from_str_radix(&entry.debt, 10).unwrap_or(U256::ZERO), 18, 0),
                    mezo::format_units(U256::from_str_radix(&entry.icr_wad, 10).unwrap_or(U256::ZERO), 18, 2),
                    mezo::format_units(U256::from_str_radix(&entry.redemption_buffer_musd, 10).unwrap_or(U256::ZERO), 18, 0),
                );
            }
        }
        Command::LoopQuote { coll_add, owner } => {
            let coll_add = parse_u256(&coll_add)?;
            let owner = owner.map(|o| o.parse::<Address>()).transpose()?;
            let solver = solver::Solver::new(&state.mezo, &state.radar);
            let quote = solver.loop_quote(coll_add, owner).await?;
            println!("{}", serde_json::to_string_pretty(&quote)?);
        }
        Command::UnwindQuote { repay, address } => {
            let repay = parse_u256(&repay)?;
            let owner = address.map(|o| o.parse::<Address>()).transpose()?;
            let solver = solver::Solver::new(&state.mezo, &state.radar);
            let quote = solver.unwind_quote(repay, owner).await?;
            println!("{}", serde_json::to_string_pretty(&quote)?);
        }
        Command::ExitQuote { address } => {
            let owner: Address = address.parse()?;
            let solver = solver::Solver::new(&state.mezo, &state.radar);
            let quote = solver.exit_quote(owner).await?;
            println!("{}", serde_json::to_string_pretty(&quote)?);
        }
        Command::Prove { phase, simulate } => {
            if simulate {
                std::env::set_var("SIMULATE", "1");
            }
            ops::run_phase(phase, &state).await?;
        }
        Command::Keep => {
            keeper::run(state).await?;
        }
        Command::DebugClose => {
            let owner = state
                .config
                .operator_address()
                .context("operator address")?;
            let key = state.config.operator_key.clone().context("PRIVATE_KEY")?;
            let nonce = state.mezo.signature_nonce(owner).await?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let deadline = U256::from(now + 1800);
            let digest = eip712::close_trove_digest(
                state.config.chain_id,
                state.mezo.c.borrower_ops_signatures,
                owner,
                owner,
                nonce,
                deadline,
            );
            let signature = state
                .mezo
                .sign_close(&key, owner, owner, nonce, deadline)?;
            let signing = eip712::signing_key(&key)?;
            let recovered = eip712::recover_signer(digest, &signature)?;
            println!("owner      {owner:#x}");
            println!("chainId    {}", state.config.chain_id);
            println!("verifying  {:#x}", state.mezo.c.borrower_ops_signatures);
            println!("nonce      {nonce}");
            println!("deadline   {deadline}");
            println!("digest     {digest:#x}");
            println!("signature  0x{}", hex::encode(&signature));
            println!("expect     {:#x}", eip712::address_from_key_bytes(&signing));
            println!("recovered  {recovered:#x}");
        }
        Command::Status => {
            let (market, reserve) = tokio::join!(state.mezo.market(), state.mezo.reserve_state());
            println!("market: {}", serde_json::to_string_pretty(&market?)?);
            println!("reserve: {}", serde_json::to_string_pretty(&reserve?)?);
        }
    }

    Ok(())
}

fn parse_u256(value: &str) -> Result<U256> {
    let v = value.trim();
    if let Some(hex) = v.strip_prefix("0x") {
        Ok(U256::from_str_radix(hex, 16)?)
    } else if v.contains('.') {
        // accept decimal units like 0.005
        let (whole, frac) = v.split_once('.').context("bad decimal")?;
        let mut frac = frac.to_string();
        while frac.len() < 18 {
            frac.push('0');
        }
        let whole: U256 = whole.parse()?;
        let frac: U256 = frac[..18].parse()?;
        Ok(whole * U256::from(10u64).pow(U256::from(18u64)) + frac)
    } else {
        Ok(U256::from_str_radix(v, 10)?)
    }
}
