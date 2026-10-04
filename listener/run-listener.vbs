Set sh = CreateObject("WScript.Shell")
' Detached launch for skim-listener (devnet test). Logs to listener.log
sh.Run "cmd /c cd /d D:\ai-studio\skim-protocol\listener && node dist/server.js >> listener.log 2>&1", 0, False
