Set sh = CreateObject("WScript.Shell")
' Detached fund-and-deploy loop (devnet). Logs to fund-deploy.log
sh.Run "cmd /c D:\ai-studio\skim-protocol\scripts\fund-deploy-devnet.bat", 0, False
