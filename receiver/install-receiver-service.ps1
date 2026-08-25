<#
    Registers the backup receiver to start at boot, without anyone logging in.

    RUN THIS ELEVATED (right-click PowerShell > Run as administrator):

        powershell -ExecutionPolicy Bypass -File D:\Backups\pi\install-receiver-service.ps1

    WHY IT RUNS AS SYSTEM

    "Start without login" rules out a task running as your own account, because
    that needs your password stored in the task. That leaves a service account.

    The obvious safer pick, LOCAL SERVICE, does not work here: node.exe grants
    access only to SYSTEM, Administrators and you, so it would need an ACL change
    on the Node binary - and nvm repoints C:\nvm4w\nodejs at a different folder
    every time you switch Node versions, which would silently strip that grant
    and stop the receiver from ever starting again.

    So: SYSTEM. The honest trade-off is that a bug in the receiver would be a bug
    running with full machine privilege. What limits it is that the receiver
    binds only to the Tailscale address, never extracts an archive, executes
    nothing, and serves nothing back out.

    To undo all of this:

        Unregister-ScheduledTask -TaskName 'Pi Backup Receiver' -Confirm:$false
#>
[CmdletBinding()]
param(
    [string]$Dir      = 'D:\Backups\pi',
    [string]$TaskName = 'Pi Backup Receiver',
    [string]$Node     = 'C:\nvm4w\nodejs\node.exe'
)

$ErrorActionPreference = 'Stop'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Error "Run this from an elevated PowerShell."; exit 1 }

$script = Join-Path $Dir 'backup-receiver.js'
$key    = Join-Path $Dir 'receiver.key'
foreach ($f in @($script, $key, $Node)) {
    if (-not (Test-Path $f)) { Write-Error "missing: $f"; exit 1 }
}

# The key was locked to the interactive user, with inheritance switched off.
# SYSTEM has to be able to read it or the receiver exits on startup.
Write-Host "granting SYSTEM read on receiver.key"
$acl = Get-Acl $key
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    'NT AUTHORITY\SYSTEM', 'Read', 'Allow')))
Set-Acl -Path $key -AclObject $acl

# A hand-started copy still holds port 8899, and the task would fail to bind.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*backup-receiver.js*' } |
    ForEach-Object {
        Write-Host "stopping existing receiver (pid $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Seconds 2

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "replacing the existing task"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action  = New-ScheduledTaskAction -Execute $Node -Argument "`"$script`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$princ   = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# ExecutionTimeLimit 0 because this is a server and is supposed to run forever;
# the default kills it after three days. RestartCount covers it dying for any
# reason - the receiver already retries its own bind, but a crash needs the
# scheduler to bring it back.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $princ -Settings $settings `
    -Description 'Receives the Raspberry Pi nightly backup archive over Tailscale.' | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

Write-Host ""
Write-Host "task state : $((Get-ScheduledTask -TaskName $TaskName).State)"
$conn = Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Write-Host "listening  : $($conn.LocalAddress):$($conn.LocalPort)" }
else       { Write-Host "listening  : not yet - check the log below" }
Write-Host ""
Get-Content (Join-Path $Dir 'receiver.log') -Tail 3
