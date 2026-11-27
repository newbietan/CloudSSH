#!/usr/bin/env bash
# Test deployment only. Never invoke for the production entry.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
bash "$root/scripts/build-rdp-peer.sh"
out="$root/src/worker/rdp-client/connector-preview.generated.rdp-bin"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bash "$root/scripts/package-rdp-connector.sh" "$root/dist/rdp-connector" "$tmp"
zip_file="$tmp/cloudssh-rdp-connector-windows-amd64.zip"
size=$(wc -c < "$zip_file")
if (( size > 5000000 )); then
  echo 'Connector ZIP exceeds the test Worker preview budget. Use the published release download instead.' >&2
  exit 1
fi
mv -f "$zip_file" "$out"
printf 'Test-only connector preview: %s bytes\n' "$size"
