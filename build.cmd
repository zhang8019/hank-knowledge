@echo off
rem Windows 构建入口：不依赖终端 PATH，自动探测 Node 后执行构建。
rem 用法：双击 或 在项目根目录运行 build.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1"
exit /b %ERRORLEVEL%