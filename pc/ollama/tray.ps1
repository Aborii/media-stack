# A tray icon for the PC's Ollama: a coloured dot saying what the AI is doing,
# with Pause and Resume on its menu. Double-click toggles pause.
#
#   green   ready, nothing loaded
#   blue    reading a document (a model is loaded)
#   amber   paused by you (Pause AI, pause.ps1 or this menu)
#   purple  paused because storychat has the GPU
#   red     not answering: the "ollama" task is stopped, starting, or broken
#
# The menu also says when the mini last checked in (its gate asks every 30 s)
# and when it last sent a document, and "Show requests from the mini" lists
# them, read from Ollama's request log (see run-ollama.ps1).
#
# It only reads the state and writes the same pause file as pause.ps1;
# run-ollama.ps1 does the stopping and starting. The state comes from the
# processes and the listening port, not from asking Ollama, so the icon adds
# nothing to the request log. Started at sign-in by the "AI tray" shortcut in
# the Startup folder (install.ps1), through conhost --headless so no console
# window shows.
#
#   tray.ps1 -Status    prints the state and the mini's last requests, then exits
param(
  [string]$Base = 'I:\AI\ollama',
  [string]$Url = 'http://10.10.10.1:11434',
  [string]$MiniAddress = '10.10.10.3',
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$pauseDir = Join-Path $Base 'pause'
$userFile = Join-Path $pauseDir 'user'
# Oldest first. ollama-serve.log.out is the old name, until Ollama next starts.
$requestFiles = @('ollama-requests-history.log.1', 'ollama-requests-history.log', 'ollama-serve.log.out', 'ollama-requests.log') |
  ForEach-Object { Join-Path $Base $_ }

function Get-AiState {
  $files = @(Get-ChildItem -LiteralPath $pauseDir -File -ErrorAction SilentlyContinue)
  $user = $files | Where-Object Name -eq 'user'
  if ($user) {
    $until = Get-Content -LiteralPath $user.FullName -ErrorAction SilentlyContinue | Select-Object -First 1
    $when = [datetime]::MinValue
    if ($until -and [datetime]::TryParse($until, [ref]$when)) {
      return @{ Kind = 'paused'; Text = "Paused until $($when.ToString('ddd HH:mm'))"; Timed = $true }
    }
    return @{ Kind = 'paused'; Text = 'Paused until you resume it'; Timed = $false }
  }
  if ($files | Where-Object Name -eq 'storychat') {
    return @{ Kind = 'chat'; Text = 'Paused while storychat uses the GPU' }
  }
  if ($files.Count -gt 0) {
    return @{ Kind = 'chat'; Text = "Paused by $(($files | ForEach-Object Name) -join ', ')" }
  }
  $port = ([uri]$Url).Port
  $server = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $server) {
    return @{ Kind = 'off'; Text = 'Not running (starting, or the task is stopped)' }
  }
  # A loaded model is a llama-server runner under the Ollama that owns the port.
  $runner = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe' AND ParentProcessId=$($server.OwningProcess)" -ErrorAction SilentlyContinue
  if ($runner) {
    return @{ Kind = 'busy'; Text = 'Working: a model is loaded' }
  }
  return @{ Kind = 'ready'; Text = 'Ready for documents' }
}

# The mini's requests, oldest first, from the [GIN] lines Ollama logs.
function Get-MiniRequests([int]$Tail = 5000) {
  $invariant = [Globalization.CultureInfo]::InvariantCulture
  foreach ($file in $requestFiles) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    foreach ($line in Get-Content -LiteralPath $file -Tail $Tail -ErrorAction SilentlyContinue) {
      if ($line -notmatch '^\[GIN\] (\d{4}/\d\d/\d\d - \d\d:\d\d:\d\d) \|\s*(\d+) \|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\w+)\s+"([^"]*)"') { continue }
      if ($Matches[4] -ne $MiniAddress) { continue }
      [pscustomobject]@{
        When   = [datetime]::ParseExact($Matches[1], 'yyyy/MM/dd - HH:mm:ss', $invariant)
        Status = [int]$Matches[2]
        Took   = $Matches[3]
        Method = $Matches[5]
        Path   = $Matches[6]
      }
    }
  }
}

function Format-Ago([datetime]$when) {
  $s = ((Get-Date) - $when).TotalSeconds
  if ($s -lt 90) { return "$([int]$s) s ago" }
  if ($s -lt 5400) { return "$([int]($s / 60)) min ago" }
  return $when.ToString('ddd HH:mm')
}

function Get-RequestSummary {
  $all = @(Get-MiniRequests)
  $checks = @($all | Where-Object Path -eq '/api/tags')
  $work = @($all | Where-Object Path -ne '/api/tags')
  @{
    Checked = if ($checks) { "Mini last checked in: $(Format-Ago $checks[-1].When)" } else { 'Mini has not checked in yet' }
    Worked  = if ($work) { "Last document request: $(Format-Ago $work[-1].When) ($($work[-1].Took))" } else { 'No document requests yet' }
    All     = $all
  }
}

function Format-Request($r) {
  $what = switch -Regex ($r.Path) {
    '^/api/tags$' { 'check-in' }
    '^/api/(chat|generate)$' { 'document work' }
    default { "$($r.Method) $($r.Path)" }
  }
  $result = if ($r.Status -eq 200) { 'OK' } else { "error $($r.Status)" }
  '{0}  {1,-14} {2,10}  {3}' -f $r.When.ToString('ddd dd MMM HH:mm:ss'), $what, $r.Took, $result
}

if ($Status) {
  $s = Get-AiState
  "$($s.Kind): $($s.Text)"
  $r = Get-RequestSummary
  $r.Checked
  $r.Worked
  @($r.All | Where-Object Path -ne '/api/tags') | Select-Object -Last 5 | ForEach-Object { '  ' + (Format-Request $_) }
  return
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# One icon per user session: a second start (the shortcut run twice) just exits.
$mutex = New-Object System.Threading.Mutex($false, 'Local\paperless-ai-tray')
if (-not $mutex.WaitOne(0)) { return }

function New-DotIcon([string]$hex) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
  $g.FillEllipse($brush, 1, 1, 30, 30)
  $font = New-Object System.Drawing.Font 'Segoe UI', 11, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'
  $format.LineAlignment = 'Center'
  $g.DrawString('AI', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $format)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

# Made once and reused: each GetHicon() is a handle that is never freed.
$icons = @{
  ready  = New-DotIcon '#2e7d32'
  busy   = New-DotIcon '#1565c0'
  paused = New-DotIcon '#f9a825'
  chat   = New-DotIcon '#6a1b9a'
  off    = New-DotIcon '#c62828'
}

function Set-Pause([double]$hours) {
  New-Item -ItemType Directory -Force -Path $pauseDir | Out-Null
  # Same file and format as pause.ps1: empty means until resumed.
  $text = if ($hours -gt 0) { (Get-Date).AddHours($hours).ToString('o') } else { '' }
  $text | Set-Content -LiteralPath $userFile -Encoding ascii
  Update-Tray
}

function Clear-Pause {
  Remove-Item -LiteralPath $userFile -Force -ErrorAction SilentlyContinue
  Update-Tray
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$header = $menu.Items.Add('...')
$header.Enabled = $false
$checkedItem = $menu.Items.Add('...')
$checkedItem.Enabled = $false
$workedItem = $menu.Items.Add('...')
$workedItem.Enabled = $false
$requestsItem = $menu.Items.Add('Show requests from the mini...')
[void]$menu.Items.Add('-')
$pauseItem = $menu.Items.Add('Pause until I resume')
$pause1Item = $menu.Items.Add('Pause for 1 hour')
$pause3Item = $menu.Items.Add('Pause for 3 hours')
$resumeItem = $menu.Items.Add('Resume')
[void]$menu.Items.Add('-')
$logItem = $menu.Items.Add('Open the start and stop log')
$exitItem = $menu.Items.Add('Hide this icon')

# A live list of the mini's requests, newest first, refreshed while it is
# open. One window, made once and hidden on close, so its handlers can use the
# script's functions and variables directly.
$req = @{}
$req.Form = New-Object System.Windows.Forms.Form
$req.Form.Text = 'Requests from the mini'
$req.Form.Size = New-Object System.Drawing.Size 640, 520
$req.Form.StartPosition = 'CenterScreen'
$req.Form.Icon = $icons.ready
$req.Summary = New-Object System.Windows.Forms.Label
$req.Summary.Dock = 'Top'
$req.Summary.Height = 44
$req.Summary.Padding = New-Object System.Windows.Forms.Padding 8, 6, 8, 0
$req.Checks = New-Object System.Windows.Forms.CheckBox
$req.Checks.Text = 'Include the 30-second check-ins'
$req.Checks.Dock = 'Top'
$req.Checks.Padding = New-Object System.Windows.Forms.Padding 8, 0, 0, 0
$req.List = New-Object System.Windows.Forms.TextBox
$req.List.Multiline = $true
$req.List.ReadOnly = $true
$req.List.ScrollBars = 'Vertical'
$req.List.WordWrap = $false
$req.List.Dock = 'Fill'
$req.List.Font = New-Object System.Drawing.Font 'Consolas', 10
$req.Form.Controls.AddRange(@($req.List, $req.Checks, $req.Summary))
$req.Timer = New-Object System.Windows.Forms.Timer
$req.Timer.Interval = 5000

function Update-Requests {
  $r = Get-RequestSummary
  $req.Summary.Text = "$($r.Checked)`r`n$($r.Worked)"
  $shown = if ($req.Checks.Checked) { $r.All } else { @($r.All | Where-Object Path -ne '/api/tags') }
  $lines = @($shown | Select-Object -Last 300 | ForEach-Object { Format-Request $_ })
  [array]::Reverse($lines)
  $req.List.Text = if ($lines.Count) { $lines -join "`r`n" } else { 'Nothing from the mini yet.' }
  # Setting Text on a focused box selects all of it; start unselected at the top.
  $req.List.Select(0, 0)
}

function Show-Requests {
  Update-Requests
  $req.Timer.Start()
  $req.Form.Show()
  $req.Form.Activate()
}

$req.Checks.add_CheckedChanged({ Update-Requests })
$req.Timer.add_Tick({ try { Update-Requests } catch { } })
# Closing only hides it, so the next "Show requests" reuses the same window.
$req.Form.add_FormClosing({
  param($sender, $e)
  if ($e.CloseReason -eq 'UserClosing') {
    $e.Cancel = $true
    $req.Timer.Stop()
    $req.Form.Hide()
  }
})

$pauseItem.add_Click({ Set-Pause 0 })
$pause1Item.add_Click({ Set-Pause 1 })
$pause3Item.add_Click({ Set-Pause 3 })
$resumeItem.add_Click({ Clear-Pause })
$logItem.add_Click({ Start-Process notepad.exe (Join-Path $Base 'run-ollama.log') })
$requestsItem.add_Click({ Show-Requests })
# Read the request log when the menu opens, not every few seconds.
$menu.add_Opening({
  $r = Get-RequestSummary
  $checkedItem.Text = $r.Checked
  $workedItem.Text = $r.Worked
})
$exitItem.add_Click({
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$tray.add_DoubleClick({
  if (Test-Path -LiteralPath $userFile) { Clear-Pause } else { Set-Pause 0 }
})
$tray.ContextMenuStrip = $menu

function Update-Tray {
  $s = Get-AiState
  $tray.Icon = $icons[$s.Kind]
  # The tooltip is cut off past 63 characters.
  $tip = "AI for Paperless: $($s.Text)"
  $tray.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 63) } else { $tip }
  $header.Text = $s.Text
  $userPaused = $s.Kind -eq 'paused'
  $resumeItem.Enabled = $userPaused
  $pauseItem.Enabled = -not ($userPaused -and -not $s.Timed)
}

Update-Tray
$tray.Visible = $true

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({ try { Update-Tray } catch { $tray.Icon = $icons.off } })
$timer.Start()

[System.Windows.Forms.Application]::Run()
$timer.Stop()
$tray.Dispose()
$mutex.ReleaseMutex()
