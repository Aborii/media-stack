# A tray icon for the PC's Ollama: a coloured dot saying what the AI is doing,
# with Pause and Resume on its menu. Double-click toggles pause.
#
#   green   ready, nothing loaded
#   blue    reading a document (a model is loaded)
#   amber   paused by you (Pause AI, pause.ps1 or this menu)
#   purple  paused because storychat has the GPU
#   red     not answering: the "ollama" task is stopped, starting, or broken
#
# It only reads the state and writes the same pause file as pause.ps1;
# run-ollama.ps1 does the stopping and starting. Started at sign-in by the
# "AI tray" shortcut in the Startup folder (install.ps1), through
# conhost --headless so no console window shows.
#
#   tray.ps1 -Status    prints the state once and exits (for checking)
param(
  [string]$Base = 'I:\AI\ollama',
  [string]$Url = 'http://10.10.10.1:11434',
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$pauseDir = Join-Path $Base 'pause'
$userFile = Join-Path $pauseDir 'user'

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
  try {
    $ps = Invoke-RestMethod -Uri "$Url/api/ps" -TimeoutSec 2
  } catch {
    return @{ Kind = 'off'; Text = 'Not running (starting, or the task is stopped)' }
  }
  $loaded = @($ps.models)
  if ($loaded.Count -gt 0) {
    return @{ Kind = 'busy'; Text = "Working: $($loaded[0].name) loaded" }
  }
  return @{ Kind = 'ready'; Text = 'Ready for documents' }
}

if ($Status) {
  $s = Get-AiState
  "$($s.Kind): $($s.Text)"
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
[void]$menu.Items.Add('-')
$pauseItem = $menu.Items.Add('Pause until I resume')
$pause1Item = $menu.Items.Add('Pause for 1 hour')
$pause3Item = $menu.Items.Add('Pause for 3 hours')
$resumeItem = $menu.Items.Add('Resume')
[void]$menu.Items.Add('-')
$logItem = $menu.Items.Add('Open the log')
$exitItem = $menu.Items.Add('Hide this icon')

$pauseItem.add_Click({ Set-Pause 0 })
$pause1Item.add_Click({ Set-Pause 1 })
$pause3Item.add_Click({ Set-Pause 3 })
$resumeItem.add_Click({ Clear-Pause })
$logItem.add_Click({ Start-Process notepad.exe (Join-Path $Base 'run-ollama.log') })
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
