#!/usr/bin/env bash
set -euo pipefail

# Local mainnet snapshot only. Keys in /tmp/kfork are disposable test keys created by older fixtures.
fixture_dir="${KFORK_DIR:-/tmp/kfork}"
build_dir="${V2_BUILD_DIR:?set V2_BUILD_DIR to the yie1 build directory}"
[[ -f "$build_dir/target/deploy/yield_vault.so" ]] || { echo "Missing yie1 program build" >&2; exit 1; }
args=(--reset --ledger "$fixture_dir/test-ledger" --url "${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
  --warp-slot "$(cat "$fixture_dir/fork-slot.txt")")
args+=(--upgradeable-program yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih
  "$build_dir/target/deploy/yield_vault.so" /tmp/yield-v2-admin.json)
args+=(--clone EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
args+=(--account - "$fixture_dir/owner-usdc.json")
while IFS= read -r program; do
  [[ -n "$program" ]] && args+=(--clone-upgradeable-program "$program")
done < "$fixture_dir/clone-programs.txt"
while IFS= read -r account; do
  [[ -n "$account" ]] && args+=(--maybe-clone "$account")
done < "$fixture_dir/clone-accounts.txt"
exec env NO_DNA=1 solana-test-validator "${args[@]}"
