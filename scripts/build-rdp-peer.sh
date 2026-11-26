#!/usr/bin/env bash
# Builds the separate Windows service installer for the release workflow or explicit test preview.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
out="$root/dist/rdp-connector"
exe=cloudssh-rdp-connector-windows-amd64.exe
cd "$root/tools/rdp-peer"
export GOWORK=off GOOS=windows GOARCH=amd64 CGO_ENABLED=0
mkdir -p "$out"
go build -mod=readonly -buildvcs=false -trimpath -ldflags='-s -w' -o "$out/$exe" .
# The downloadable binary includes code from Go and statically linked third-party modules.
# Collect the notices from the locked dependency graph, not a best-effort download at runtime.
modules=$(go list -mod=readonly -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}{{"\t"}}{{.Version}}{{"\t"}}{{.Dir}}{{end}}{{end}}' . | LC_ALL=C sort -u)
{
  printf 'CloudSSH RDP Connector\n\n'; cat "$root/LICENSE" "$root/NOTICE"
  goroot=$(go env GOROOT); license="$goroot/LICENSE"
  # Homebrew ships the distribution license one directory above libexec.
  if [[ ! -f "$license" && "${goroot##*/}" == libexec ]]; then license="$goroot/../LICENSE"; fi
  printf '\nGo runtime and standard library\n'; cat "$license"
  while IFS=$'\t' read -r name version dir; do
    [[ -n "$name" ]] || continue
    printf '\n%s %s\n' "$name" "$version"
    found=false
    for text in "$dir"/LICENSE* "$dir"/COPYING* "$dir"/NOTICE* "$dir"/PATENTS; do
      [[ -f "$text" ]] || continue
      cat "$text"; printf '\n'; found=true
    done
    if [[ "$found" != true ]]; then printf 'Missing license for %s\n' "$name" >&2; exit 1; fi
  done <<< "$modules"
} > "$out/LICENSES.txt"
cd "$out"
if command -v sha256sum >/dev/null; then sha256sum "$exe" > SHA256SUMS
else shasum -a 256 "$exe" > SHA256SUMS; fi
printf 'Windows x64 connector, SHA256SUMS and notices: %s\n' "$out"
