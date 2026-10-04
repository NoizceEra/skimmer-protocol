Set sh = CreateObject("WScript.Shell")
' Detached launch: outlives the parent shell, hidden window, logs to bot.log
sh.Run "cmd /c cd /d D:\ai-studio\skim-protocol\bots\telegram && node dist\bot.js >> bot.log 2>&1", 0, False
