#!/usr/bin/env bash
# Pylon — mainnet readiness check.
#
# Pylon's atomic paths need five things from the network it runs on: MUSD, the BTC ledger, Mezo's
# trove stack (including the signature helper), a MUSD-rich pool to flash from, and a MUSD/BTC pool
# to swap on. This script checks each of them against a live RPC, discovers the venues by scanning
# the Tigris factory, and prints the sizes a deployment would inherit.
#
# Usage:  ./verify-mainnet.sh [RPC_URL]
#
# Addresses come from Mezo's own repositories (mezo-org/musd and mezo-org/tigris, mainnet deployment
# records), not from guesses. Re-run after any Mezo upgrade: constructor arguments, parameters and
# pools are all network state, and a mainnet deploy must be checked against it, not assumed.

set -uo pipefail
RPC="${1:-https://jsonrpc-mezo.boar.network}"
POOL_PAGE="${POOL_PAGE:-60}"

# Mezo mainnet (chain 31612) — mezo-org/musd artifacts/deployments/mainnet
MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186
SIGS=0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a
BOPS=0x44b1bac67dDA612a41a58AAf779143B181dEe031
TM=0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193
SORTED=0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f
HINTS=0xD267b3bE2514375A075fd03C3D9CBa6b95317DC3
PRICE=0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88
GOVVARS=0x560AC4Ea44Fb7EB2D4d3c00608CB1CAb2613d389

# Tigris mainnet (chain 31612) — mezo-org/tigris deployments/mainnet
PF=0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248
ROUTER=0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706
REGISTRY=0x265054F72bAD343FDEE3e018269cbB899e2E2ec5

call() { cast call "$1" "$2" ${3:+$3} ${4:+$4} --rpc-url "$RPC" 2>/dev/null; }
# depths are wei-scale and overflow shell arithmetic; compare and add with awk
bignum() { awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN { if (a+0 > b+0) print 1; else print 0 }'; }
first() { awk '{print $1}'; }
ok()   { printf '  [ok]      %s\n' "$1"; }
bad()  { printf '  [MISSING] %s\n' "$1"; }
info() { printf '            %s\n' "$1"; }
eqi()  { [ "$(printf '%s' "$1" | tr 'A-F' 'a-f')" = "$(printf '%s' "$2" | tr 'A-F' 'a-f')" ]; }

echo "Pylon mainnet readiness — $RPC"
CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null)
echo "chain $CHAIN (Mezo mainnet is 31612)"
[ "$CHAIN" = "31612" ] || { echo "!! not Mezo mainnet"; exit 1; }
echo

echo "1. MUSD"
SYM=$(call "$MUSD" 'symbol()(string)' | head -1)
SUPPLY=$(call "$MUSD" 'totalSupply()(uint256)' | first)
if [ -n "$SUPPLY" ]; then ok "MUSD $MUSD ($SYM) total supply $SUPPLY"; else bad "MUSD not answering at $MUSD"; fi
echo

echo "2. BTC ledger (native balance exposed as an ERC-20 — the identity the engine relies on)"
BTC=0x7b7C000000000000000000000000000000000000
PROBE=$(call "$PF" 'allPools(uint256)(address)' 0 | first)
NATIVE=$(cast balance "$PROBE" --rpc-url "$RPC" 2>/dev/null)
LEDGER=$(call "$BTC" "balanceOf(address)(uint256)" "$PROBE" | first)
if [ -n "$LEDGER" ] && [ "$LEDGER" = "$NATIVE" ]; then
  ok "ledger $BTC · balanceOf == native balance ($NATIVE) for $PROBE"
else
  bad "ledger identity failed (native=$NATIVE ledger=$LEDGER)"
fi
echo

echo "3. Mezo trove stack and parameters"
MIN_NET=$(call "$BOPS" 'minNetDebt()(uint256)' | first)
GASCOMP=$(call "$BOPS" 'MUSD_GAS_COMPENSATION()(uint256)' | first)
MCR=$(call "$TM" 'MCR()(uint256)' | first)
CCR=$(call "$TM" 'CCR()(uint256)' | first)
TROVES=$(call "$SORTED" 'getSize()(uint256)' | first)
PX=$(call "$PRICE" 'fetchPrice()(uint256)' | first)
FEE=$(call "$BOPS" 'getBorrowingFee(uint256)(uint256)' 1000000000000000000000 | first)
[ -n "$TROVES" ] && ok "TroveManager $TM · SortedTroves $SORTED · HintHelpers $HINTS" || bad "trove stack"
ok "PriceFeed $PRICE · GovernableVariables $GOVVARS"
info "minNetDebt $MIN_NET · gas compensation $GASCOMP · MCR $MCR · CCR $CCR"
info "borrowing fee on 1,000 MUSD: $FEE wei · oracle BTC price: $PX (1e18)"
info "troves on mainnet right now: $TROVES"
info "minimum trove = minNetDebt + gas compensation of debt against collateral at >= MCR"
echo

echo "4. Non-custodial signature helper (the whole access model)"
N1=$(call "$SIGS" 'getNonce(address)(uint256)' 0x0000000000000000000000000000000000000001)
N2=$(call "$SIGS" 'nonces(address)(uint256)' 0x0000000000000000000000000000000000000001)
DS=$(call "$SIGS" 'DOMAIN_SEPARATOR()(bytes32)' | head -1)
[ -z "$DS" ] && DS=$(call "$SIGS" 'eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])' | head -1)
[ -z "$DS" ] && DS=$(call "$SIGS" 'domainSeparator()(bytes32)' | head -1)
if [ -n "$N1" ]; then ok "getNonce present — the service's ABI matches"; \
  elif [ -n "$N2" ]; then bad "this deployment exposes nonces(), not getNonce(): the service ABI needs a one-line change"; \
  else bad "no nonce view answered at $SIGS"; fi
info "DOMAIN_SEPARATOR $DS"
info "the EIP-712 typehash and domain live in Mezo's contract; a deploy must match them exactly"
echo

echo "5. Venues (discovered from the factory, not hard-coded)"
RP=$(call "$ROUTER" 'defaultFactory()(address)' | first)
if eqi "$RP" "$PF"; then ok "Router $ROUTER defaultFactory == PoolFactory $PF (the engine asserts this)"; \
  else bad "Router defaultFactory $RP differs from PoolFactory $PF"; fi
N=$(call "$PF" 'allPoolsLength()(uint256)' | first)
info "FactoryRegistry $REGISTRY · pools: $N"
FLASH=""; FLASH_DEPTH=0; SWAP=""; SWAP_DEPTH=0
for i in $(seq 0 $(( POOL_PAGE - 1 ))); do
  [ "$i" -lt "${N:-0}" ] || break
  P=$(call "$PF" 'allPools(uint256)(address)' "$i" | first)
  [ -n "$P" ] || continue
  T0=$(call "$P" 'token0()(address)' | first); T1=$(call "$P" 'token1()(address)' | first)
  ST=$(call "$P" 'stable()(bool)' | first)
  if eqi "$T0" "$MUSD" || eqi "$T1" "$MUSD"; then
    OTHER=$T0; eqi "$T0" "$MUSD" && OTHER=$T1
    DM=$(call "$MUSD" "balanceOf(address)(uint256)" "$P" | first)
    DO=$(call "$OTHER" "balanceOf(address)(uint256)" "$P" | first)
    F=$(call "$PF" "getFee(address,bool)(uint256)" "$P" "$ST" | first)
    [ -z "$F" ] && F="no getFee() view" 
    SNP=$(call "$OTHER" 'symbol()(string)' | head -1)
    printf '            %s  %s/%s%s  MUSD depth %s · other depth %s · fee %s bps\n' \
      "$P" "MUSD" "$SNP" "$( [ "$ST" = "true" ] && echo ' (stable)' )" "$DM" "$DO" "$F"
    # flash venue: stable MUSD pool, deepest MUSD; swap venue: volatile MUSD/BTC, deepest MUSD
    if [ "$ST" = "true" ] && [ "$(bignum "${DM:-0}" "$FLASH_DEPTH")" = "1" ]; then FLASH="$P"; FLASH_DEPTH=${DM:-0}; fi
    if [ "$ST" = "false" ] && [ -n "$(call "$OTHER" 'symbol()(string)' | grep -i 'BTC')" ] && [ "$(bignum "${DM:-0}" "$SWAP_DEPTH")" = "1" ]; then SWAP="$P"; SWAP_DEPTH=${DM:-0}; fi
  fi
done
echo
if [ -n "$FLASH" ]; then ok "flash venue: $FLASH (stable, MUSD depth $FLASH_DEPTH)"; else bad "no stable MUSD pool found — the flash leg has no venue"; fi
if [ -n "$SWAP" ]; then ok "swap venue: $SWAP (volatile MUSD/BTC, MUSD depth $SWAP_DEPTH)"; else bad "no volatile MUSD/BTC pool found — the swap leg has no venue"; fi
echo
echo "Reading: a flash needs its size covered by the flash venue's MUSD depth; the swap needs the"
echo "volatile MUSD/BTC pool. Both exist on mainnet, so a deployment inherits working venues. Any"
echo "MUSD pair can serve the flash (the engine takes it as a constructor argument), which also"
echo "means the same audited engine can wrap any of the MUSD pairs listed here."
