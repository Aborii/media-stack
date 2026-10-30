# Undoes install.ps1: the task, the firewall rule, the shortcuts and the
# running Ollama. The download and the models in I:\AI\ollama stay; delete
# that folder by hand to get the space back. Run from an elevated PowerShell.
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated (Administrator) PowerShell.'
}

Unregister-ScheduledTask -TaskName 'ollama' -Confirm:$false -ErrorAction SilentlyContinue
# Unregistering ends run-ollama.ps1 but not the Ollama it started. The whole
# tree goes: the model runner under it is what holds the GPU.
Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue |
  ForEach-Object { & taskkill.exe /PID $_.Id /T /F 2>&1 | Out-Null }
Get-NetFirewallRule -DisplayName 'ollama (from the mini)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
foreach ($folder in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) {
  foreach ($name in 'Pause AI', 'Resume AI') {
    Remove-Item -LiteralPath (Join-Path $folder "$name.lnk") -Force -ErrorAction SilentlyContinue
  }
}
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'AI tray.lnk') -Force -ErrorAction SilentlyContinue
# The tray icon is a powershell.exe running tray.ps1; end just that one.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'tray\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host 'Removed. The download and models are still in I:\AI\ollama.'
