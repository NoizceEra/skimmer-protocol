@echo off
REM Build skim_protocol with MSVC host toolchain + Agave build-sbf.
REM Why: anchor-cli 0.29 shells out to `cargo build-bpf`, removed in Solana 2.x.
REM Run from cmd.exe so MSYS link.exe can't shadow MSVC link.exe.
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 (
  echo [FAIL] vcvars64.bat not found or failed
  exit /b 1
)
cd /d D:\ai-studio\skim-protocol
echo === build skim_protocol ===
cargo-build-sbf --manifest-path programs\skim_protocol\Cargo.toml
if errorlevel 1 ( echo [FAIL] skim_protocol & exit /b 1 )
echo.
echo === artifacts ===
dir /b target\deploy\*.so
echo BUILD-OK
