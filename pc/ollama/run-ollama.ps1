# Keeps Ollama running on the PC for paperless-gpt on the mini, except while
# something has paused it. Task "ollama" starts this at boot and every 5
# minutes; the task's "ignore new instance" setting makes the repeat a crash
# restart only.
#
# Paused means any file in the pause folder:
#   user       - pause.ps1, for gaming or anything else that wants the GPU.
#                It may hold an "until" time; past it, the file is removed.
#   storychat  - storychat-server, while its chat model is loaded.
# While paused, Ollama is stopped, which frees the GPU at once. paperless-gpt
# on the mini sees nothing answering and is stopped there by its gate, so its
# documents wait with their "ai-new" tag rather than failing.
param(
  [string]$Base = 'I:\AI\ollama',
  [string]$Listen = '10.10.10.1:11434'
)

$ErrorActionPreference = 'Stop'
$exe = Join-Path $Base 'ollama.exe'
$pauseDir = Join-Path $Base 'pause'
$log = Join-Path $Base 'run-ollama.log'
$serveLog = Join-Path $Base 'ollama-serve.log'
# Ollama writes one [GIN] line per request to stdout: when, status, how long,
# from where. Start-Process can only overwrite, so before each start the last
# run's lines are moved into the history, which the tray icon reads.
$requestLog = Join-Path $Base 'ollama-requests.log'
$requestHistory = Join-Path $Base 'ollama-requests-history.log'
New-Item -ItemType Directory -Force -Path $pauseDir, (Join-Path $Base 'models') | Out-Null

function Write-Log([string]$message) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" | Out-File -FilePath $log -Append -Encoding utf8
}

if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) {
  Move-Item -LiteralPath $log -Destination "$log.1" -Force
}

$env:OLLAMA_HOST = $Listen
$env:OLLAMA_MODELS = Join-Path $Base 'models'
# One model at a time, unloaded soon after its last request: the GPU is shared
# with games and with storychat, and the reading and naming models together
# would take most of its 12 GB.
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_KEEP_ALIVE = '2m'

function Stop-Ollama {
  # The server starts a runner process per loaded model; that runner is what
  # holds the GPU memory, so every ollama process goes, not just the server.
  Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue |
    ForEach-Object { & taskkill.exe /PID $_.Id /T /F 2>&1 | Out-Null }
}

function Save-RequestHistory {
  # ollama-serve.log.out is where requests went before they had their own log.
  foreach ($file in "$serveLog.out", $requestLog) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    Get-Content -LiteralPath $file -ErrorAction SilentlyContinue |
      Where-Object { $_.StartsWith('[GIN]') } |
      Add-Content -LiteralPath $requestHistory -Encoding utf8
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
  if ((Test-Path -LiteralPath $requestHistory) -and (Get-Item -LiteralPath $requestHistory).Length -gt 5MB) {
    Move-Item -LiteralPath $requestHistory -Destination "$requestHistory.1" -Force
  }
}

function Get-PauseReasons {
  $reasons = @()
  foreach ($file in Get-ChildItem -LiteralPath $pauseDir -File -ErrorAction SilentlyContinue) {
    $until = (Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue | Select-Object -First 1)
    $when = [datetime]::MinValue
    if ($until -and [datetime]::TryParse($until, [ref]$when) -and $when -lt (Get-Date)) {
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
      Write-Log "Pause '$($file.Name)' ran out at $until."
      continue
    }
    $reasons += $file.Name
  }
  return $reasons
}

# An Ollama left from a stopped task (stopping the task ends this script but
# not its child) is a stale copy: start clean.
Stop-Ollama
Write-Log "Started. Listening on $Listen when not paused."

$proc = $null
$lastStart = [datetime]::MinValue
$wasPaused = $null
while ($true) {
  $reasons = @(Get-PauseReasons)
  $paused = $reasons.Count -gt 0
  $running = $proc -and -not $proc.HasExited

  if ($paused -ne $wasPaused) {
    if ($paused) { Write-Log "Paused by: $($reasons -join ', ')." } else { Write-Log 'Not paused.' }
    $wasPaused = $paused
  }

  if ($paused -and $running) {
    Stop-Ollama
    $proc = $null
    Write-Log 'Stopped Ollama; the GPU is free.'
  } elseif (-not $paused -and -not $running) {
    if ($proc) {
      Write-Log "Ollama exited (code $($proc.ExitCode)); see ollama-serve.log."
      $proc = $null
    }
    # Not more than once every 30 s: with the cable unplugged the address is
    # missing, and Ollama exits straight away until it is back.
    if (((Get-Date) - $lastStart).TotalSeconds -ge 30) {
      if (Test-Path -LiteralPath $serveLog) { Move-Item -LiteralPath $serveLog -Destination "$serveLog.1" -Force }
      Save-RequestHistory
      $proc = Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
        -RedirectStandardError $serveLog -RedirectStandardOutput $requestLog
      $lastStart = Get-Date
      Write-Log "Started Ollama (pid $($proc.Id))."
    }
  }
  Start-Sleep -Seconds 2
}
