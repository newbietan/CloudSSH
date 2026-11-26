#!/usr/bin/env bash
# Test deployment only. Never invoke for the production entry.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
bash "$root/scripts/build-rdp-peer.sh"
out="$root/src/worker/rdp-client/connector-preview.generated.rdp-bin"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$root/dist/rdp-connector" && zip -q -X "$tmp/connector.zip" cloudssh-rdp-connector-windows-amd64.exe LICENSES.txt SHA256SUMS)
size=$(wc -c < "$tmp/connector.zip")
if (( size > 5000000 )); then
  echo 'Connector ZIP exceeds the test Worker preview budget. Use the signed release download instead.' >&2
  exit 1
fi
mv -f "$tmp/connector.zip" "$out"
printf 'Test-only connector preview: %s bytes\n' "$size"
