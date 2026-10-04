#!/usr/bin/env bash
# Build programs/skim_protocol to an SBF .so.
#
# WHY THIS EXISTS: anchor-cli 0.29 shells out to `cargo build-bpf`, which was
# removed in Solana 2.x, so `anchor build` fails with "no such command: build-bpf".
# The supported path on this Windows host is build-sbf-msvc.bat (vcvars64 + the
# Agave `cargo-build-sbf`). On Linux/macOS, plain `cargo-build-sbf` works.
#
# The LLVM "Stack offset ... exceeded" lines printed during the build are
# non-fatal SBF backend warnings (from spl-token-2022 confidential-transfer
# code); the build still succeeds and emits a valid .so.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${MSYSTEM:-}" || "$OSTYPE" == msys* || "$OSTYPE" == cygwin* ]]; then
  cmd.exe /C call "build-sbf-msvc.bat"
else
  cargo-build-sbf --manifest-path programs/skim_protocol/Cargo.toml
fi

SO="target/deploy/skim_protocol.so"
echo "artifact: $SO ($(stat -c %s "$SO") bytes)"
