@echo off
cd "C:\Users\john\Documents\GitHub\go-faster-leaderboard"
rem check if admin priviliges
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Admin rights confirmed
) else (
    rem relaunch as admin
    echo Relaunching as admin...
    pwsh -Command "Start-Process '%0' -Verb RunAs"
    exit /b
)
go build -o go-faster-leaderboard.exe .
set GOARCH=amd64
set GOOS=linux
go build -o go-faster-leaderboard .