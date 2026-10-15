//! EIP-712 authorisation for Mezo's `BorrowerOperationsSignatures`, plus EIP-155 (legacy)
//! transaction signing.
//!
//! The digest construction mirrors the contract exactly:
//!   structHash = keccak256(abi.encode(typeHash, fields..., nonce, deadline))
//!   digest     = keccak256(0x1901 ‖ domainSeparator ‖ structHash)

use alloy_primitives::{keccak256, Address, B256, U256};
use anyhow::{anyhow, Context, Result};
use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use serde::Serialize;

use crate::abi::{self, Val};

pub const ADJUST_TROVE_TYPE: &str = "AdjustTrove(uint256 collWithdrawal,uint256 debtChange,bool isDebtIncrease,uint256 assetAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)";
pub const OPEN_TROVE_TYPE: &str =
    "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)";
pub const CLOSE_TROVE_TYPE: &str =
    "CloseTrove(address borrower,address recipient,uint256 nonce,uint256 deadline)";
pub const REPAY_MUSD_TYPE: &str =
    "RepayMUSD(uint256 amount,address borrower,uint256 nonce,uint256 deadline)";

pub fn signing_key(private_key: &str) -> Result<SigningKey> {
    let bytes = hex::decode(private_key.trim_start_matches("0x")).context("private key hex")?;
    SigningKey::from_slice(&bytes).map_err(|e| anyhow!("invalid private key: {e}"))
}

pub fn address_from_key(private_key: &str) -> Result<Address> {
    let key = signing_key(private_key)?;
    let verifying = key.verifying_key();
    let encoded = verifying.to_encoded_point(false);
    let hash = keccak256(&encoded.as_bytes()[1..]);
    Ok(Address::from_slice(&hash[12..]))
}

/// Signs a 32-byte digest, returning a 65-byte `r ‖ s ‖ v` signature with `v ∈ {27, 28}`.
pub fn sign_digest(key: &SigningKey, digest: B256) -> Result<Vec<u8>> {
    let (signature, recid) = key
        .sign_prehash_recoverable(digest.as_slice())
        .map_err(|e| anyhow!("signing failed: {e}"))?;
    Ok(pack_signature(&signature, recid, 27))
}

fn pack_signature(signature: &Signature, recid: RecoveryId, base: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(65);
    out.extend_from_slice(&signature.r().to_bytes());
    out.extend_from_slice(&signature.s().to_bytes());
    out.push(base + recid.to_byte());
    out
}

pub fn address_from_key_bytes(key: &SigningKey) -> Address {
    let encoded = key.verifying_key().to_encoded_point(false);
    let hash = keccak256(&encoded.as_bytes()[1..]);
    Address::from_slice(&hash[12..])
}

/// Recovers the signer of a 65-byte `r ‖ s ‖ v` signature over `digest`.
pub fn recover_signer(digest: B256, signature: &[u8]) -> Result<Address> {
    if signature.len() != 65 {
        anyhow::bail!("signature must be 65 bytes, got {}", signature.len());
    }
    let sig = Signature::from_slice(&signature[..64]).map_err(|e| anyhow!("bad r/s: {e}"))?;
    let recid = match signature[64] {
        27 | 28 => RecoveryId::from_byte(signature[64] - 27).ok_or_else(|| anyhow!("bad v"))?,
        0 | 1 => RecoveryId::from_byte(signature[64]).ok_or_else(|| anyhow!("bad v"))?,
        other => anyhow::bail!("unexpected v: {other}"),
    };
    let key = k256::ecdsa::VerifyingKey::recover_from_prehash(digest.as_slice(), &sig, recid)
        .map_err(|e| anyhow!("recovery failed: {e}"))?;
    let encoded = key.to_encoded_point(false);
    let hash = keccak256(&encoded.as_bytes()[1..]);
    Ok(Address::from_slice(&hash[12..]))
}

pub fn domain_separator(chain_id: u64, verifying_contract: Address) -> B256 {
    keccak256(abi::encode(&[
        Val::u256(U256::from_be_bytes(keccak256(
            b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        )
        .0)),
        Val::u256(U256::from_be_bytes(keccak256(b"BorrowerOperationsSignatures").0)),
        Val::u256(U256::from_be_bytes(keccak256(b"1").0)),
        Val::u64(chain_id),
        Val::addr(verifying_contract),
    ]))
}

pub fn hash_typed_data(domain: B256, struct_hash: B256) -> B256 {
    let mut buf = Vec::with_capacity(66);
    buf.extend_from_slice(&[0x19, 0x01]);
    buf.extend_from_slice(domain.as_slice());
    buf.extend_from_slice(struct_hash.as_slice());
    keccak256(buf)
}

pub fn adjust_trove_digest(
    chain_id: u64,
    verifying_contract: Address,
    coll_withdrawal: U256,
    debt_change: U256,
    is_debt_increase: bool,
    asset_amount: U256,
    borrower: Address,
    recipient: Address,
    nonce: U256,
    deadline: U256,
) -> B256 {
    let type_hash = keccak256(ADJUST_TROVE_TYPE.as_bytes());
    let struct_hash = keccak256(abi::encode(&[
        Val::u256(U256::from_be_bytes(type_hash.0)),
        Val::u256(coll_withdrawal),
        Val::u256(debt_change),
        Val::bool(is_debt_increase),
        Val::u256(asset_amount),
        Val::addr(borrower),
        Val::addr(recipient),
        Val::u256(nonce),
        Val::u256(deadline),
    ]));
    hash_typed_data(domain_separator(chain_id, verifying_contract), struct_hash)
}

#[allow(clippy::too_many_arguments)]
pub fn close_trove_digest(
    chain_id: u64,
    verifying_contract: Address,
    borrower: Address,
    recipient: Address,
    nonce: U256,
    deadline: U256,
) -> B256 {
    let type_hash = keccak256(CLOSE_TROVE_TYPE.as_bytes());
    let struct_hash = keccak256(abi::encode(&[
        Val::u256(U256::from_be_bytes(type_hash.0)),
        Val::addr(borrower),
        Val::addr(recipient),
        Val::u256(nonce),
        Val::u256(deadline),
    ]));
    hash_typed_data(domain_separator(chain_id, verifying_contract), struct_hash)
}

pub fn open_trove_digest(
    chain_id: u64,
    verifying_contract: Address,
    asset_amount: U256,
    debt_amount: U256,
    borrower: Address,
    recipient: Address,
    nonce: U256,
    deadline: U256,
) -> B256 {
    let type_hash = keccak256(OPEN_TROVE_TYPE.as_bytes());
    let struct_hash = keccak256(abi::encode(&[
        Val::u256(U256::from_be_bytes(type_hash.0)),
        Val::u256(asset_amount),
        Val::u256(debt_amount),
        Val::addr(borrower),
        Val::addr(recipient),
        Val::u256(nonce),
        Val::u256(deadline),
    ]));
    hash_typed_data(domain_separator(chain_id, verifying_contract), struct_hash)
}

// ---------------------------------------------------------------------------
// Wallet-facing typed data (what the browser signs with `signTypedData`)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct TypedData {
    pub domain: TypedDataDomain,
    pub types: serde_json::Value,
    #[serde(rename = "primaryType")]
    pub primary_type: String,
    pub message: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct TypedDataDomain {
    pub name: String,
    pub version: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    #[serde(rename = "verifyingContract")]
    pub verifying_contract: String,
}

fn field(name: &str, ty: &str) -> serde_json::Value {
    serde_json::json!({"name": name, "type": ty})
}

pub fn adjust_trove_typed_data(
    chain_id: u64,
    verifying_contract: Address,
    coll_withdrawal: U256,
    debt_change: U256,
    is_debt_increase: bool,
    asset_amount: U256,
    borrower: Address,
    recipient: Address,
    nonce: U256,
    deadline: U256,
) -> TypedData {
    TypedData {
        domain: TypedDataDomain {
            name: "BorrowerOperationsSignatures".into(),
            version: "1".into(),
            chain_id,
            verifying_contract: format!("{verifying_contract:#x}"),
        },
        types: serde_json::json!({
            "EIP712Domain": [
                field("name", "string"),
                field("version", "string"),
                field("chainId", "uint256"),
                field("verifyingContract", "address"),
            ],
            "AdjustTrove": [
                field("collWithdrawal", "uint256"),
                field("debtChange", "uint256"),
                field("isDebtIncrease", "bool"),
                field("assetAmount", "uint256"),
                field("borrower", "address"),
                field("recipient", "address"),
                field("nonce", "uint256"),
                field("deadline", "uint256"),
            ],
        }),
        primary_type: "AdjustTrove".into(),
        message: serde_json::json!({
            "collWithdrawal": coll_withdrawal.to_string(),
            "debtChange": debt_change.to_string(),
            "isDebtIncrease": is_debt_increase,
            "assetAmount": asset_amount.to_string(),
            "borrower": format!("{borrower:#x}"),
            "recipient": format!("{recipient:#x}"),
            "nonce": nonce.to_string(),
            "deadline": deadline.to_string(),
        }),
    }
}

// ---------------------------------------------------------------------------
// EIP-155 legacy transaction signing
// ---------------------------------------------------------------------------

pub fn rlp_encode(item: &[u8]) -> Vec<u8> {
    if item.len() == 1 && item[0] < 0x80 {
        return item.to_vec();
    }
    if item.len() < 56 {
        let mut out = vec![0x80 + item.len() as u8];
        out.extend_from_slice(item);
        out
    } else {
        let len = item.len();
        let len_bytes = len.to_be_bytes();
        let first = len_bytes.iter().position(|b| *b != 0).unwrap_or(len_bytes.len() - 1);
        let trimmed = &len_bytes[first..];
        let mut out = vec![0xb7 + trimmed.len() as u8];
        out.extend_from_slice(trimmed);
        out.extend_from_slice(item);
        out
    }
}

pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.iter().flat_map(|i| rlp_encode(i)).collect();
    let mut out = if payload.len() < 56 {
        vec![0xc0 + payload.len() as u8]
    } else {
        let len = payload.len();
        let len_bytes = len.to_be_bytes();
        let first = len_bytes.iter().position(|b| *b != 0).unwrap_or(len_bytes.len() - 1);
        let trimmed = &len_bytes[first..];
        let mut header = vec![0xf7 + trimmed.len() as u8];
        header.extend_from_slice(trimmed);
        header
    };
    out.extend_from_slice(&payload);
    out
}

/// Minimal big-endian encoding for RLP: zero must encode as the empty byte string, never 0x00.
fn u256_bytes(v: U256) -> Vec<u8> {
    minimal_bytes(&v.to_be_bytes::<32>())
}

/// RLP integers must be minimally encoded. A signature whose `r` or `s` happens to start with a
/// zero byte (roughly 1 in 128 signatures) is rejected by strict nodes such as mezod with
/// "non-canonical integer (leading zero bytes)", so the leading zeros are stripped here.
fn minimal_bytes(bytes: &[u8]) -> Vec<u8> {
    match bytes.iter().position(|b| *b != 0) {
        Some(first) => bytes[first..].to_vec(),
        None => Vec::new(),
    }
}

pub struct LegacyTx {
    pub chain_id: u64,
    pub nonce: u64,
    pub gas_price: U256,
    pub gas_limit: u64,
    pub to: Address,
    pub value: U256,
    pub data: Vec<u8>,
}

/// Produces the raw RLP-encoded, signed legacy transaction bytes.
pub fn sign_legacy_tx(tx: &LegacyTx, key: &SigningKey) -> Result<Vec<u8>> {
    let unsigned = rlp_list(&[
        u256_bytes(U256::from(tx.nonce)),
        u256_bytes(tx.gas_price),
        u256_bytes(U256::from(tx.gas_limit)),
        tx.to.as_slice().to_vec(),
        u256_bytes(tx.value),
        tx.data.clone(),
        u256_bytes(U256::from(tx.chain_id)),
        Vec::new(),
        Vec::new(),
    ]);
    let digest = keccak256(&unsigned);
    let (signature, recid) = key
        .sign_prehash_recoverable(digest.as_slice())
        .map_err(|e| anyhow!("tx signing failed: {e}"))?;

    let v = U256::from(tx.chain_id) * U256::from(2) + U256::from(35 + recid.to_byte() as u64);
    let signed = rlp_list(&[
        u256_bytes(U256::from(tx.nonce)),
        u256_bytes(tx.gas_price),
        u256_bytes(U256::from(tx.gas_limit)),
        tx.to.as_slice().to_vec(),
        u256_bytes(tx.value),
        tx.data.clone(),
        u256_bytes(v),
        minimal_bytes(&signature.r().to_bytes()),
        minimal_bytes(&signature.s().to_bytes()),
    ]);
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-checked against an independent implementation (`cast keccak` / `cast abi-encode`):
    ///   digest = keccak(0x1901 || domainSeparator || structHash)
    /// Getting this wrong is invisible until a live transaction reverts with "Invalid signature".
    #[test]
    fn close_trove_digest_matches_reference_implementation() {
        let owner: Address = "0x3bEe06fA351E66e298eF4DDcbE6052770775a93e".parse().unwrap();
        let verifying: Address = "0xD757e3646AF370b15f32EB557F0F8380Df7D639e".parse().unwrap();
        let digest = close_trove_digest(
            31611,
            verifying,
            owner,
            owner,
            U256::from(2u64),
            U256::from(1_792_090_301u64),
        );
        assert_eq!(
            format!("{digest:#x}"),
            "0xd57a813d9aa83432684ff89347d9433daff5a45192466d22d899a1cfa8eff180"
        );
    }

    /// The signature produced by `sign_digest` must recover to the signing key.
    #[test]
    fn signatures_recover_to_the_signer() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let owner = {
            let encoded = key.verifying_key().to_encoded_point(false);
            let hash = alloy_primitives::keccak256(&encoded.as_bytes()[1..]);
            Address::from_slice(&hash[12..])
        };
        let digest = close_trove_digest(
            31611,
            "0xD757e3646AF370b15f32EB557F0F8380Df7D639e".parse().unwrap(),
            owner,
            owner,
            U256::from(9u64),
            U256::from(1_792_090_301u64),
        );
        let signature = sign_digest(&key, digest).unwrap();
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
            digest.as_slice(),
            &k256::ecdsa::Signature::from_slice(&signature[..64]).unwrap(),
            k256::ecdsa::RecoveryId::from_byte(signature[64] - 27).unwrap(),
        )
        .unwrap();
        assert_eq!(recovered, *key.verifying_key());
    }
}
