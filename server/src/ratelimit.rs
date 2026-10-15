//! Fixed-window rate limiter for the HTTP surface.
//!
//! The paid `x402` endpoint performs two upstream RPC reads per request, so an unauthenticated caller
//! can make the service spend its own RPC quota. The limiter is deliberately simple: per-client
//! fixed windows held in memory, with a bounded map so a caller cannot grow it without limit.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    window: Duration,
    max_per_window: u32,
    /// Hard ceiling on tracked clients: beyond this, the oldest entry is evicted.
    max_clients: usize,
    clients: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(max_per_window: u32, window: Duration) -> Self {
        Self {
            window,
            max_per_window,
            max_clients: 4_096,
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `true` when the request is allowed.
    pub fn allow(&self, client: IpAddr) -> bool {
        let now = Instant::now();
        let mut clients = match self.clients.lock() {
            Ok(guard) => guard,
            // A poisoned limiter must not block the product surface; fail open on the counter and
            // record nothing so the next cycle recovers.
            Err(poisoned) => poisoned.into_inner(),
        };

        if clients.len() > self.max_clients {
            clients.clear();
        }

        match clients.get_mut(&client) {
            Some((started, count)) if now.duration_since(*started) < self.window => {
                if *count >= self.max_per_window {
                    return false;
                }
                *count += 1;
                true
            }
            entry => {
                if let Some(slot) = entry {
                    *slot = (now, 1);
                } else {
                    clients.insert(client, (now, 1));
                }
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_the_window_budget_is_spent() {
        let limiter = RateLimiter::new(3, Duration::from_secs(60));
        let client: IpAddr = "203.0.113.7".parse().unwrap();
        assert!(limiter.allow(client));
        assert!(limiter.allow(client));
        assert!(limiter.allow(client));
        assert!(!limiter.allow(client), "fourth request in the window is refused");

        let other: IpAddr = "198.51.100.9".parse().unwrap();
        assert!(limiter.allow(other), "other clients keep their own budget");
    }

    #[test]
    fn a_new_window_restores_the_budget() {
        let limiter = RateLimiter::new(1, Duration::from_millis(1));
        let client: IpAddr = "203.0.113.8".parse().unwrap();
        assert!(limiter.allow(client));
        assert!(!limiter.allow(client));
        std::thread::sleep(Duration::from_millis(5));
        assert!(limiter.allow(client));
    }
}
