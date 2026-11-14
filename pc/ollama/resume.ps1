# Undoes pause.ps1. Ollama starts again within a few seconds, unless
# storychat still has the GPU, in which case it starts when the chat model
# unloads. paperless-gpt on the mini notices within a minute and carries on.
param([string]$Base = 'I:\AI\ollama')

$ErrorActionPreference = 'Stop'
$pauseDir = Join-Path $Base 'pause'
Remove-Item -LiteralPath (Join-Path $pauseDir 'user') -Force -ErrorAction SilentlyContinue

$others = @(Get-ChildItem -LiteralPath $pauseDir -File -ErrorAction SilentlyContinue | ForEach-Object Name)
if ($others.Count -gt 0) {
  Write-Host "AI resumed, but still waiting on: $($others -join ', ')."
} else {
  Write-Host 'AI resumed.'
}
if ($Host.Name -eq 'ConsoleHost') { Start-Sleep -Seconds 3 }
