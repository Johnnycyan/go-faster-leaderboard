@echo off
cd "C:\Users\john\Documents\GitHub\go-faster-leaderboard"
echo Building frontend...
cd frontend
call npm install
call npm run build
cd ..
echo Building Go binary...
go build -o go-faster-leaderboard.exe .