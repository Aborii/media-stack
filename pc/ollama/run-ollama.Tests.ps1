# Tests for run-ollama.ps1's runner checks, the ones the subtitle Ollama's
# yield to paperless depends on. Run with the Pester that ships in Windows:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Pester I:\Projects\media-stack\pc\ollama"
#
# The script itself is a loop that never returns, so only its functions are
# loaded: they are read out of the file by the parser, and the port and
# process lookups they make are faked. Nothing here starts or stops anything.
# Written for Pester 3.4 (Windows PowerShell 5.1's), where a mock lasts for
# its whole Describe or Context, so each case has a Context of its own.

$script = Join-Path $PSScriptRoot 'run-ollama.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if ($fn.Name -in 'Get-Runners', 'Test-Loaded', 'Stop-Runner') { . ([scriptblock]::Create($fn.Extent.Text)) }
}

# One fake process per runner, shaped like Win32_Process. Get-CimInstance
# hands one back on its own, not in an array, exactly as the real one does.
function New-Runner([int]$id) { [pscustomobject]@{ Name = 'llama-server.exe'; ProcessId = $id } }

Describe 'Test-Loaded' {
  Context 'one model loaded' {
    Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
    Mock Get-CimInstance { New-Runner 7 }
    It 'sees it (the case that read as none on Windows PowerShell 5.1)' {
      Test-Loaded 11434 | Should Be $true
    }
  }

  Context 'two models loaded' {
    Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
    Mock Get-CimInstance { New-Runner 7; New-Runner 8 }
    It 'sees them' {
      Test-Loaded 11434 | Should Be $true
    }
  }

  Context 'the server has no runner' {
    Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
    Mock Get-CimInstance { }
    It 'sees none' {
      Test-Loaded 11434 | Should Be $false
    }
  }

  Context 'nothing listens on the port' {
    Mock Get-NetTCPConnection { }
    Mock Get-CimInstance { New-Runner 7 }
    It 'sees none' {
      Test-Loaded 11434 | Should Be $false
    }
  }

  Context 'runners under another server' {
    Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
    Mock Get-CimInstance { }
    Mock Get-CimInstance { New-Runner 7 } -ParameterFilter { $Filter -match "Name='llama-server.exe' AND ParentProcessId=4242$" }
    It 'counts only the runners of the server on that port' {
      Test-Loaded 11434 | Should Be $true
      Assert-MockCalled Get-CimInstance -Times 1 -Exactly -ParameterFilter { $Filter -match 'ParentProcessId=4242$' }
    }
  }
}

Describe 'Stop-Runner' {
  # A function named like the program runs instead of it, so nothing is killed.
  function taskkill.exe { $script:killed += ($args -join ' ') }

  Context 'one runner' {
    Mock Get-CimInstance { New-Runner 7 }
    It 'stops it and says it stopped one' {
      $script:killed = @()
      Stop-Runner 4242 | Should Be 1
      $script:killed.Count | Should Be 1
      $script:killed[0] | Should Match '/PID 7 '
    }
  }

  Context 'no runner' {
    Mock Get-CimInstance { }
    It 'stops nothing and says none' {
      $script:killed = @()
      Stop-Runner 4242 | Should Be 0
      $script:killed.Count | Should Be 0
    }
  }
}
