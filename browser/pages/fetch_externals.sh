set -euo pipefail
cd "$(dirname "$0")/../.."
 
# path|ref
needed=(
  "external/boost|"
  "external/capstone|5.0.3"
  "external/dynarmic|"
  "external/ffmpeg|"
  "external/fmt|"
  "external/sdl|release-3.2.x"
  "external/spdlog|v1.x"
  "external/vita-toolchain|"
)
 
have_content() { [ -n "$(ls -A "$1" 2>/dev/null)" ]; }
 
for entry in "${needed[@]}"; do
  path=${entry%%|*}
  ref=${entry#*|}
  if have_content "$path"; then
    echo "fetch_externals: $path already present"
    continue
  fi
  url=$(git config -f .gitmodules --get "submodule.$path.url" || true)
  if [ -z "$url" ]; then
    echo "fetch_externals: no URL for $path in .gitmodules" >&2
    exit 1
  fi
  args=(--depth 1 --recurse-submodules --shallow-submodules)
  [ -n "$ref" ] && args+=(--branch "$ref")
  for attempt in 1 2 3; do
    rm -rf "$path"
    if git clone "${args[@]}" "$url" "$path"; then
      echo "fetch_externals: $path @ $(git -C "$path" rev-parse HEAD) (${ref:-default branch})"
      continue 2
    fi
    echo "fetch_externals: clone of $url failed (attempt $attempt/3)" >&2
    sleep $((attempt * 5))
  done
  echo "fetch_externals: could not fetch $path from $url" >&2
  exit 1
done
 
