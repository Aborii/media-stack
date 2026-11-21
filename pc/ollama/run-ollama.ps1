# Keeps one Ollama running on the PC for the mini, except while something has
# paused it. There are two, each started by its own task at boot and every 5
# minutes (the task's "ignore new instance" setting makes the repeat a crash
# restart only):
#   paperless  task "ollama", port 11434: paperless-gpt's reading and naming
#   subtitles  task "ollama-subtitles", port 11435: subfill's translation
# Both share the download, the models folder and the pause folder; each has
# its own switch, logs and request log. -Name picks which; paperless keeps the
# file names it had before there were two.
#
# Paused means any file in the pause folder, for both:
#   user       - pause.ps1, for gaming or anything else that wants the GPU.
#                It may hold an "until" time; past it, the file is removed.
#   storychat  - storychat-server, while its chat model is loaded.
# The tray icon's "... models can load" switch, when off, writes off\<name>,
# which pauses that one only, until it is switched back on. And -YieldPort:
# while the Ollama on that port has a model loaded, this one stays stopped.
# Subtitles yields to paperless that way, so the GPU's order is the chat
# model, then paperless, then subtitles.
# While paused, Ollama is stopped, which frees the GPU at once. The mini sees
# nothing answering: paperless-gpt is stopped by its gate, so its documents
# wait with their "ai-new" tag, and subfill's PC node goes offline and hands
# its episode back to the queue.
#
# unload\<name> is the tray's "Unload the ... model now": the model runner is
# killed mid-work and the file removed. Ollama stays up; the next request
# loads the model again. subfill does a cut-off batch again; paperless-gpt
# does not retry a cut-off document (rerun-ai.py does).
param(
  [string]$Base = 'I:\AI\ollama',
  [string]$Listen = '10.10.10.1:11434',
  [ValidatePattern('^[a-z]+$')]
  [string]$Name = 'paperless',
  # The Ollama this one gives the GPU to, by its port and its name.
  [int]$YieldPort = 0,
  [ValidatePattern('^[a-z]+$')]
  [string]$YieldName = 'paperless'
)

$ErrorActionPreference = 'Stop'
# Get-Runners, Get-ModelRunners, Test-Loaded and Stop-Tree.
. (Join-Path $PSScriptRoot 'runners.ps1')
$exe = Join-Path $Base 'ollama.exe'
$port = [int]($Listen -split ':')[-1]
$tag = if ($Name -eq 'paperless') { '' } else { "-$Name" }
$pauseDir = Join-Path $Base 'pause'
$offFile = Join-Path $Base "off\$Name"
$unloadFile = Join-Path $Base "unload\$Name"
# The yield holds this long after the other Ollama's model last showed, so the
# moment between its two models (it unloads one before loading the next) does
# not start this one only for it to be stopped again.
$yieldHoldSeconds = 30
$yieldSeen = [datetime]::MinValue
$yieldReason = "the $YieldName Ollama is working"
$log = Join-Path $Base "run-ollama$tag.log"
$serveLog = Join-Path $Base "ollama$tag-serve.log"
# Ollama writes one [GIN] line per request to stdout: when, status, how long,
# from where. Start-Process can only overwrite, so before each start the last
# run's lines are moved into the history, which the tray icon reads.
$requestLog = Join-Path $Base "ollama$tag-requests.log"
$requestHistory = Join-Path $Base "ollama$tag-requests-history.log"
New-Item -ItemType Directory -Force -Path $pauseDir, (Join-Path $Base 'models'), (Split-Path $offFile), (Split-Path $unloadFile) | Out-Null

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
# Every Ollama prunes the models folder's unused files when it starts. The two
# share that folder, and the second restarts after every pause and yield; a
# prune landing during a pull through the first could delete a layer not yet
# in a manifest. Only paperless pulls (install.ps1), so only it prunes.
if ($Name -ne 'paperless') { $env:OLLAMA_NOPRUNE = '1' }

function Stop-Ollama {
  # This copy only: the other Ollama on the PC keeps running. Its server is
  # the one this script started, or whatever still listens on its port (one
  # left by a stopped task). The server starts a runner per loaded model, and
  # that runner holds the GPU memory, so the whole tree goes, not just the server.
  $ids = @()
  if ($script:proc -and -not $script:proc.HasExited) { $ids += $script:proc.Id }
  $ids += @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object OwningProcess)
  foreach ($id in ($ids | Select-Object -Unique)) { Stop-Tree $id }
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
  if (Test-Path -LiteralPath $offFile) { $reasons += "$Name models switched off" }
  if ($YieldPort -gt 0) {
    if (Test-Loaded $YieldPort) {
      $script:yieldSeen = Get-Date
      $reasons += $yieldReason
    } elseif (((Get-Date) - $script:yieldSeen).TotalSeconds -lt $yieldHoldSeconds) {
      $reasons += "the $YieldName Ollama was working moments ago"
    }
  }
  return $reasons
}

# Kills the runner holding the loaded model, not the server itself.
function Stop-Runner([int]$serverPid) {
  $runners = @(Get-Runners $serverPid)
  foreach ($r in $runners) { Stop-Tree $r.ProcessId }
  return $runners.Count
}

# An Ollama left from a stopped task (stopping the task ends this script but
# not its child) is a stale copy: start clean.
Stop-Ollama
Write-Log "Started ($Name). Listening on $Listen when not paused$(if ($YieldPort) { "; stops while port $YieldPort has a model loaded" })."

$proc = $null
$lastStart = [datetime]::MinValue
$wasPaused = $null
$lastError = $null
while ($true) {
  # An error in one turn is logged and the next turn goes on. Unhandled, it
  # ended this script, and with it the yield, the pause and the switches,
  # until the task's 5-minute check started it again.
  try {
    $reasons = @(Get-PauseReasons)
    $paused = $reasons.Count -gt 0
    $running = $proc -and -not $proc.HasExited

    if (Test-Path -LiteralPath $unloadFile) {
      Remove-Item -LiteralPath $unloadFile -Force -ErrorAction SilentlyContinue
      $killed = if ($running) { Stop-Runner $proc.Id } else { 0 }
      if ($killed -gt 0) { Write-Log "Unloaded the $Name model, as asked (the tray icon)." }
      else { Write-Log "Asked to unload the $Name model, but none was loaded." }
    }

    if ($paused -ne $wasPaused) {
      if ($paused) { Write-Log "Paused by: $($reasons -join ', ')." } else { Write-Log 'Not paused.' }
      $wasPaused = $paused
    }

    if ($paused -and $running) {
      # Yielding with a model loaded means the other Ollama measured the GPU
      # while this one still filled it, and put part of its model on the CPU.
      # It is left to finish that way, slower: killing its runner to load again
      # on the freed GPU would fail the request it is working on, and
      # paperless-gpt does not retry a reading (OCR_MAX_RETRIES 1). It unloads
      # after 2 minutes idle, so its next load has the whole GPU.
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
    $lastError = $null
  } catch {
    # Once per new error, so one that repeats every turn does not fill the log.
    $message = $_.Exception.Message
    if ($message -ne $lastError) { Write-Log "Error, carrying on: $message" }
    $lastError = $message
  }
  Start-Sleep -Seconds 2
}
