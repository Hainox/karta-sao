param(
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3 не найден. Установите Python 3.10+ и повторите запуск."
}

Write-Host "Оператор САО: http://127.0.0.1:$Port/operator"
Write-Host "Демо-вход: demo@local.test / demo"
python .\server.py --host 0.0.0.0 --port $Port
