#!/usr/bin/env bash
# Grind a vanity keypair for the Yield AI v2 mainnet program ID.
#
# Usage (Linux, macOS or WSL with the Solana CLI installed):
#   ./scripts/grind-vanity.sh              # prefix yie1d, all CPU cores
#   ./scripts/grind-vanity.sh yie1d yie1D  # stop at the first match of any prefix
#   THREADS=8 ./scripts/grind-vanity.sh    # leave cores free for other work
#
# Run it detached so it survives logout:
#   nohup ./scripts/grind-vanity.sh > ~/grind-vanity.log 2>&1 &
#   tail -f ~/grind-vanity.log
#
# The keypair is written OUTSIDE the repo, to $OUT_DIR (default ~/.config/solana/yield-v2/vanity),
# with mode 600. It is a program deploy key: never commit it, never paste it into chat or a
# ticket. Move it to the deploy machine on a USB stick or over `scp`, then delete the extra copy.
#
# Base58 has no 0, O, I or l. Each extra character multiplies the expected work by ~58:
# "yie1" took 394M keys (~26 min on 22 threads, ~255k keys/s); "yie1d" is expected to be
# roughly 58x that, i.e. on the order of a day on a similar machine, with high variance.
set -euo pipefail

if ! command -v solana-keygen >/dev/null 2>&1; then
  echo "solana-keygen not found. Install the Solana CLI: https://solana.com/docs/intro/installation" >&2
  exit 1
fi

prefixes=("$@")
[ ${#prefixes[@]} -eq 0 ] && prefixes=("yie1d")
alphabet='^[1-9A-HJ-NP-Za-km-z]+$'
args=()
for prefix in "${prefixes[@]}"; do
  if ! [[ "$prefix" =~ $alphabet ]]; then
    echo "Prefix '$prefix' contains characters outside base58 (0, O, I, l are not allowed)." >&2
    exit 1
  fi
  args+=(--starts-with "$prefix:1")
done

threads="${THREADS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)}"
out_dir="${OUT_DIR:-$HOME/.config/solana/yield-v2/vanity}"
mkdir -p "$out_dir"
chmod 700 "$out_dir"
cd "$out_dir"

echo "$(date -u +%FT%TZ) grinding ${prefixes[*]} on $threads threads into $out_dir"
start=$(date +%s)
solana-keygen grind "${args[@]}" --num-threads "$threads"
elapsed=$(( $(date +%s) - start ))

chmod 600 "$out_dir"/*.json
echo "$(date -u +%FT%TZ) done in ${elapsed}s. Keypairs in $out_dir:"
for key in "$out_dir"/*.json; do
  echo "  $(solana-keygen pubkey "$key")  ($key)"
done
