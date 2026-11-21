# One-time setup of the two Ollamas on the PC for the mini: paperless-gpt's
# (reading and naming documents) and subfill's (translating subtitles). Run
# from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File I:\Projects\media-stack\pc\ollama\install.ps1
#
# It is safe to run again: the download and the models are kept, the tasks,
# the firewall rules and the shortcuts are replaced.
#
#  1. Downloads Ollama (the standalone build, no tray app) into I:\AI\ollama.
#  2. Registers two tasks, each running run-ollama.ps1 as you at boot, signed
#     in or not (no stored password), restarted every 5 min if it died:
#       "ollama"            paperless, port 11434
#       "ollama-subtitles"  subtitles, port 11435; stopped while paperless has
#                           a model loaded (run-ollama.ps1 -YieldPort)
#  3. Lets the mini (10.10.10.3) reach those two ports, and nothing else.
#  4. Adds "Pause AI" and "Resume AI" to the Start menu and the desktop, and
#     the tray icon (tray.ps1) to the Startup folder, starting it now.
#  5. Starts both and pulls the models: paperless-gpt's two, and subfill's
#     translategemma:12b (about 8 GB). Both Ollamas read the one models folder.
param(
  [string]$Version = 'v0.40.13',
  [string]$Base = 'I:\AI\ollama',
  [string]$Listen = '10.10.10.1:11434',
  [string]$SubtitlesListen = '10.10.10.1:11435',
  [string]$MiniAddress = '10.10.10.3',
  [string[]]$Models = @('qwen2.5vl:7b', 'qwen2.5:14b'),
  [string[]]$SubtitleModels = @('translategemma:12b')
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated (Administrator) PowerShell.'
}
$here = $PSScriptRoot
# Stop-Tree, which kills without letting taskkill's complaints stop this script.
. (Join-Path $here 'runners.ps1')
$exe = Join-Path $Base 'ollama.exe'
$port = [int]($Listen -split ':')[-1]
$subtitlesPort = [int]($SubtitlesListen -split ':')[-1]

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
    ForEach-Object { Stop-Tree $_.Id }
  Expand-Archive -LiteralPath $zip -DestinationPath $Base -Force
  Remove-Item -LiteralPath $zip -Force
  $Version | Set-Content -LiteralPath $stamp -Encoding ascii
}

Write-Host '2. Tasks "ollama" and "ollama-subtitles"'
$run = Join-Path $here 'run-ollama.ps1'
# S4U: runs as this user whether or not anyone is signed in, without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
foreach ($t in @(
    @{ Name = 'ollama'; Args = "-Listen $Listen"; Tip = 'Ollama for paperless-gpt on the mini; stops while paused.' },
    @{ Name = 'ollama-subtitles'; Args = "-Name subtitles -Listen $SubtitlesListen -YieldPort $port -YieldName paperless"
       Tip = "Ollama for subfill's subtitles on the mini; stops while paused or while paperless's Ollama works." }
  )) {
  # A running copy keeps the script it started with: re-registering does not
  # end it, and starting the task again does nothing while it runs. So it is
  # stopped here, and step 5 starts the new one, whose first act clears any
  # Ollama the old one left on its port.
  Stop-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$run`" -Base `"$Base`" $($t.Args)" -WorkingDirectory $Base
  $triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
  )
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $triggers -Principal $principal `
    -Settings $settings -Description $t.Tip -Force | Out-Null
}

Write-Host "3. Firewall: ports $port and $subtitlesPort from $MiniAddress only"
foreach ($r in @(@{ Name = 'ollama (from the mini)'; Port = $port }, @{ Name = 'ollama subtitles (from the mini)'; Port = $subtitlesPort })) {
  Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $r.Port -RemoteAddress $MiniAddress -Profile Any | Out-Null
}

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
# The tray icon, at every sign-in. conhost --headless runs PowerShell with no
# console window at all; -WindowStyle Hidden would still flash one.
$tray = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'AI tray.lnk'))
$tray.TargetPath = Join-Path $env:SystemRoot 'System32\conhost.exe'
$tray.Arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'tray.ps1')`" -Base `"$Base`" -Url http://$Listen -SubtitlesUrl http://$SubtitlesListen"
$tray.WorkingDirectory = $Base
$tray.Description = 'Tray icon: is the AI on this PC running, paused or off'
$tray.IconLocation = "$exe,0"
$tray.Save()
# An icon already running would keep the old script (a second one exits at
# once, one per session), so it is ended first and the new one started.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'tray\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Through Explorer, so it runs as you and not elevated like this script.
Start-Process explorer.exe -ArgumentList "`"$($tray.FullName)`""

Write-Host '5. Starting'
Start-ScheduledTask -TaskName 'ollama'
Start-ScheduledTask -TaskName 'ollama-subtitles'
$env:OLLAMA_HOST = $Listen
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Seconds 2
  try { $up = (Invoke-WebRequest -Uri "http://$Listen/api/version" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $up = $false }
} until ($up -or (Get-Date) -gt $deadline)
if (-not $up) {
  Write-Host "Not done: Ollama is not answering on $Listen, so no models were downloaded. Is it paused, or the cable out? Log: $Base\run-ollama.log" -ForegroundColor Red
  exit 1
}
# Pulled through the paperless Ollama; the subtitles one reads the same
# models folder, so it sees them too. A few tries each: the first install hit
# a moment where the registry's name did not resolve, and every pull failed.
# A model already there is only checked, so running this again costs little;
# with no internet that check fails too, so a model the Ollama already has is
# kept as it is rather than counted as missing. Asked over HTTP: a native
# command's error output would stop this script ($ErrorActionPreference).
function Test-ModelThere([string]$model) {
  try {
    $body = @{ model = $model } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "http://$Listen/api/show" -Body $body -ContentType 'application/json' -TimeoutSec 10 | Out-Null
    return $true
  } catch { return $false }
}
$failed = @()
foreach ($m in $Models + $SubtitleModels) {
  $pulled = $false
  for ($try = 1; $try -le 3 -and -not $pulled; $try++) {
    if ($try -gt 1) {
      Write-Host "   Trying $m again in 15 s ($try of 3)"
      Start-Sleep -Seconds 15
    }
    Write-Host "   Pulling $m"
    & $exe pull $m
    $pulled = $LASTEXITCODE -eq 0
  }
  if ($pulled) { continue }
  if (Test-ModelThere $m) {
    Write-Host "   $m is already here; it could not be checked for a newer version." -ForegroundColor Yellow
  } else {
    $failed += $m
  }
}
if ($failed.Count -gt 0) {
  Write-Host "Not done: could not download $($failed -join ', '). Check the PC's internet, then run this again; it keeps what is there." -ForegroundColor Red
  exit 1
}
Write-Host 'Done. "Pause AI" on the desktop frees the GPU; "Resume AI" gives it back.'
