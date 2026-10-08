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
# URLs come from .gitmodules. The exact upstream commits are not recorded
# without real submodule entries, so each entry is:
#   path | candidate refs (space separated, tried in order) | probe file
# Candidates are tags/branches; after them the remote's default branch is
# tried. A clone only counts if the probe file exists in it, which lets an
# entry walk back to an older release that still has the layout the sources
# expect. The commit used is printed so it can be pinned.
set -euo pipefail
cd "$(dirname "$0")/../.."

needed=(
  "external/boost||libs/filesystem/src"
  "external/capstone|5.0.3|include/capstone/capstone.h"
  "external/dlmalloc||"
  "external/dynarmic||externals/mcl"
  "external/ffmpeg||include"
  "external/fmt||src/format.cc"
  "external/glslang|15.4.0 15.3.0 15.2.0 15.1.0 15.0.0 14.3.0 14.2.0 14.1.0 14.0.0 13.1.1|SPIRV/spirv.hpp"
  "external/LibAtrac9||C/src"
  "external/libfat16||src"
  "external/psvpfstools||psvpfsparser"
  "external/pugixml||src/pugixml.cpp"
  "external/sdl|release-3.2.x|include/SDL3/SDL.h"
  "external/spdlog|v1.x|include/spdlog/spdlog.h"
  "external/stb||"
  "external/vita-toolchain||src"
  "external/xxHash|v0.8.3|xxhash.h"
  "external/yaml-cpp||include/yaml-cpp/yaml.h"
)

have_content() { [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

for entry in "${needed[@]}"; do
  IFS='|' read -r path refs probe <<<"$entry"
  if have_content "$path"; then
    echo "fetch_externals: $path already present"
    continue
  fi
  url=$(git config -f .gitmodules --get "submodule.$path.url" || true)
  if [ -z "$url" ]; then
    echo "fetch_externals: no URL for $path in .gitmodules" >&2
    exit 1
  fi

  fetched=0
  for round in 1 2; do
    # shellcheck disable=SC2086  # $refs is a deliberate word list
    for try_ref in $refs ""; do
      args=(--depth 1 --recurse-submodules --shallow-submodules)
      if [ -n "$try_ref" ]; then args+=(--branch "$try_ref"); fi
      rm -rf "$path"
      if ! git clone -q "${args[@]}" "$url" "$path" 2>/dev/null; then
        echo "fetch_externals: $path: ${try_ref:-default branch} unavailable" >&2
        continue
      fi
      if [ -n "$probe" ] && [ ! -e "$path/$probe" ]; then
        echo "fetch_externals: $path: ${try_ref:-default branch} lacks $probe, trying another" >&2
        rm -rf "$path"
        continue
      fi
      echo "fetch_externals: $path @ $(git -C "$path" rev-parse HEAD) (${try_ref:-default branch})"
      fetched=1
      break 2
    done
    echo "fetch_externals: $path: round $round failed" >&2
    sleep 10
  done
  if [ "$fetched" -ne 1 ]; then
    echo "fetch_externals: could not fetch a usable $path from $url" >&2
    exit 1
  fi
done
