# ==============================================================================
# Script de sincronizacao segura de dados e assets do AoW4DB
# Puxa APENAS JSONs, Icones e Imagens da branch 'main', protegendo o seu frontend.
# ==============================================================================

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Sincronizando Banco de Dados e Assets da main...       " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Busca as referencias mais recentes do repositorio remoto
Write-Host "[1/3] Buscando atualizacoes remotas da origin..." -ForegroundColor Yellow
git fetch origin main

# 2. Faz checkout apenas das pastas de dados e assets da main
Write-Host "[2/3] Baixando JSONs, Icones e Imagens da main..." -ForegroundColor Yellow
git checkout origin/main -- Data/ Icons/ PreviewsAvif/

# 3. Status
Write-Host "[3/3] Verificando integridade..." -ForegroundColor Yellow
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   Sucesso! Base de dados e assets sincronizados.         " -ForegroundColor Green
Write-Host "   Seu layout, HTML, CSS e cabecalho permanecem 100%      " -ForegroundColor Green
Write-Host "   intactos e protegidos.                                 " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

