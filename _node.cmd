@echo off
rem 找一个能用的 node.exe，结果放到 NODE_EXE（找不到就留空）
set "NODE_EXE="

where node >nul 2>nul && for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"

if not defined NODE_EXE for %%P in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%LOCALAPPDATA%\fnm_multishells\*\node.exe"
  "%APPDATA%\nvm\node.exe"
  "%NVM_HOME%\node.exe"
  "%LOCALAPPDATA%\Volta\bin\node.exe"
  "%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
  "%USERPROFILE%\scoop\apps\nodejs-lts\current\node.exe"
  "%LOCALAPPDATA%\Microsoft\WindowsApps\node.exe"
) do if not defined NODE_EXE if exist "%%~P" set "NODE_EXE=%%~P"

if not defined NODE_EXE (
  echo.
  echo 没找到 node.exe。汉化脚本需要 Node.js。
  echo 装一个：https://nodejs.org/  ^(LTS 版本即可^)，装完重开这个窗口再试。
  echo 如果装在别处，可以直接把 node.exe 的完整路径告诉我。
  echo.
  exit /b 1
)
exit /b 0
