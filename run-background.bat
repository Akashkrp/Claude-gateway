@echo off
cd /d "%~dp0"
node server.js > gateway.log 2>&1
