#!/usr/bin/env bash
# Builds the fork's linux-x64 CLI archive and SHA256SUMS from the committed HEAD, in an
# ubuntu:24.04 container (the recipe every v0.1.9-preview.* fork release used), and smoke-tests it.
#
#   scripts/fork/build-release.sh <version>       e.g. 0.1.9-preview.20261112.1
#
# Prints the artifacts directory on the last line. Publish with scripts/fork/publish-release.sh.
# Needs docker, gh, curl and python3. Inputs are cached in ${XDG_CACHE_HOME:-~/.cache}/t3-fork-release.
set -euo pipefail

version=${1:?usage: build-release.sh <version>}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]{8}\.[0-9]+$ ]] ||
  { echo "version must look like 0.1.9-preview.YYYYMMDD.N" >&2; exit 2; }
repo=$(git rev-parse --show-toplevel)
cd "$repo"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] ||
  { echo "commit first: the build uses git archive HEAD" >&2; exit 2; }
git check-ignore -q .t3/release || { echo ".t3/ must be git-ignored" >&2; exit 2; }

cache=${XDG_CACHE_HOME:-$HOME/.cache}/t3-fork-release
mkdir -p "$cache/node" "$cache/pnpm-store" "$cache/resource-monitor"

# Node: the exact version package.json pins, verified against nodejs.org's SHASUMS256.txt.
source "$repo/scripts/fork/node.sh"
node_dir=$(fork_node_archive "$cache")

# Resource monitor: the native helper from upstream's newest linux-x64 nightly, as earlier releases did.
nightly=$(gh release list -R pingdotgg/t3code --limit 20 --json tagName,isPrerelease \
  --jq '[.[] | select(.isPrerelease)][0].tagName')
monitor_dir="$cache/resource-monitor/$nightly"
if [[ ! -x "$monitor_dir/resource-monitor/linux-x64/t3-resource-monitor" ]]; then
  tmp=$(mktemp -d -p "$cache/resource-monitor")
  gh release download "$nightly" -R pingdotgg/t3code --pattern "t3-${nightly#v}-linux-x64.tar.gz" --dir "$tmp"
  tar -xzf "$tmp"/*.tar.gz -C "$tmp" --wildcards '*/resource-monitor/*'
  mkdir -p "$monitor_dir"
  mv "$tmp"/*/resource-monitor "$monitor_dir/"
  rm -rf "$tmp"
fi

mkdir -p .t3/release
root=$(mktemp -d -p "$repo/.t3/release" build-XXXXXX)
mkdir "$root/source" "$root/artifacts"
git archive HEAD | tar -x -C "$root/source"
echo "$version $(git rev-parse HEAD)" >"$root/build.txt"

cat >"$root/build-package.sh" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
trap 'chown -R $(id -u):$(id -g) /work /cache' EXIT
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3 make g++ git libatomic1 pkg-config libsecret-1-dev patchelf
mkdir -p /opt/node
tar -xJf /inputs/node/node.tar.xz -C /opt/node --strip-components=1
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm install -g "\$(node -p 'require("/work/source/package.json").packageManager')"
cd /work/source
export CI=1 T3CODE_TELEMETRY_CHANNEL=dev
pnpm install --frozen-lockfile --store-dir /cache
node scripts/update-release-package-versions.ts $version
./node_modules/.bin/vp run --filter t3 build
PATH="\$PWD/node_modules/.bin:\$PATH" node apps/server/scripts/cli.ts build-exe --target linux-x64
PATH="\$PWD/node_modules/.bin:\$PATH" node scripts/build-cli-archive.ts --platform linux --arch x64 --version $version --resource-monitor-dir /inputs/monitor --output-dir /work/artifacts
PATH="\$PWD/node_modules/.bin:\$PATH" node scripts/smoke-cli-archive.ts --archive /work/artifacts/t3-$version-linux-x64.tar.gz --expect-version $version
cd /work/artifacts && sha256sum t3-$version-linux-x64.tar.gz > SHA256SUMS
SCRIPT

name="t3-fork-build-$(basename "$root")"
echo "building $version from $(git rev-parse --short HEAD) in $root (container $name)" >&2
docker run -d --name "$name" --label t3-fork-release="$version" --cpus 8 --memory 8g --memory-swap 8g \
  --mount "type=bind,src=$root,dst=/work" \
  --mount "type=bind,src=$node_dir,dst=/inputs/node,readonly" \
  --mount "type=bind,src=$monitor_dir/resource-monitor,dst=/inputs/monitor,readonly" \
  --mount "type=bind,src=$cache/pnpm-store,dst=/cache" \
  ubuntu:24.04 bash -c 'bash /work/build-package.sh > /work/build-package.log 2>&1' >/dev/null
status=$(docker wait "$name")
docker rm "$name" >/dev/null
if [[ "$status" != 0 ]]; then
  echo "build failed (exit $status); log: $root/build-package.log" >&2
  tail -20 "$root/build-package.log" >&2
  exit 1
fi
(cd "$root/artifacts" && sha256sum -c SHA256SUMS >&2)
echo "$root/artifacts"
