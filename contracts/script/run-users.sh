#!/usr/bin/env bash
# Drives the five faucet-funded test wallets through the real Pylon flow on the hardened (v6)
# generation: create a position, open a trove, arm the shield, and run one flash loop.
#
#   PYLON_USERS=~/.pylon-demo/users.json \
#   ENGINE=0xa1780be8f3c6e07714F51e5063839D6a6c61EE0b \
#   ./script/run-users.sh            # run
#   CHECK_ONLY=1 ./script/run-users.sh   # just report balances
#
# Keys live outside the repo (0600) and are never printed. Output is appended to ../docs/USERS.md.
set -euo pipefail

RPC=${RPC:-https://rpc.test.mezo.org}
ENGINE=${ENGINE:-0xa1780be8f3c6e07714F51e5063839D6a6c61EE0b}
USERS=${PYLON_USERS:-$HOME/.pylon-demo/users.json}
OUT=${OUT:-../docs/USERS.md}
COLL=${COLL:-0.045}                 # trove collateral, BTC
DEBT=${DEBT:-2000000000000000000000} # 2,000 MUSD (Mezo minimum 1,800 + 200 gas comp)
LOOP_COLL=${LOOP_COLL:-500000000000000} # 0.0005 BTC loop
ZERO=0x0000000000000000000000000000000000000000

need=$(python3 -c "print(int(float('$COLL')*1e18)+300000000000000)") # collateral + ~0.0003 gas buffer
event_topic=$(cast keccak "PositionCreated(address,address)")

funded=0
while IFS=$'\t' read -r label addr key; do
  bal=$(cast balance "$addr" --rpc-url "$RPC" 2>/dev/null || echo 0)
  human=$(cast from-wei "$bal" --ether 2>/dev/null || echo 0)
  if [ "$bal" -lt "$need" ]; then
    printf "  %-6s %s  %s BTC  needs faucet\n" "$label" "$addr" "$human"
    continue
  fi
  funded=$((funded + 1))
  printf "  %-6s %s  %s BTC  ready\n" "$label" "$addr" "$human"
  [ "${CHECK_ONLY:-0}" = "1" ] && continue

  echo "  [$label] createPosition"
  h=$(cast send "$ENGINE" "createPosition(address)" "$addr" \
      --private-key "$key" --rpc-url "$RPC" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")
  sleep 2
  pos=$(cast receipt "$h" --json --rpc-url "$RPC" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for l in d['logs']:
    if l['topics'][0].lower()=='$event_topic' and l['address'].lower()=='$ENGINE':
        print('0x'+l['topics'][2][-40:]); break
")
  echo "  [$label] position $pos"

  echo "  [$label] openTrove ${COLL} BTC / 2,000 MUSD"
  h_open=$(cast send "$pos" "openTrove(uint256)" "$DEBT" --value "$(cast to-wei "$COLL" ether)" \
      --private-key "$key" --rpc-url "$RPC" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")
  sleep 2

  echo "  [$label] arm shield (170% trigger, 185% target)"
  h_shield=$(cast send "$pos" "setShield(bool,uint64,uint64,uint128)" true 1700000000000000000 1850000000000000000 5000000000000000000000 \
      --private-key "$key" --rpc-url "$RPC" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")
  sleep 2

  debt_delta=$(cast call "$ENGINE" "previewLoopDebtForCollateral(uint256)(uint256)" "$LOOP_COLL" --rpc-url "$RPC" | awk '{print $1}')
  echo "  [$label] flash loop 0.0005 BTC (+$debt_delta wei debt)"
  dl=$(( $(date +%s) + 3600 ))
  h_loop=$(cast send "$ENGINE" "loopPosition(address,uint256,uint256,address,address,uint256,uint256)" \
      "$pos" "$debt_delta" "$LOOP_COLL" "$ZERO" "$ZERO" 0 "$dl" \
      --private-key "$key" --rpc-url "$RPC" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")

  cat >> "$OUT" <<EOF
| $label | \`$addr\` | \`$pos\` | [open](https://explorer.test.mezo.org/tx/$h_open) | [loop](https://explorer.test.mezo.org/tx/$h_loop) | [shield](https://explorer.test.mezo.org/tx/$h_shield) |
EOF
done < <(python3 -c "
import json,sys
for u in json.load(open('$USERS')):
    print(u['label']+'\t'+u['address']+'\t'+u['private_key'])
")

echo
echo "funded wallets: $funded / 5"
[ "$funded" -lt 5 ] && echo "top up the rest from https://faucet.test.mezo.org/ (0.05 BTC each is enough)"
exit 0
