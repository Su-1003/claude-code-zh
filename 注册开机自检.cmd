@echo off
chcp 65001 >nul

echo ========================================
echo   注册「登录时自动检查汉化」
echo ========================================
echo.
echo 每次登录 Windows 时会检查 Claude Code 扩展版本，
echo 只有版本变了才重新汉化，否则什么都不做。
echo.
echo 注意：若扩展更新时 VS Code 正开着，补丁会在下次
echo       登录时生效，期间界面可能短暂显示英文。
echo.

schtasks /Delete /TN "ClaudeCodeZhGuard" /F >nul 2>&1
schtasks /Create /TN "ClaudeCodeZhGuard" /SC ONLOGON /F /TR "\"%~dp0自检.cmd\""

if errorlevel 1 (
  echo.
  echo 注册失败。请用「管理员身份」重新运行本文件。
) else (
  echo.
  echo 注册成功。
  echo 取消注册：schtasks /Delete /TN "ClaudeCodeZhGuard" /F
)

echo.
pause
