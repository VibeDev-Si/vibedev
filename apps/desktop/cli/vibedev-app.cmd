@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
rem VibeDev fork: the Harness home defaults to .vibedev-app in the user profile, as in the Desktop app.
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.vibedev-app"
"%~dp0..\..\..\..\VibeDev.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
