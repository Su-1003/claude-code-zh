@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   Claude Code 汉化 - 重新应用
echo   扩展更新后跑一次即可
echo ========================================
echo.

call "%~dp0_node.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)

"%NODE_EXE%" claude-zh.js apply --yes
if errorlevel 1 goto fail

echo.
echo ---- 语法自检 ----
"%NODE_EXE%" claude-zh.js verify
if errorlevel 1 goto fail

echo.
echo 完成。请在 VS Code 里按 Ctrl+Shift+P 执行
echo     Developer: Reload Window
echo.
pause
exit /b 0

:fail
echo.
echo 出错了。如需回到未改状态，执行：
echo     node claude-zh.js restore
echo.
pause
exit /b 1
