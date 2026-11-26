#!/usr/bin/env bash
# Package a verified CloudSSH CI/local Windows x64 build; no Authenticode signer is required.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: bash scripts/package-rdp-connector.sh <build-directory> <release-directory>' >&2
  exit 1
fi
input=$(cd -- "$1" && pwd -P)
mkdir -p -- "$2"
output=$(cd -- "$2" && pwd -P)
[[ "$input" != "$output" ]] || { echo 'Build and release directories must differ.' >&2; exit 1; }
name=cloudssh-rdp-connector-windows-amd64
for path in "$name.exe" LICENSES.txt SHA256SUMS; do
  [[ -s "$input/$path" && -f "$input/$path" && ! -L "$input/$path" ]] || {
    echo "Missing or invalid connector build file: $path" >&2
    exit 1
  }
done
hash_file() {
  if command -v sha256sum >/dev/null; then sha256sum < "$1"
  else shasum -a 256 < "$1"; fi | awk '{print $1}'
}
exe_hash=$(hash_file "$input/$name.exe")
[[ "$(<"$input/SHA256SUMS")" == "$exe_hash  $name.exe" ]] || {
  echo 'Windows connector build checksum mismatch.' >&2
  exit 1
}
tmp=$(mktemp -d "$output/.connector-package.XXXXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
(cd -- "$input" && zip -q -X "$tmp/$name.zip" "$name.exe" LICENSES.txt SHA256SUMS)
size=$(wc -c < "$tmp/$name.zip")
if (( size < 1024 || size > 16 * 1024 * 1024 )); then
  echo 'Connector release ZIP does not fit the download budget.' >&2
  exit 1
fi
zip_hash=$(hash_file "$tmp/$name.zip")
printf '%s  %s.zip\n' "$zip_hash" "$name" > "$tmp/SHA256SUMS"
mv -f -- "$tmp/$name.zip" "$tmp/SHA256SUMS" "$output/"
printf 'Verified Windows release files: %s/%s.zip and SHA256SUMS\n' "$output" "$name"
