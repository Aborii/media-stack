# Pauses the AI on the PC so the GPU is free, for a game or anything else:
# Ollama stops, and storychat-server unloads the chat model and loads nothing
# until resumed. The documents paperless-gpt has not read yet wait on the
# mini until then. Takes effect within a few seconds.
#
#   pause.ps1              until resume.ps1
#   pause.ps1 -Hours 3     for three hours, then it resumes by itself
param(
  [double]$Hours = 0,
  [string]$Base = 'I:\AI\ollama',
  # KoboldCpp's port: the chat model holds the GPU while it listens.
  [int]$ChatPort = 5001
)

$ErrorActionPreference = 'Stop'
$pauseDir = Join-Path $Base 'pause'
New-Item -ItemType Directory -Force -Path $pauseDir | Out-Null
$file = Join-Path $pauseDir 'user'

if ($Hours -gt 0) {
  $until = (Get-Date).AddHours($Hours)
  # Round-trip format, so run-ollama.ps1 reads it back the same on any locale.
  $until.ToString('o') | Set-Content -LiteralPath $file -Encoding ascii
  Write-Host "AI paused until $($until.ToString('ddd HH:mm'))."
} else {
  '' | Set-Content -LiteralPath $file -Encoding ascii
  Write-Host 'AI paused until you resume it.'
}

# Wait for the GPU to be handed back, so a game started right after gets it.
function Test-ChatLoaded { [bool](Get-NetTCPConnection -LocalPort $ChatPort -State Listen -ErrorAction SilentlyContinue) }
$deadline = (Get-Date).AddSeconds(30)
while (((Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue) -or (Test-ChatLoaded)) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
}
if (Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue) {
  Write-Host 'Ollama is still running. Is the "ollama" task running? Check I:\AI\ollama\run-ollama.log.'
} elseif (Test-ChatLoaded) {
  Write-Host 'The chat model is still loaded. Is the "storychat-server" task running? Check its storychat-server.log.'
} else {
  Write-Host 'Every model is stopped; the GPU is free.'
}
# Opened from the shortcut, the window would close before it could be read.
if ($Host.Name -eq 'ConsoleHost') { Start-Sleep -Seconds 3 }
