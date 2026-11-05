#!/usr/bin/env bash
# Drives the five faucet-funded test wallets through the real Pylon flow on the hardened (v6)
# generation: create a position, open a trove, arm the shield, and run one flash loop.
#
#   ./script/run-users.sh            # run
#   CHECK_ONLY=1 ./script/run-users.sh   # just report balances
#
# Keys live outside the repo (0600) and are never printed. Output is appended to ../docs/USERS.md.
# The script is resumable: it re-discovers each wallet's position via PositionCreated logs, so a
# wallet that already created a position (e.g. an earlier partial run) is not asked to create another.
set -uo pipefail

RPC=${RPC:-https://rpc.test.mezo.org}
ENGINE=${ENGINE:-0xa1780be8f3c6e07714f51e5063839d6a6c61ee0b}
TROVE_MANAGER=${TROVE_MANAGER:-0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0}
USERS=${PYLON_USERS:-$HOME/.pylon-demo/users.json}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT=${OUT:-$ROOT/../docs/USERS.md}
COLL=${COLL:-0.045}                 # trove collateral, BTC
DEBT=${DEBT:-2000000000000000000000} # 2,000 MUSD (Mezo minimum 1,800 + 200 gas comp)
LOOP_COLL=${LOOP_COLL:-500000000000000} # 0.0005 BTC loop
ZERO=0x0000000000000000000000000000000000000000
SCAN_DEPTH=${SCAN_DEPTH:-60000} # v6 deployed ~40k blocks ago; log scan breaks at first hit scanning newest→oldest

need=$(python3 -c "print(int(float('$COLL')*1e18)+300000000000000)")

# Newest position created for $1 (any case), or nothing. Chunks the log scan to the RPC's 10k limit.
# Uses curl: the public RPC 403s Python's urllib user-agent. Retries transient failures.
find_position() {
  python3 - "$1" "$RPC" "$ENGINE" "$SCAN_DEPTH" <<'PY'
import json, sys, subprocess
owner, rpc, engine, depth = sys.argv[1], sys.argv[2], sys.argv[3].lower(), int(sys.argv[4])
topic0 = "0xb50b6911cde75151ee62a8ea049ce8e1eb7568951442b40825d50bdec8d78e9a"  # PositionCreated(address,address)
topic1 = "0x" + "0" * 24 + owner.lower()[2:]

def call(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    last = None
    for _ in range(3):
        out = subprocess.run(["curl", "-s", "-m", "60", "-X", "POST", rpc,
                              "-H", "content-type: application/json", "-d", body],
                             capture_output=True, text=True).stdout
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            last = out
    raise SystemExit(f"RPC call {method} failed: {last}")

latest = int(call("eth_blockNumber", [])["result"], 16)
blocks = []
end = latest
while end > max(0, latest - depth):
    start = max(0, end - 9999)
    res = call("eth_getLogs", [{
        "fromBlock": hex(start), "toBlock": hex(end),
        "address": engine, "topics": [topic0, topic1],
    }]).get("result") or []
    for l in res:
        blocks.append((int(l["blockNumber"], 16), l))
    if blocks:
        break  # logs scan newest → oldest; first window with a hit is the answer
    end = start - 1
if not blocks:
    sys.exit(0)
blocks.sort(key=lambda t: t[0])
print("0x" + blocks[-1][1]["topics"][2][-40:])
PY
}

# cast send wrapper: prints the transaction hash, returns non-zero if the tx failed on-chain.
send() { # private-key to sig [args...] [--value X]
  local key="$1"; shift
  local hash
  hash=$(cast send "$@" --private-key "$key" --rpc-url "$RPC" --json 2>/tmp/opencode/cast-send-error.log \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])" 2>/dev/null)
  [ -z "$hash" ] && return 1
  # cast emits the receipt JSON even for reverted txs — check the status word explicitly.
  local status
  status=$(curl -s -m 30 -X POST "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$hash\"]}" \
    | python3 -c "import json,sys; r=json.load(sys.stdin).get('result') or {}; print(int(r.get('status','0x0'),16))" 2>/dev/null)
  [ "$status" = "1" ] || { echo "    tx $hash reverted (status ${status:-unknown})" >>/tmp/opencode/cast-send-error.log; return 1; }
  printf '%s' "$hash"
}

failures=""
funded=0
while IFS=$'\t' read -r label addr key; do
  bal=$(cast balance "$addr" --rpc-url "$RPC" 2>/dev/null || echo 0)
  human=$(cast from-wei "$bal" ether 2>/dev/null || echo 0)
  if [ "$bal" -lt "$need" ]; then
    printf "  %-6s %s  %s BTC  needs faucet\n" "$label" "$addr" "$human"
    continue
  fi
  funded=$((funded + 1))
  printf "  %-6s %s  %s BTC  ready\n" "$label" "$addr" "$human"
  [ "${CHECK_ONLY:-0}" = "1" ] && continue

  # Already documented in USERS.md → never send again (a stray loop adds real debt).
  if [ -f "$OUT" ] && grep -q "^| $label |" "$OUT"; then
    echo "  [$label] already documented in $OUT — skipping"
    continue
  fi

  # 1. position (resume if one already exists)
  pos=$(find_position "$addr")
  if [ -n "$pos" ]; then
    echo "  [$label] position already exists: $pos"
  else
    echo "  [$label] createPosition"
    h_create=$(send "$key" "$ENGINE" "createPosition(address)" "$addr" || true)
    if [ -z "$h_create" ]; then
      echo "  [$label] FAIL createPosition — see /tmp/opencode/cast-send-error.log"; failures="$failures $label:createPosition"; continue
    fi
    pos=""
    for _ in 1 2 3 4 5 6; do sleep 3; pos=$(find_position "$addr"); [ -n "$pos" ] && break; done
    if [ -z "$pos" ]; then
      echo "  [$label] FAIL no PositionCreated log for $h_create"; failures="$failures $label:createPosition(no-log)"; continue
    fi
    echo "  [$label] position $pos (tx $h_create)"
  fi

  # 2. openTrove — skip if the trove is already active (re-opening would revert)
  trove_status=$(cast call "$TROVE_MANAGER" "getTroveStatus(address)(uint256)" "$pos" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
  if [ "$trove_status" = "1" ]; then
    echo "  [$label] trove already active — skipping openTrove"
    h_open="ALREADY_OPEN"
  else
    echo "  [$label] openTrove ${COLL} BTC / 2,000 MUSD (hint race can revert — will retry)"
    h_open=""
    for attempt in 1 2 3 4 5; do
      h_open=$(send "$key" "$pos" "openTrove(uint256)" "$DEBT" --value "$(cast to-wei "$COLL" ether)" || true)
      [ -n "$h_open" ] && break
      echo "  [$label] openTrove attempt $attempt reverted — retrying"
      sleep 2
    done
    if [ -z "$h_open" ]; then
      echo "  [$label] FAIL openTrove — see /tmp/opencode/cast-send-error.log"; failures="$failures $label:openTrove"; continue
    fi
    echo "  [$label] trove opened: $h_open"
  fi
  sleep 3

  # 3. shield
  echo "  [$label] arm shield (170% trigger, 185% target)"
  h_shield=$(send "$key" "$pos" "setShield(bool,uint64,uint64,uint128)" true 1700000000000000000 1850000000000000000 5000000000000000000000 || true)
  [ -z "$h_shield" ] && echo "  [$label] WARN setShield failed — continuing (loop does not need it)" && h_shield="FAILED"
  sleep 2

  # 4. one flash loop
  debt_delta=$(cast call "$ENGINE" "previewLoopDebtForCollateral(uint256)(uint256)" "$LOOP_COLL" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
  if [ -z "$debt_delta" ] || [ "$debt_delta" = "0" ]; then
    echo "  [$label] FAIL previewLoopDebtForCollateral"; failures="$failures $label:preview"; continue
  fi
  dl=$(( $(date +%s) + 3600 ))
  echo "  [$label] flash loop 0.0005 BTC (+$debt_delta wei debt)"
  h_loop=$(send "$key" "$ENGINE" "loopPosition(address,uint256,uint256,address,address,uint256,uint256)" \
      "$pos" "$debt_delta" "$LOOP_COLL" "$ZERO" "$ZERO" 0 "$dl" || true)
  if [ -z "$h_loop" ]; then
    echo "  [$label] FAIL loopPosition — see /tmp/opencode/cast-send-error.log"; failures="$failures $label:loop"; continue
  fi
  echo "  [$label] loop: $h_loop"

  cat >> "$OUT" <<EOF
| $label | \`$addr\` | \`$pos\` | [open](https://explorer.test.mezo.org/tx/$h_open) | [loop](https://explorer.test.mezo.org/tx/$h_loop) | [shield](https://explorer.test.mezo.org/tx/$h_shield) |
EOF
done < <(python3 -c "
import json
for u in json.load(open('$USERS')):
    print(u['label']+'\t'+u['address']+'\t'+u['private_key'])
")

echo
echo "funded wallets: $funded / 5"
echo "failures: ${failures:-none}"
exit 0
