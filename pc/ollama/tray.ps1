# A tray icon for the AI on the PC: a coloured dot saying what the models are
# doing, with Pause and Resume on its menu. Double-click toggles pause. Pause
# covers every model: both Ollamas stop, and storychat-server unloads the chat
# model and loads nothing until resumed.
#
#   green   ready, nothing loaded
#   blue    reading a document (a paperless model is loaded)
#   teal    translating subtitles (subfill's model is loaded)
#   amber   paused by you (Pause AI, pause.ps1 or this menu)
#   grey    the paperless models are switched off (below)
#   purple  paused because storychat has the GPU
#   red     not answering: the "ollama" task is stopped, starting, or broken
#
# Two Ollamas serve the mini (run-ollama.ps1): paperless-gpt's on 11434 and
# subfill's, for subtitles, on 11435, which stays stopped while paperless has
# a model loaded. The menu says when the mini last checked in with each and
# when it last sent work, and "Show ... requests from the mini" lists them,
# read from each Ollama's request log.
#
# Per model, the menu says whether it is loaded, can unload it now (mid-work:
# a batch or a reply cut off is redone; a Paperless document cut off fails its
# AI reading, and rerun-ai.py runs it again), and has a "can load" switch
# that, when off, keeps it from loading until switched back on.
#
# It only reads the state and writes files in $Base, which the programs that
# run the models act on within a few seconds:
#   pause\user                         pause.ps1's file: every model
#   off\paperless, unload\paperless    run-ollama.ps1 (paperless)
#   off\subtitles, unload\subtitles    run-ollama.ps1 -Name subtitles
#   off\chat, unload\chat              storychat-server (its controls.ts)
# run-ollama.ps1 does the stopping and starting. The state comes from the
# processes and the listening ports, not from asking Ollama, so the icon adds
# nothing to the request logs. Started at sign-in by the "AI tray" shortcut in
# the Startup folder (install.ps1), through conhost --headless so no console
# window shows.
#
#   tray.ps1 -Status    prints the state and the mini's last requests, then exits
param(
  [string]$Base = 'I:\AI\ollama',
  [string]$Url = 'http://10.10.10.1:11434',
  # The second Ollama, subfill's (run-ollama.ps1 -Name subtitles).
  [string]$SubtitlesUrl = 'http://10.10.10.1:11435',
  [string]$MiniAddress = '10.10.10.3',
  # KoboldCpp's port (storychat-server's KOBOLD_PORT): listening means the
  # chat model is loaded.
  [int]$ChatPort = 5001,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$pauseDir = Join-Path $Base 'pause'
$userFile = Join-Path $pauseDir 'user'
$offFiles = @{
  chat      = Join-Path $Base 'off\chat'
  paperless = Join-Path $Base 'off\paperless'
  subtitles = Join-Path $Base 'off\subtitles'
}
$unloadFiles = @{
  chat      = Join-Path $Base 'unload\chat'
  paperless = Join-Path $Base 'unload\paperless'
  subtitles = Join-Path $Base 'unload\subtitles'
}
# Each Ollama's request logs, oldest first. ollama-serve.log.out is the
# paperless one's old name, until it next starts.
$requestFiles = @{
  paperless = @('ollama-requests-history.log.1', 'ollama-requests-history.log', 'ollama-serve.log.out', 'ollama-requests.log') |
    ForEach-Object { Join-Path $Base $_ }
  subtitles = @('ollama-subtitles-requests-history.log.1', 'ollama-subtitles-requests-history.log', 'ollama-subtitles-requests.log') |
    ForEach-Object { Join-Path $Base $_ }
}
# How each one's requests read in the menu and the requests window. The
# check-ins are paperless-gpt's gate (every 30 s) and subfill's PC node
# (before each episode, and every minute or so while idle).
$requestWords = @{
  paperless = @{ Title = 'Paperless requests from the mini'; Work = 'document work'; Last = 'Last document request'; None = 'No document requests in the request log'; Who = 'Paperless gate' }
  subtitles = @{ Title = 'Subtitle requests from the mini'; Work = 'translation'; Last = 'Last subtitle request'; None = 'No subtitle requests in the request log'; Who = 'subfill' }
}

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
  if (Test-Path -LiteralPath $offFiles.paperless) {
    return @{ Kind = 'disabled'; Text = 'Paperless models switched off' }
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

# subfill's Ollama, from its port, its runner and the switches. It shares the
# pause with the rest, and stays stopped while paperless has a model loaded.
function Get-SubtitleState([hashtable]$paperless) {
  $files = @(Get-ChildItem -LiteralPath $pauseDir -File -ErrorAction SilentlyContinue | ForEach-Object Name)
  $state = @{ Loaded = $false; Off = (Test-Path -LiteralPath $offFiles.subtitles) }
  if ($state.Off) { return $state + @{ Text = 'Subtitle model: switched off' } }
  if ($files -contains 'user') { return $state + @{ Text = 'Subtitle model: paused with the rest' } }
  if ($files -contains 'storychat') { return $state + @{ Text = 'Subtitle model: paused while storychat uses the GPU' } }
  $server = Get-NetTCPConnection -LocalPort ([uri]$SubtitlesUrl).Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $server) {
    $text = if ($paperless.Kind -eq 'busy') { 'Subtitle model: waiting while paperless works' } else { 'Subtitle model: not running' }
    return $state + @{ Text = $text }
  }
  $runner = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe' AND ParentProcessId=$($server.OwningProcess)" -ErrorAction SilentlyContinue
  if ($runner) { return @{ Loaded = $true; Off = $false; Text = 'Subtitle model: translating' } }
  return $state + @{ Text = 'Subtitle model: ready' }
}

# The chat model, from its port and the tray's own switch.
function Get-ChatState {
  $loaded = [bool](Get-NetTCPConnection -LocalPort $ChatPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
  $off = Test-Path -LiteralPath $offFiles.chat
  $text = if ($loaded) { 'Chat model: loaded' } elseif ($off) { 'Chat model: switched off' } else { 'Chat model: not loaded' }
  @{ Loaded = $loaded; Off = $off; Text = $text }
}

function Set-Flag([string]$file, [bool]$on) {
  if ($on) {
    New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
    '' | Set-Content -LiteralPath $file -Encoding ascii
  } else {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

# One [GIN] line from the mini as an object; nothing for anything else.
function ConvertFrom-Gin([string]$line) {
  if ($line -notmatch '^\[GIN\] (\d{4}/\d\d/\d\d - \d\d:\d\d:\d\d) \|\s*(\d+) \|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\w+)\s+"([^"]*)"') { return }
  if ($Matches[4] -ne $MiniAddress) { return }
  [pscustomobject]@{
    When   = [datetime]::ParseExact($Matches[1], 'yyyy/MM/dd - HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
    Status = [int]$Matches[2]
    Took   = $Matches[3]
    Method = $Matches[5]
    Path   = $Matches[6]
  }
}

# One Ollama's requests from the mini, oldest first. The check-ins are
# thousands of lines a day, so they are read from the end of the logs only;
# everything else (the work) is matched across the whole logs, so a quiet week
# does not push the last real request out of view.
function Get-MiniRequests([string]$kind, [int]$CheckTail = 3000) {
  $files = @($requestFiles[$kind] | Where-Object { Test-Path -LiteralPath $_ })
  $notCheck = [regex]::Escape($MiniAddress) + ' \| (?!GET\s+"/api/tags")'
  @{
    Work   = @(foreach ($f in $files) {
        Select-String -LiteralPath $f -Pattern $notCheck -ErrorAction SilentlyContinue |
          ForEach-Object { ConvertFrom-Gin $_.Line }
      })
    Checks = @(foreach ($f in $files) {
        Get-Content -LiteralPath $f -Tail $CheckTail -ErrorAction SilentlyContinue |
          ForEach-Object { ConvertFrom-Gin $_ } | Where-Object Path -eq '/api/tags'
      })
  }
}

function Format-Ago([datetime]$when) {
  $s = ((Get-Date) - $when).TotalSeconds
  if ($s -lt 90) { return "$([int]$s) s ago" }
  if ($s -lt 5400) { return "$([int]($s / 60)) min ago" }
  return $when.ToString('ddd HH:mm')
}

function Get-RequestSummary([string]$kind) {
  $r = Get-MiniRequests $kind
  $w = $requestWords[$kind]
  $checks = $r.Checks
  $work = $r.Work
  @{
    Checked = if ($checks) { "$($w.Who) last checked in: $(Format-Ago $checks[-1].When)" } else { "$($w.Who) has not checked in recently" }
    Worked  = if ($work) { "$($w.Last): $(Format-Ago $work[-1].When) ($($work[-1].Took))" } else { $w.None }
    Work    = $work
    Checks  = $checks
  }
}

function Format-Request($r, [string]$kind) {
  $what = switch -Regex ($r.Path) {
    '^/api/tags$' { 'check-in' }
    '^/api/(chat|generate)$' { $requestWords[$kind].Work }
    default { "$($r.Method) $($r.Path)" }
  }
  $result = if ($r.Status -eq 200) { 'OK' } else { "error $($r.Status)" }
  '{0}  {1,-14} {2,10}  {3}' -f $r.When.ToString('ddd dd MMM HH:mm:ss'), $what, $r.Took, $result
}

if ($Status) {
  $s = Get-AiState
  "$($s.Kind): $($s.Text)"
  (Get-SubtitleState $s).Text
  (Get-ChatState).Text
  foreach ($kind in 'paperless', 'subtitles') {
    $r = Get-RequestSummary $kind
    $r.Checked
    $r.Worked
    $r.Work | Select-Object -Last 5 | ForEach-Object { '  ' + (Format-Request $_ $kind) }
  }
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
  ready    = New-DotIcon '#2e7d32'
  busy     = New-DotIcon '#1565c0'
  subs     = New-DotIcon '#00838f'
  paused   = New-DotIcon '#f9a825'
  disabled = New-DotIcon '#616161'
  chat     = New-DotIcon '#6a1b9a'
  off      = New-DotIcon '#c62828'
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
$requestsItem = $menu.Items.Add('Show paperless requests from the mini...')
[void]$menu.Items.Add('-')
$subtitleItem = $menu.Items.Add('...')
$subtitleItem.Enabled = $false
$subCheckedItem = $menu.Items.Add('...')
$subCheckedItem.Enabled = $false
$subWorkedItem = $menu.Items.Add('...')
$subWorkedItem.Enabled = $false
$subRequestsItem = $menu.Items.Add('Show subtitle requests from the mini...')
[void]$menu.Items.Add('-')
$chatItem = $menu.Items.Add('...')
$chatItem.Enabled = $false
$unloadChatItem = $menu.Items.Add('Unload the chat model now')
$unloadPaperlessItem = $menu.Items.Add('Unload the paperless model now')
$unloadSubtitleItem = $menu.Items.Add('Unload the subtitle model now')
$chatAllowedItem = $menu.Items.Add('Chat model can load')
$paperlessAllowedItem = $menu.Items.Add('Paperless models can load')
$subtitleAllowedItem = $menu.Items.Add('Subtitle model can load')
[void]$menu.Items.Add('-')
$pauseItem = $menu.Items.Add('Pause all AI until I resume')
$pause1Item = $menu.Items.Add('Pause all AI for 1 hour')
$pause3Item = $menu.Items.Add('Pause all AI for 3 hours')
$resumeItem = $menu.Items.Add('Resume')
[void]$menu.Items.Add('-')
$logItem = $menu.Items.Add('Open the start and stop log')
$subLogItem = $menu.Items.Add('Open the subtitle start and stop log')
$exitItem = $menu.Items.Add('Hide this icon')

# A live list of one Ollama's requests from the mini, newest first, refreshed
# while it is open. One window per Ollama, made once and hidden on close. Each
# control's Tag names its Ollama, so the shared handlers know which to show.
$windows = @{}
foreach ($kind in 'paperless', 'subtitles') {
  $w = @{ Kind = $kind }
  $w.Form = New-Object System.Windows.Forms.Form
  $w.Form.Text = $requestWords[$kind].Title
  $w.Form.Size = New-Object System.Drawing.Size 640, 520
  $w.Form.StartPosition = 'CenterScreen'
  $w.Form.Icon = if ($kind -eq 'subtitles') { $icons.subs } else { $icons.ready }
  $w.Form.Tag = $kind
  $w.Summary = New-Object System.Windows.Forms.Label
  $w.Summary.Dock = 'Top'
  $w.Summary.Height = 44
  $w.Summary.Padding = New-Object System.Windows.Forms.Padding 8, 6, 8, 0
  $w.Checks = New-Object System.Windows.Forms.CheckBox
  $w.Checks.Text = 'Include the check-ins'
  $w.Checks.Dock = 'Top'
  $w.Checks.Padding = New-Object System.Windows.Forms.Padding 8, 0, 0, 0
  $w.Checks.Tag = $kind
  $w.List = New-Object System.Windows.Forms.TextBox
  $w.List.Multiline = $true
  $w.List.ReadOnly = $true
  $w.List.ScrollBars = 'Vertical'
  $w.List.WordWrap = $false
  $w.List.Dock = 'Fill'
  $w.List.Font = New-Object System.Drawing.Font 'Consolas', 10
  $w.Form.Controls.AddRange(@($w.List, $w.Checks, $w.Summary))
  $w.Timer = New-Object System.Windows.Forms.Timer
  $w.Timer.Interval = 5000
  $w.Timer.Tag = $kind
  $windows[$kind] = $w
}

function Update-Requests([string]$kind) {
  $w = $windows[$kind]
  $r = Get-RequestSummary $kind
  $w.Summary.Text = "$($r.Checked)`r`n$($r.Worked)"
  $shown = if ($w.Checks.Checked) { @($r.Work + $r.Checks | Sort-Object When) } else { $r.Work }
  $lines = @($shown | Select-Object -Last 300 | ForEach-Object { Format-Request $_ $kind })
  [array]::Reverse($lines)
  $w.List.Text = if ($lines.Count) { $lines -join "`r`n" } else { 'Nothing from the mini yet.' }
  # Setting Text on a focused box selects all of it; start unselected at the top.
  $w.List.Select(0, 0)
}

function Show-Requests([string]$kind) {
  Update-Requests $kind
  $windows[$kind].Timer.Start()
  $windows[$kind].Form.Show()
  $windows[$kind].Form.Activate()
}

foreach ($w in $windows.Values) {
  $w.Checks.add_CheckedChanged({ param($sender) Update-Requests $sender.Tag })
  $w.Timer.add_Tick({ param($sender) try { Update-Requests $sender.Tag } catch { } })
  # Closing only hides it, so the next "Show requests" reuses the same window.
  $w.Form.add_FormClosing({
      param($sender, $e)
      if ($e.CloseReason -eq 'UserClosing') {
        $e.Cancel = $true
        $windows[$sender.Tag].Timer.Stop()
        $sender.Hide()
      }
    })
}

$pauseItem.add_Click({ Set-Pause 0 })
$pause1Item.add_Click({ Set-Pause 1 })
$pause3Item.add_Click({ Set-Pause 3 })
$resumeItem.add_Click({ Clear-Pause })
$unloadChatItem.add_Click({ Set-Flag $unloadFiles.chat $true; Update-Tray })
$unloadPaperlessItem.add_Click({ Set-Flag $unloadFiles.paperless $true; Update-Tray })
$unloadSubtitleItem.add_Click({ Set-Flag $unloadFiles.subtitles $true; Update-Tray })
# Checked means it may load; unticking writes the "off" file.
$chatAllowedItem.add_Click({ Set-Flag $offFiles.chat $chatAllowedItem.Checked; Update-Tray })
$paperlessAllowedItem.add_Click({ Set-Flag $offFiles.paperless $paperlessAllowedItem.Checked; Update-Tray })
$subtitleAllowedItem.add_Click({ Set-Flag $offFiles.subtitles $subtitleAllowedItem.Checked; Update-Tray })
$logItem.add_Click({ Start-Process notepad.exe (Join-Path $Base 'run-ollama.log') })
$subLogItem.add_Click({ Start-Process notepad.exe (Join-Path $Base 'run-ollama-subtitles.log') })
$requestsItem.add_Click({ Show-Requests 'paperless' })
$subRequestsItem.add_Click({ Show-Requests 'subtitles' })
# Read the request logs when the menu opens, not every few seconds.
$menu.add_Opening({
    $r = Get-RequestSummary 'paperless'
    $checkedItem.Text = $r.Checked
    $workedItem.Text = $r.Worked
    $r = Get-RequestSummary 'subtitles'
    $subCheckedItem.Text = $r.Checked
    $subWorkedItem.Text = $r.Worked
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
  $t = Get-SubtitleState $s
  # Teal when subtitles are being translated and paperless is not reading.
  $kind = if ($t.Loaded -and $s.Kind -ne 'busy') { 'subs' } else { $s.Kind }
  $tray.Icon = $icons[$kind]
  $what = if ($kind -eq 'subs') { 'translating subtitles' } else { $s.Text }
  # The tooltip is cut off past 63 characters.
  $tip = "AI on this PC: $what"
  $tray.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 63) } else { $tip }
  $header.Text = "Paperless: $($s.Text)"
  $subtitleItem.Text = $t.Text
  $userPaused = $s.Kind -eq 'paused'
  $resumeItem.Enabled = $userPaused
  $pauseItem.Enabled = -not ($userPaused -and -not $s.Timed)
  $c = Get-ChatState
  $chatItem.Text = $c.Text
  # Greyed out while a request is waiting to be picked up, so it is not sent twice.
  $unloadChatItem.Enabled = $c.Loaded -and -not (Test-Path -LiteralPath $unloadFiles.chat)
  # "busy" is exactly "a runner is loaded and nothing is paused" (Get-AiState).
  $unloadPaperlessItem.Enabled = $s.Kind -eq 'busy' -and -not (Test-Path -LiteralPath $unloadFiles.paperless)
  $unloadSubtitleItem.Enabled = $t.Loaded -and -not (Test-Path -LiteralPath $unloadFiles.subtitles)
  $chatAllowedItem.Checked = -not $c.Off
  $paperlessAllowedItem.Checked = -not (Test-Path -LiteralPath $offFiles.paperless)
  $subtitleAllowedItem.Checked = -not $t.Off
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
