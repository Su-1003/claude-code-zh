@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 供计划任务调用：只在扩展版本变化时才重新汉化
call "%~dp0_node.cmd" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] 找不到 node，跳过 >> guard.log
  exit /b 1
)

"%NODE_EXE%" claude-zh.js guard >> guard.log 2>&1
"%NODE_EXE%" claude-zh.js verify >> guard.log 2>&1
