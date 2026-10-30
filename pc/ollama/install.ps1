# One-time setup of Ollama on the PC, for paperless-gpt on the mini. Run from
# an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File I:\Projects\media-stack\pc\ollama\install.ps1
#
# It is safe to run again: the download and the models are kept, the task,
# the firewall rule and the shortcuts are replaced.
#
#  1. Downloads Ollama (the standalone build, no tray app) into I:\AI\ollama.
#  2. Registers task "ollama": runs run-ollama.ps1 as you at boot, signed in or
#     not (no stored password), restarted every 5 min if it died.
#  3. Lets the mini (10.10.10.3) reach port 11434, and nothing else.
#  4. Adds "Pause AI" and "Resume AI" to the Start menu and the desktop.
#  5. Starts it and pulls the two models paperless-gpt uses.
param(
  [string]$Version = 'v0.40.13',
  [string]$Base = 'I:\AI\ollama',
  [string]$Listen = '10.10.10.1:11434',
  [string]$MiniAddress = '10.10.10.3',
  [string[]]$Models = @('qwen2.5vl:7b', 'qwen2.5:7b')
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated (Administrator) PowerShell.'
}
$here = $PSScriptRoot
$exe = Join-Path $Base 'ollama.exe'
$port = [int]($Listen -split ':')[-1]

Write-Host "1. Ollama $Version in $Base"
New-Item -ItemType Directory -Force -Path $Base, (Join-Path $Base 'pause'), (Join-Path $Base 'models') | Out-Null
$stamp = Join-Path $Base 'VERSION'
if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp) -eq $Version)) {
  Write-Host '   Already there.'
} else {
  $zip = Join-Path $env:TEMP "ollama-windows-amd64-$Version.zip"
  $url = "https://github.com/ollama/ollama/releases/download/$Version/ollama-windows-amd64.zip"
  Write-Host "   Downloading $url (about 1.5 GB)"
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  # The whole tree: a model runner left behind keeps files under lib\ locked.
  Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue |
    ForEach-Object { & taskkill.exe /PID $_.Id /T /F 2>&1 | Out-Null }
  Expand-Archive -LiteralPath $zip -DestinationPath $Base -Force
  Remove-Item -LiteralPath $zip -Force
  $Version | Set-Content -LiteralPath $stamp -Encoding ascii
}

Write-Host '2. Task "ollama"'
$run = Join-Path $here 'run-ollama.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$run`" -Base `"$Base`" -Listen $Listen" -WorkingDirectory $Base
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
# S4U: runs as this user whether or not anyone is signed in, without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'ollama' -Action $action -Trigger $triggers -Principal $principal `
  -Settings $settings -Description 'Ollama for paperless-gpt on the mini; stops while paused.' -Force | Out-Null

Write-Host "3. Firewall: port $port from $MiniAddress only"
Get-NetFirewallRule -DisplayName 'ollama (from the mini)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'ollama (from the mini)' -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort $port -RemoteAddress $MiniAddress -Profile Any | Out-Null

Write-Host '4. Shortcuts'
$shell = New-Object -ComObject WScript.Shell
$startMenu = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($s in @(
    @{ Name = 'Pause AI'; Script = 'pause.ps1'; Tip = 'Stop Ollama and free the GPU until Resume AI' },
    @{ Name = 'Resume AI'; Script = 'resume.ps1'; Tip = 'Let Ollama read documents for Paperless again' }
  )) {
  foreach ($folder in $startMenu, $desktop) {
    $link = $shell.CreateShortcut((Join-Path $folder "$($s.Name).lnk"))
    $link.TargetPath = 'powershell.exe'
    $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here $s.Script)`" -Base `"$Base`""
    $link.WorkingDirectory = $Base
    $link.Description = $s.Tip
    $link.IconLocation = "$exe,0"
    $link.Save()
  }
}

Write-Host '5. Starting'
Start-ScheduledTask -TaskName 'ollama'
$env:OLLAMA_HOST = $Listen
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Seconds 2
  try { $up = (Invoke-WebRequest -Uri "http://$Listen/api/version" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $up = $false }
} until ($up -or (Get-Date) -gt $deadline)
if (-not $up) {
  Write-Host "   Ollama is not answering on $Listen. Is it paused, or the cable out? Log: $Base\run-ollama.log"
  return
}
foreach ($m in $Models) {
  Write-Host "   Pulling $m"
  & $exe pull $m
}
Write-Host 'Done. "Pause AI" on the desktop frees the GPU; "Resume AI" gives it back.'
