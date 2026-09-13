@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .env (
  echo Arquivo .env nao encontrado. Copiando .env.example para .env...
  copy .env.example .env >nul
  echo Preencha o .env ^(ADMIN_PASSWORD, APP_URL, EVOLUTION_APIKEY, ANTHROPIC_API_KEY^) e rode de novo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias...
  call npm install --no-audit --no-fund
)
echo Iniciando o assistente em http://localhost:3000 ...
node src/server.js
pause
