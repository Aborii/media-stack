# Tests for run-ollama.ps1's Stop-Runner, the tray's "Unload ... now". Run with:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Pester I:\Projects\media-stack\pc\ollama"
#
# The script itself is a loop that never returns, so only Stop-Runner is
# loaded, read out of the file by the parser, beside runners.ps1 (tested in
# runners.Tests.ps1). The process lookup and the kill are faked: nothing here
# stops anything. Pester 3.4 (Windows PowerShell 5.1's): a mock lasts for its
# whole Context, so each case has a Context of its own.

. (Join-Path $PSScriptRoot 'runners.ps1')
$script = Join-Path $PSScriptRoot 'run-ollama.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if ($fn.Name -eq 'Stop-Runner') { . ([scriptblock]::Create($fn.Extent.Text)) }
}

# One fake runner, shaped like Win32_Process. Get-CimInstance hands one back
# on its own, not in an array, exactly as the real one does.
function New-Runner([int]$id) { [pscustomobject]@{ Name = 'llama-server.exe'; ProcessId = $id } }

Describe 'Stop-Runner' {
  Context 'one runner' {
    Mock Get-CimInstance { New-Runner 7 }
    Mock Stop-Tree { }
    It 'stops it and says it stopped one' {
      Stop-Runner 4242 | Should Be 1
      Assert-MockCalled Stop-Tree -Times 1 -Exactly -ParameterFilter { $id -eq 7 }
    }
  }

  Context 'no runner' {
    Mock Get-CimInstance { }
    Mock Stop-Tree { }
    It 'stops nothing and says none' {
      Stop-Runner 4242 | Should Be 0
      Assert-MockCalled Stop-Tree -Times 0 -Exactly
    }
  }
}

foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if ($fn.Name -in 'Write-Log', 'Stop-Ollama') { . ([scriptblock]::Create($fn.Extent.Text)) }
}
$log = Join-Path $env:TEMP 'run-ollama-tests.log'
$port = 11434

Describe 'Write-Log' {
  Context 'the log cannot be written' {
    Mock Out-File { throw 'There is not enough space on the disk.' }
    It 'does not stop the caller, even one that stops on errors' {
      $ErrorActionPreference = 'Stop'
      { Write-Log 'Paused by: user.' } | Should Not Throw
    }
  }
}

Describe 'Stop-Ollama' {
  Context 'the Ollama goes' {
    $script:proc = $null
    $script:asked = 0
    # Listening when asked what to kill, gone after.
    Mock Get-NetTCPConnection { $script:asked++; if ($script:asked -eq 1) { [pscustomobject]@{ OwningProcess = 4242 } } }
    Mock Stop-Tree { }
    Mock Start-Sleep { }
    It 'kills it and says the port is free' {
      Stop-Ollama | Should Be $true
      Assert-MockCalled Stop-Tree -Times 1 -Exactly -ParameterFilter { $id -eq 4242 }
    }
  }

  Context 'the Ollama will not go' {
    $script:proc = $null
    Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
    Mock Stop-Tree { }
    Mock Start-Sleep { }
    It 'says so, so the loop does not call the GPU free' {
      Stop-Ollama | Should Be $false
    }
  }
}
