@echo off
REM Devnet fund + IN-PLACE UPGRADE loop for the LIVE program.
REM Upgrades an existing program: NO new program keypair, only the temporary
REM buffer rent (refunded) + a small permanent program-data top-up + fees.
REM v1 does NOT need this at all (plain SPL rail) -- see docs/MINIMAL_DEPLOY.md.
REM
REM Correct devnet rent: (size+128)*5080 lamports (NOT the obsolete *6960).
REM   .so = 328,912 B -> buffer rent 1.67152320 SOL (refunded), top-up ~0.0304 SOL.
setlocal EnableDelayedExpansion
cd /d D:\ai-studio\skim-protocol
set PROGRAM_ID=2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp
set AUTHKEY=%USERPROFILE%\.config\solana\deployer.json
echo [%date% %time%] upgrade loop started >> fund-deploy.log
for /L %%i in (1,1,72) do (
  set BALSTR=
  for /f "tokens=1" %%s in ('solana balance --keypair "%AUTHKEY%" --url devnet 2^>nul') do set BALSTR=%%s
  echo [%date% %time%] try %%i balance=!BALSTR! >> fund-deploy.log
  if "!BALSTR!" NEQ "" if !BALSTR! GEQ 2 (
    echo [%date% %time%] FUNDED (!BALSTR! SOL) - upgrading %PROGRAM_ID% >> fund-deploy.log
    solana program deploy target\deploy\skim_protocol.so --program-id %PROGRAM_ID% --upgrade-authority "%AUTHKEY%" --url devnet >> fund-deploy.log 2>&1
    solana program show %PROGRAM_ID% --url devnet >> fund-deploy.log 2>&1
    exit /b 0
  )
  solana airdrop 1 95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG --url devnet >> fund-deploy.log 2>&1
  timeout /t 300 /nobreak >nul
)
echo [%date% %time%] gave up after 72 tries >> fund-deploy.log
exit /b 1
