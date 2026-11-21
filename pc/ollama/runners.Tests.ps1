# Tests for runners.ps1: which llama-server processes count as a loaded
# model, and killing without letting taskkill end the script. Run with:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Pester I:\Projects\media-stack\pc\ollama"
#
# The port and process lookups are faked. Stop-Tree really runs taskkill,
# once, on a process id Windows never hands out, so nothing is killed.
# Pester 3.4 (Windows PowerShell 5.1's): a mock lasts for its whole Context.

. (Join-Path $PSScriptRoot 'runners.ps1')

$t0 = [datetime]'2026-11-21T20:00:00'
# Shaped like Win32_Process. Get-CimInstance hands one back on its own, not in
# an array, exactly as the real one does.
function New-Proc([int]$id, [datetime]$created, [string]$name = 'llama-server.exe') {
  [pscustomobject]@{ Name = $name; ProcessId = $id; CreationDate = $created }
}
$serverQuery = { $Filter -eq 'ProcessId=4242' }
$runnerQuery = { $Filter -eq "Name='llama-server.exe' AND ParentProcessId=4242" }

Describe 'Get-ModelRunners' {
  Context 'the GPU check a server runs as it starts' {
    Mock Get-CimInstance { New-Proc 4242 $t0 'ollama.exe' } -ParameterFilter $serverQuery
    Mock Get-CimInstance { New-Proc 7 $t0.AddSeconds(1) } -ParameterFilter $runnerQuery
    It 'is not a model while it is young' {
      @(Get-ModelRunners 4242 $t0.AddSeconds(3)).Count | Should Be 0
    }
    It 'is a model once it has lived past the check (a request in the first seconds)' {
      @(Get-ModelRunners 4242 $t0.AddSeconds(12)).Count | Should Be 1
    }
  }

  Context 'a model loaded later in the server''s life' {
    Mock Get-CimInstance { New-Proc 4242 $t0 'ollama.exe' } -ParameterFilter $serverQuery
    Mock Get-CimInstance { New-Proc 7 $t0.AddMinutes(5) } -ParameterFilter $runnerQuery
    It 'counts at once, so the subtitle Ollama yields before paperless sizes the GPU' {
      @(Get-ModelRunners 4242 $t0.AddMinutes(5).AddSeconds(1)).Count | Should Be 1
    }
  }

  Context 'two models' {
    Mock Get-CimInstance { New-Proc 4242 $t0 'ollama.exe' } -ParameterFilter $serverQuery
    Mock Get-CimInstance { New-Proc 7 $t0.AddMinutes(2); New-Proc 8 $t0.AddMinutes(5) } -ParameterFilter $runnerQuery
    It 'counts both' {
      @(Get-ModelRunners 4242 $t0.AddMinutes(5).AddSeconds(1)).Count | Should Be 2
    }
  }

  Context 'no runner' {
    Mock Get-CimInstance { } -ParameterFilter $runnerQuery
    Mock Get-CimInstance { New-Proc 4242 $t0 'ollama.exe' } -ParameterFilter $serverQuery
    It 'returns none, without asking about the server' {
      @(Get-ModelRunners 4242 $t0).Count | Should Be 0
      Assert-MockCalled Get-CimInstance -Times 0 -Exactly -ParameterFilter $serverQuery
    }
  }

  Context 'the server''s start time cannot be read' {
    Mock Get-CimInstance { } -ParameterFilter $serverQuery
    Mock Get-CimInstance { New-Proc 7 $t0 } -ParameterFilter $runnerQuery
    It 'counts the runner: a model missed is worse than a yield too many' {
      @(Get-ModelRunners 4242 $t0.AddSeconds(1)).Count | Should Be 1
    }
  }
}

Describe 'Test-Loaded' {
  Context 'one model loaded (the case that read as none on Windows PowerShell 5.1)' {
    Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
    Mock Get-CimInstance { New-Proc 4242 $t0 'ollama.exe' } -ParameterFilter $serverQuery
    Mock Get-CimInstance { New-Proc 7 ((Get-Date).AddMinutes(-1)) } -ParameterFilter $runnerQuery
    It 'sees it' {
      Test-Loaded 11434 | Should Be $true
    }
  }

  Context 'a paperless Ollama that has just started' {
    Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
    Mock Get-CimInstance { New-Proc 4242 ((Get-Date).AddSeconds(-2)) 'ollama.exe' } -ParameterFilter $serverQuery
    Mock Get-CimInstance { New-Proc 7 ((Get-Date).AddSeconds(-1)) } -ParameterFilter $runnerQuery
    It 'has no model loaded, so nothing yields to it' {
      Test-Loaded 11434 | Should Be $false
    }
  }

  Context 'nothing listens on the port' {
    Mock Get-NetTCPConnection { }
    Mock Get-CimInstance { New-Proc 7 $t0 }
    It 'sees none' {
      Test-Loaded 11434 | Should Be $false
    }
  }

  Context 'runners under another server' {
    Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
    Mock Get-CimInstance { }
    It 'counts only the runners of the server on that port' {
      Test-Loaded 11434 | Should Be $false
      Assert-MockCalled Get-CimInstance -Times 1 -Exactly -ParameterFilter $runnerQuery
    }
  }
}

Describe 'Stop-Tree' {
  It 'does not end a script that stops on errors when the process is already gone' {
    $ErrorActionPreference = 'Stop'
    # The largest multiple of 4 an [int] holds; Windows never hands it out.
    { Stop-Tree 2147483644 } | Should Not Throw
  }
}
