@echo off
REM Devnet fund-and-deploy loop for skim_protocol.
REM Retries the throttled devnet faucet; deploys once balance covers rent (~2.29 SOL).
REM Logs to fund-deploy.log. Exits after deploy (or after 72 tries = ~6h).
setlocal EnableDelayedExpansion
cd /d D:\ai-studio\skim-protocol
echo [%date% %time%] fund-deploy loop started >> fund-deploy.log
for /L %%i in (1,1,72) do (
  set BALSTR=
  for /f "tokens=1" %%s in ('solana balance --keypair keys\deployer-devnet.json --url devnet 2^>nul') do set BALSTR=%%s
  echo [%date% %time%] try %%i balance=!BALSTR! >> fund-deploy.log
  if "!BALSTR!" NEQ "" if !BALSTR! GEQ 3 (
    echo [%date% %time%] FUNDED (!BALSTR! SOL) - deploying >> fund-deploy.log
    solana program deploy target\deploy\skim_protocol.so --program-id target\deploy\skim_protocol-keypair.json --url devnet --keypair keys\deployer-devnet.json >> fund-deploy.log 2>&1
    echo [%date% %time%] deploy attempt done, verifying >> fund-deploy.log
    solana program show EbRLUsTwqTtMi2M9keQCgkaspNUi1JCBMuVb5v5MjTnJ --url devnet >> fund-deploy.log 2>&1
    exit /b 0
  )
  solana airdrop 1 PDvLyuHBXA2qcHySMzE9bE8f89nDGx6nFceGhVDdH4M --url devnet >> fund-deploy.log 2>&1
  timeout /t 300 /nobreak >nul
)
echo [%date% %time%] gave up after 72 tries >> fund-deploy.log
exit /b 1
