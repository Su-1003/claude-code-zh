@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   Claude Code 汉化 - 扫描未翻译的界面文案
echo ========================================
echo.

call "%~dp0_node.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)

"%NODE_EXE%" claude-zh.js scan > scan-log.txt 2>&1
type scan-log.txt

echo.
echo 明细已写入 scan-report.json / scan-report.txt
echo.
pause
