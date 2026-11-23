#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
commit=65bcca1913a28cbdd7eb913599f692bd2b707991
image=emscripten/emsdk@sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05

# Only the disposable FreeRDP checkout is mounted into the container. No CloudSSH
# checkout, Cloudflare credentials, or Windows credentials are available there.
if [[ $# -eq 0 ]]; then
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/cloudssh-rdp-build.XXXXXXXX")
  cleanup() {
    trap - EXIT
    rm -rf -- "$temp_dir"
  }
  trap cleanup EXIT
  source_dir="$temp_dir/FreeRDP"
  git clone --depth 1 --branch 3.33.1 --single-branch --no-tags \
    https://github.com/FreeRDP/FreeRDP.git "$source_dir"
  fresh=1
elif [[ $# -eq 2 && $1 == --reuse-source ]]; then
  source_dir=$(cd -- "$2" && pwd)
  fresh=0
else
  printf '%s\n' 'Usage: bash prepare-preview.sh [--reuse-source /path/to/disposable/FreeRDP]' >&2
  exit 2
fi
[[ $(git -C "$source_dir" rev-parse HEAD) == "$commit" ]]

# Linux bind mounts preserve Unix ownership: use the host builder for both
# fetch and compile so the host can read artifacts and remove the checkout.
mkdir -p -- "$source_dir/.cloudssh-build-home" "$source_dir/.cloudssh-build-tools"
run_sdk() {
  docker run --rm --user "$(id -u):$(id -g)" \
    -e HOME=/src/.cloudssh-build-home -e EM_CACHE=/src/.cloudssh-build-home/emscripten-cache \
    -e "CMAKE_BUILD_PARALLEL_LEVEL=${CMAKE_BUILD_PARALLEL_LEVEL:-4}" \
    --mount "type=bind,source=$source_dir,target=/src" -w /src "$image" "$@"
}

# FreeRDP's upstream fingerprint list is a fallback allowlist, not strict pinning.
# For this preview, configured pins reject every mismatch, including otherwise trusted chains.
python3 - "$source_dir/libfreerdp/crypto/tls.c" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1]); text = p.read_text()
old = '''\tif (is_accepted_fingerprint(cert, settings->CertificateAcceptedFingerprints))
\t{
\t\tverification_status = 1;
\t\tgoto end;
\t}'''
new = '''\tif (settings->CertificateAcceptedFingerprints)
\t{
\t\tverification_status =
\t\t    is_accepted_fingerprint(cert, settings->CertificateAcceptedFingerprints) ? 1 : -1;
\t\tgoto end;
\t}'''
# Also move the previous accepted-key check after the pin decision.
accepted = '''\t/* Check, if we already accepted this key. */
\tif (is_accepted(tls, cert))
\t{
\t\tverification_status = 1;
\t\tgoto end;
\t}

'''
if text.count(new + '\n\n' + accepted.rstrip('\n')) == 1:
    sys.exit(0)
needle = accepted + old
if text.count(needle) != 1:
    sys.exit('FreeRDP strict-pin patch did not match the pinned source')
p.write_text(text.replace(needle, new + '\n\n' + accepted.rstrip('\n')))
PY

# Fetch with the official script, then confirm all the git dependency commits
# before any dependency build. The official script verifies the LibreSSL tarball.
if [[ $fresh == 1 ]]; then
  run_sdk bash -euc 'git config --global --add safe.directory /src; bash scripts/emscripten.sh --no-build'
fi
while read -r path sha; do
  [[ $(git -C "$source_dir/build-emscripten/src/$path" rev-parse HEAD) == "$sha" ]]
done <<'COMMITS'
zlib da607da739fa6047df13e66a2af6b8bec7c2a498
uriparser 9b2bed92f5deecf740819f9bf27724bee2fe9c12
json-c aa716cd8d663c976b99b0f30f102ee1d8ef63146
SDL 829a65d769d935c4852f8159e964312c0957260a
SDL_ttf a1ce3670aec736ecbf0936c43f2f0cc53aa61e5b
opus 22244de5a79bd1d6d623c32e72bf1954b56235be
SDL_ttf/external/freetype 9973564cfa63763a3e4ac67c09147899539b1e07
SDL_ttf/external/harfbuzz 564bf9818a18709776856533829c0c04950773d6
SDL_ttf/external/plutosvg 2983eb6919feea272d793bc386384e3f5b97b03c
SDL_ttf/external/plutovg 3e6f922f453da1c9e7d1d7f66cac1d9724a18b47
COMMITS

# Avoid managing an unpinned Linux package repository inside the build container.
case $(docker info --format '{{.Architecture}}') in
  aarch64|arm64)
    ninja_wheel=8e/de/6e1cd6b84b412ac1ef327b76f0641aeb5dcc01e9d3f9eee0286d0c34fd93/ninja-1.13.0-py3-none-manylinux2014_aarch64.manylinux_2_17_aarch64.whl
    ninja_sha=3d00c692fb717fd511abeb44b8c5d00340c36938c12d6538ba989fe764e79630 ;;
  x86_64|amd64)
    ninja_wheel=ed/de/0e6edf44d6a04dabd0318a519125ed0415ce437ad5a1ec9b9be03d9048cf/ninja-1.13.0-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl
    ninja_sha=fb46acf6b93b8dd0322adc3a4945452a4e774b75b91293bafcc7b7f8e6517dfa ;;
  *) printf '%s\n' 'Unsupported Docker architecture' >&2; exit 1 ;;
esac
curl --fail --silent --show-error --location --retry 2 --retry-all-errors --connect-timeout 15 --max-time 120 \
  "https://files.pythonhosted.org/packages/$ninja_wheel" \
  --output "$source_dir/.cloudssh-build-tools/ninja.zip"
python3 - "$source_dir/.cloudssh-build-tools" "$ninja_sha" <<'PY'
from pathlib import Path
import hashlib, sys, zipfile
folder = Path(sys.argv[1]); archive = folder / 'ninja.zip'
if hashlib.sha256(archive.read_bytes()).hexdigest() != sys.argv[2]:
    sys.exit('Ninja release checksum did not match')
bin = folder / 'ninja'
with zipfile.ZipFile(archive) as zip:
    bin.write_bytes(zip.read('ninja-1.13.0.data/scripts/ninja'))
bin.chmod(0o700)
PY

build_args=()
if [[ $fresh == 0 ]]; then build_args+=(--no-deps); fi
run_sdk bash -euc '
  export PATH="/src/.cloudssh-build-tools:$PATH"
  bash scripts/emscripten.sh --no-clone "$@"
' build "${build_args[@]}"

out="$here/preview-build"
mkdir -p -- "$out"
artifacts="$source_dir/build-emscripten/build/freerdp/client/SDL/SDL3"
cp -- "$artifacts/sdl-freerdp.js" "$out/sdl-freerdp.rdp-text"
cp -- "$artifacts/sdl-freerdp.wasm" "$out/sdl-freerdp.rdp-bin"
cp -- "$here/desktop-src/index.html" "$out/index.rdp-text"
cp -- "$here/desktop-src/desktop.js" "$out/desktop.rdp-text"
node -e 'const fs = require("node:fs"); const wasm = fs.readFileSync(process.argv[1]); if (wasm.length > 24 * 1024 * 1024 || !WebAssembly.validate(wasm)) process.exit(1);' "$out/sdl-freerdp.rdp-bin"
python3 - "$source_dir" "$out/licenses.rdp-text" <<'PY'
from pathlib import Path
import sys
source, out = map(Path, sys.argv[1:]); dependencies = source / 'build-emscripten' / 'src'
names = ('LICENSE*', 'COPYING*', 'NOTICE*', 'FTL.TXT', 'GPLv2.TXT')
roots = [source, *(p for p in dependencies.iterdir() if p.is_dir())]
roots += list((dependencies / 'SDL_ttf/external').iterdir())
files = {source / 'client/SDL/SDL3/dialogs/font/OFL.txt'}
for root in roots:
    for folder in (root, root / 'docs'):
        for glob in names:
            files.update(p for p in folder.glob(glob) if p.is_file() and p.stat().st_size <= 65536)
with out.open('w') as f:
    f.write('CloudSSH test RDP preview: FreeRDP 3.33.1 with strict configured certificate pinning.\n')
    f.write('https://github.com/FreeRDP/FreeRDP/tree/65bcca1913a28cbdd7eb913599f692bd2b707991\n')
    for license in sorted(files):
        f.write(f'\n--- {license.relative_to(source)} ---\n')
        f.write(license.read_text(errors='replace'))
PY
if [[ $fresh == 1 ]]; then cleanup; fi
printf '%s\n' 'Test-only FreeRDP assets prepared.'
