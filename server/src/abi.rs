//! Minimal, dependency-light ABI codec.
//!
//! Pylon talks to a fixed set of Mezo/Tigris/Pylon functions. Rather than pulling in a full
//! contract-binding stack, this module implements exactly the standard ABI rules those calls need:
//! static words plus `bytes`, and nested tuples (used for the signature-authorised request structs).

use alloy_primitives::{keccak256, Address, U256};

#[derive(Clone, Debug)]
pub enum Val {
    U256(U256),
    U64(u64),
    Bool(bool),
    Addr(Address),
    Bytes(Vec<u8>),
    Tuple(Vec<Val>),
}

impl Val {
    pub fn u256(v: impl Into<U256>) -> Self {
        Val::U256(v.into())
    }
    pub fn u64(v: u64) -> Self {
        Val::U64(v)
    }
    pub fn bool(v: bool) -> Self {
        Val::Bool(v)
    }
    pub fn addr(v: Address) -> Self {
        Val::Addr(v)
    }
    pub fn bytes(v: Vec<u8>) -> Self {
        Val::Bytes(v)
    }
    pub fn tuple(v: Vec<Val>) -> Self {
        Val::Tuple(v)
    }
}

pub fn selector(signature: &str) -> [u8; 4] {
    let h = keccak256(signature.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

fn is_dynamic(v: &Val) -> bool {
    match v {
        Val::Bytes(_) => true,
        Val::Tuple(items) => items.iter().any(is_dynamic),
        _ => false,
    }
}

fn head_size(v: &Val) -> usize {
    match v {
        Val::Bytes(_) => 32,
        Val::Tuple(items) => items.iter().map(head_size).sum(),
        _ => 32,
    }
}

fn encode_word(v: &Val) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    match v {
        Val::U256(x) => out.extend_from_slice(&x.to_be_bytes::<32>()),
        Val::U64(x) => {
            let mut buf = [0u8; 32];
            buf[24..].copy_from_slice(&x.to_be_bytes());
            out.extend_from_slice(&buf);
        }
        Val::Bool(b) => {
            let mut buf = [0u8; 32];
            buf[31] = u8::from(*b);
            out.extend_from_slice(&buf);
        }
        Val::Addr(a) => {
            let mut buf = [0u8; 32];
            buf[12..].copy_from_slice(a.as_slice());
            out.extend_from_slice(&buf);
        }
        Val::Bytes(_) | Val::Tuple(_) => unreachable!("dynamic value in head"),
    }
    out
}

fn encode_dynamic(v: &Val) -> Vec<u8> {
    match v {
        Val::Bytes(b) => {
            let mut out = Vec::with_capacity(64 + b.len());
            out.extend_from_slice(&U256::from(b.len()).to_be_bytes::<32>());
            let mut padded = b.clone();
            let rem = padded.len() % 32;
            if rem != 0 {
                padded.extend(std::iter::repeat_n(0u8, 32 - rem));
            }
            out.extend_from_slice(&padded);
            out
        }
        Val::Tuple(items) => encode(items),
        _ => unreachable!("static value in tail"),
    }
}

/// Standard ABI encoding of a parameter list (head/tail).
///
/// Offsets for dynamic values are relative to the start of the whole encoding — including the head
/// slots of *every* parameter — which is why the head length is computed before the walk.
pub fn encode(vals: &[Val]) -> Vec<u8> {
    let head_len: usize = vals
        .iter()
        .map(|v| if is_dynamic(v) { 32 } else { head_size(v) })
        .sum();

    let mut head = Vec::new();
    let mut tail = Vec::new();
    for v in vals {
        if is_dynamic(v) {
            let offset = head_len + tail.len();
            head.extend_from_slice(&U256::from(offset).to_be_bytes::<32>());
            tail.extend_from_slice(&encode_dynamic(v));
        } else {
            head.extend_from_slice(&encode_word(v));
        }
    }
    let mut out = head;
    out.extend_from_slice(&tail);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The encoder must reproduce exactly what `cast calldata` produces for the shapes Pylon uses:
    /// a dynamic struct (used by every flash entrypoint) and plain static arguments.
    #[test]
    fn matches_reference_encoding_for_dynamic_struct() {
        // cast calldata "loopSigned((address,uint256,uint256,address,uint256,uint256,address,address,bytes))"         //   0x1111111111111111111111111111111111111111 1000 2000 0x2222222222222222222222222222222222222222 0 1735689600         //   0x3333333333333333333333333333333333333333 0x4444444444444444444444444444444444444444 0xdeadbeef
        let expected = "0x\
8c1fe8f3\
0000000000000000000000000000000000000000000000000000000000000020\
0000000000000000000000001111111111111111111111111111111111111111\
00000000000000000000000000000000000000000000000000000000000003e8\
00000000000000000000000000000000000000000000000000000000000007d0\
0000000000000000000000002222222222222222222222222222222222222222\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000067748580\
0000000000000000000000003333333333333333333333333333333333333333\
0000000000000000000000004444444444444444444444444444444444444444\
0000000000000000000000000000000000000000000000000000000000000120\
0000000000000000000000000000000000000000000000000000000000000004\
deadbeef00000000000000000000000000000000000000000000000000000000";

        let data = calldata(
            "loopSigned((address,uint256,uint256,address,uint256,uint256,address,address,bytes))",
            &[Val::tuple(vec![
                Val::addr("0x1111111111111111111111111111111111111111".parse().unwrap()),
                Val::u256(U256::from(1000u64)),
                Val::u256(U256::from(2000u64)),
                Val::addr("0x2222222222222222222222222222222222222222".parse().unwrap()),
                Val::u256(U256::ZERO),
                Val::u256(U256::from(1_735_689_600u64)),
                Val::addr("0x3333333333333333333333333333333333333333".parse().unwrap()),
                Val::addr("0x4444444444444444444444444444444444444444".parse().unwrap()),
                Val::bytes(vec![0xde, 0xad, 0xbe, 0xef]),
            ])],
        );
        assert_eq!(format!("0x{}", hex::encode(&data)), expected);
    }

    #[test]
    fn matches_reference_encoding_for_static_args() {
        // cast calldata "adjustTrove(uint256,uint256,bool,address,address)" 7 9 true 0x1111111111111111111111111111111111111111 0x2222222222222222222222222222222222222222
        let expected = "0x\
45c842e6\
0000000000000000000000000000000000000000000000000000000000000007\
0000000000000000000000000000000000000000000000000000000000000009\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000001111111111111111111111111111111111111111\
0000000000000000000000002222222222222222222222222222222222222222";
        let data = calldata(
            "adjustTrove(uint256,uint256,bool,address,address)",
            &[
                Val::u256(U256::from(7u64)),
                Val::u256(U256::from(9u64)),
                Val::bool(true),
                Val::addr("0x1111111111111111111111111111111111111111".parse().unwrap()),
                Val::addr("0x2222222222222222222222222222222222222222".parse().unwrap()),
            ],
        );
        assert_eq!(format!("0x{}", hex::encode(&data)), expected);
    }
}

pub fn calldata(signature: &str, vals: &[Val]) -> Vec<u8> {
    let mut out = selector(signature).to_vec();
    out.extend_from_slice(&encode(vals));
    out
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/// Number of 32-byte words in a static return payload.
pub fn words(data: &[u8]) -> Vec<U256> {
    data.chunks(32).map(|c| U256::from_be_slice(c)).collect()
}

pub fn word(data: &[u8], index: usize) -> U256 {
    let start = index * 32;
    if data.len() < start + 32 {
        return U256::ZERO;
    }
    U256::from_be_slice(&data[start..start + 32])
}

pub fn word_addr(data: &[u8], index: usize) -> Address {
    let start = index * 32;
    if data.len() < start + 32 {
        return Address::ZERO;
    }
    Address::from_slice(&data[start + 12..start + 32])
}

pub fn word_bool(data: &[u8], index: usize) -> bool {
    !word(data, index).is_zero()
}

pub fn word_u16(data: &[u8], index: usize) -> u16 {
    u64::try_from(word(data, index)).unwrap_or(0) as u16
}

pub fn word_u64(data: &[u8], index: usize) -> u64 {
    u64::try_from(word(data, index)).unwrap_or(0)
}

/// Decodes a `bytes` return value located at `offset_word` (word index of the offset).
pub fn dynamic_bytes(data: &[u8], offset_word: usize) -> Vec<u8> {
    let offset = usize::try_from(word(data, offset_word)).unwrap_or(0);
    if data.len() < offset + 32 {
        return Vec::new();
    }
    let len = usize::try_from(U256::from_be_slice(&data[offset..offset + 32])).unwrap_or(0);
    let start = offset + 32;
    if data.len() < start + len {
        return Vec::new();
    }
    data[start..start + len].to_vec()
}
