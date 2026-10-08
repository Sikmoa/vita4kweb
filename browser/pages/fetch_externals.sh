#!/usr/bin/env bash
# fetch_externals.sh: make sure the third-party sources the browser build needs
# exist under external/.
#
# Why this exists: .gitmodules lists them, but a repository created from a zip
# or a web upload has no submodule entries, so a checkout leaves external/boost,
# capstone, dynarmic, fmt, sdl, spdlog ... empty or missing and CMake fails with
# "add_subdirectory given source ... external/<name> which is not an existing
# directory" or "Cannot find source file". A directory that already has content
# (a real submodule checkout, a local clone) is left untouched.
#
# URLs come from .gitmodules. Refs are best-effort (the exact upstream commits
# are not recorded without real submodule entries); an empty ref means the
# remote's default branch, and a ref that does not exist falls back to it with
# a warning. The commit used is printed so it can be pinned.
set -euo pipefail
cd "$(dirname "$0")/../.."

# path|ref
needed=(
  "external/boost|"
  "external/capstone|5.0.3"
  "external/dlmalloc|"
  "external/dynarmic|"
  "external/ffmpeg|"
  "external/fmt|"
  "external/LibAtrac9|"
  "external/pugixml|"
  "external/sdl|release-3.2.x"
  "external/spdlog|v1.x"
  "external/stb|"
  "external/vita-toolchain|"
  "external/xxHash|v0.8.3"
  "external/yaml-cpp|"
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

  # Pinned ref twice (network hiccups), then the default branch.
  tries=("$ref" "$ref" "")
  fetched=0
  n=0
  for try_ref in "${tries[@]}"; do
    n=$((n + 1))
    args=(--depth 1 --recurse-submodules --shallow-submodules)
    if [ -n "$try_ref" ]; then args+=(--branch "$try_ref"); fi
    rm -rf "$path"
    if git clone "${args[@]}" "$url" "$path"; then
      if [ -n "$ref" ] && [ -z "$try_ref" ]; then
        echo "fetch_externals: WARNING ref '$ref' unavailable for $path, used default branch" >&2
      fi
      echo "fetch_externals: $path @ $(git -C "$path" rev-parse HEAD) (${try_ref:-default branch})"
      fetched=1
      break
    fi
    echo "fetch_externals: clone of $url failed (attempt $n/3)" >&2
    sleep $((n * 5))
  done
  if [ "$fetched" -ne 1 ]; then
    echo "fetch_externals: could not fetch $path from $url" >&2
    exit 1
  fi
done
