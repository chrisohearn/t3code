# Sourced by the fork scripts. The Node version package.json pins (CI and releases use it), from
# nodejs.org, checksum-verified and cached.

# Prints the directory holding node.tar.xz for the pinned version.
fork_node_archive() {
  local cache=$1 version dir want
  version=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["engines"]["node"])' package.json)
  dir="$cache/node/v$version"
  if [[ ! -f "$dir/node.tar.xz" ]]; then
    mkdir -p "$dir"
    curl -fsSL "https://nodejs.org/dist/v$version/SHASUMS256.txt" -o "$dir/SHASUMS256.txt"
    curl -fsSL "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.xz" -o "$dir/node.tar.xz.part"
    want=$(awk -v f="node-v$version-linux-x64.tar.xz" '$2==f {print $1}' "$dir/SHASUMS256.txt")
    [[ "$(sha256sum "$dir/node.tar.xz.part" | cut -d' ' -f1)" == "$want" ]] ||
      { echo "node archive checksum mismatch" >&2; return 1; }
    mv "$dir/node.tar.xz.part" "$dir/node.tar.xz"
  fi
  echo "$dir"
}

# Prints a bin directory with the pinned node, extracted from the cached archive.
fork_node_bin() {
  local cache=$1 dir
  dir=$(fork_node_archive "$cache") || return 1
  if [[ ! -x "$dir/dist/bin/node" ]]; then
    mkdir -p "$dir/dist.part"
    tar -xJf "$dir/node.tar.xz" -C "$dir/dist.part" --strip-components=1
    mv "$dir/dist.part" "$dir/dist"
  fi
  echo "$dir/dist/bin"
}
