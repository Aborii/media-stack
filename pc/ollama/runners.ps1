# What the PC scripts share about Ollama's processes: finding the runners
# under a server, telling a loaded model from Ollama's own GPU check, and
# killing a process tree. Dot-sourced by run-ollama.ps1, tray.ps1,
# install.ps1 and uninstall.ps1; tested in runners.Tests.ps1.

# An Ollama server checks the GPU as it starts by running a llama-server of
# its own: in its logs the check begins within 0.2 s of the server and is over
# about 3 s later. That is not a model: counted as one, it made the subtitle
# Ollama yield to a paperless Ollama that had only just started, and the tray
# show "Working" for a moment. A runner counts as a model unless it started
# within GpuCheckSeconds of its server and has not yet lived
# GpuCheckLifeSeconds. Kept tight on purpose: a real model loaded in a
# server's first seconds is hidden that long, and the subtitle Ollama would
# keep the GPU while paperless sizes it.
$GpuCheckSeconds = 5
$GpuCheckLifeSeconds = 5

# Every llama-server under a server: models and GPU checks alike, for killing.
# Count them as @(Get-Runners ...).Count: PowerShell unwraps a one-item array
# on return, and .Count on a single process object is empty in Windows
# PowerShell 5.1, so one runner would read as none (runners.Tests.ps1).
function Get-Runners([int]$serverPid) {
  @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe' AND ParentProcessId=$serverPid" -ErrorAction SilentlyContinue)
}

# The runners under a server that hold a model: Get-Runners less a GPU check.
# Times are compared in UTC, so a clock change cannot stretch the windows.
function Get-ModelRunners([int]$serverPid, [datetime]$now = (Get-Date)) {
  $runners = @(Get-Runners $serverPid)
  if ($runners.Count -eq 0) { return @() }
  $server = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -ErrorAction SilentlyContinue | Select-Object -First 1
  $nowUtc = $now.ToUniversalTime()
  @($runners | Where-Object {
      if (-not $_.CreationDate -or -not $server -or -not $server.CreationDate) { return $true }
      $born = $_.CreationDate.ToUniversalTime()
      $early = ($born - $server.CreationDate.ToUniversalTime()).TotalSeconds -lt $GpuCheckSeconds
      $young = ($nowUtc - $born).TotalSeconds -lt $GpuCheckLifeSeconds
      -not ($early -and $young)
    })
}

# The server listening on that port, or nothing.
function Get-OllamaServer([int]$port) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

# True when the Ollama listening on that port has a model loaded.
function Test-Loaded([int]$onPort) {
  $server = Get-OllamaServer $onPort
  return [bool]($server -and @(Get-ModelRunners $server.OwningProcess).Count -gt 0)
}

# Kills a process and everything under it. These scripts run with
# $ErrorActionPreference 'Stop', and in Windows PowerShell 5.1 a native
# command's error output, redirected into PowerShell under 'Stop', ends the
# script. taskkill writes one whenever the process already exited, as a GPU
# check or a tree killed a moment earlier often has; that stopped
# run-ollama.ps1 for good until its task started it again. So here, and only
# here, errors only continue. taskkill is named by its full path: install.ps1
# runs elevated from any folder, and a taskkill there must not run instead.
# Says nothing; callers check whether what they killed is gone.
function Stop-Tree([int]$id) {
  $ErrorActionPreference = 'Continue'
  & "$env:SystemRoot\System32\taskkill.exe" /PID $id /T /F 2>&1 | Out-Null
}
