#!/usr/bin/env bash
# Pylon operator helper: runs the live proof phases against Mezo Testnet.
#   usage: ./ops.sh <phase> [extra env assignments]
set -euo pipefail
cd "$(dirname "$0")"

set -a
. ./.env
set +a

RPC="${MEZO_TESTNET_RPC:-https://rpc.test.mezo.org}"
PHASE="$1"
shift || true

# The Mezo BTC oracle is a precompile; scripts take the live price from the environment.
PRICE="$(cast call 0x7b7c000000000000000000000000000000000015 \
  "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC" | sed -n 2p | sed 's/ .*//')"

echo "phase=$PHASE price=$PRICE"
env PHASE="$PHASE" PRICE="$PRICE" "$@" forge script script/Prove.s.sol:Prove \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast --skip-simulation 2>&1 \
  | grep -vE "^\s*(│|├|└|┌)" | tail -30
