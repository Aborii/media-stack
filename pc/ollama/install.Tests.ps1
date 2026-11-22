# Tests for install.ps1's own functions: the check of whether a model is
# already there, which decides whether a failed pull fails the install, and
# the swap to a new Ollama, which must stop the tasks before it unpacks. Run
# with the rest:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Pester I:\Projects\media-stack\pc\ollama"
#
# install.ps1 needs an elevated PowerShell and changes the PC, so only the
# functions are loaded, read out of the file by the parser, and every call
# that would touch Ollama or the tasks is faked. Pester 3.4: a mock lasts for
# its whole Context.

. (Join-Path $PSScriptRoot 'runners.ps1')
$script = Join-Path $PSScriptRoot 'install.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if ($fn.Name -in 'Test-ModelThere', 'Install-OllamaZip') { . ([scriptblock]::Create($fn.Extent.Text)) }
}
$Listen = '10.10.10.1:11434'

Describe 'Test-ModelThere' {
  Context 'Ollama knows the model' {
    Mock Invoke-RestMethod { [pscustomobject]@{ modelfile = '...' } }
    It 'says it is there, asking the paperless Ollama about that model' {
      Test-ModelThere 'translategemma:12b' | Should Be $true
      Assert-MockCalled Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
        $Uri -eq 'http://10.10.10.1:11434/api/show' -and $Method -eq 'Post' -and $Body -match '"translategemma:12b"'
      }
    }
  }

  Context 'Ollama answers 404' {
    Mock Invoke-RestMethod { throw 'The remote server returned an error: (404) Not Found.' }
    It 'says it is not there' {
      Test-ModelThere 'translategemma:12b' | Should Be $false
    }
  }
}

# Each fake writes what it was asked to do into $calls, so a case can check
# the order: a task left running would start ollama.exe again mid-unpack.
# The Ollama folder is a real one in Pester's TestDrive, so the pause file is
# really written and removed; "paused" in $calls means it was there then.
Describe 'Install-OllamaZip' {
  $tasks = @('ollama', 'ollama-subtitles')
  $base = Join-Path $TestDrive 'ollama'
  $pause = Join-Path $base 'pause\install'
  New-Item -ItemType Directory -Force -Path (Join-Path $base 'pause') | Out-Null
  function Get-Paused { if (Test-Path -LiteralPath $pause) { 'paused' } else { 'not paused' } }

  Context 'both tasks running' {
    $calls = New-Object System.Collections.ArrayList
    $script:pauseUntil = $null
    Mock Stop-ScheduledTask {
      [void]$calls.Add("stop $TaskName, $(Get-Paused)")
      $script:pauseUntil = [datetime]::Parse((Get-Content -LiteralPath $pause | Select-Object -First 1))
    }
    Mock Get-Process { [pscustomobject]@{ Id = 11 }; [pscustomobject]@{ Id = 12 } }
    Mock Stop-Tree { [void]$calls.Add("kill $id, $(Get-Paused)") }
    Mock Expand-Archive { [void]$calls.Add("unpack $LiteralPath, $(Get-Paused)") }
    $before = Get-Date
    Install-OllamaZip 'C:\t\o.zip' $base $tasks

    It 'pauses and stops both tasks before it kills or unpacks anything' {
      ($calls -join '; ') | Should Be ('stop ollama, paused; stop ollama-subtitles, paused; ' +
        'kill 11, paused; kill 12, paused; unpack C:\t\o.zip, paused')
    }
    It 'unpacks into the Ollama folder' {
      Assert-MockCalled Expand-Archive -Times 1 -Exactly -ParameterFilter { $DestinationPath -eq $base -and $Force }
    }
    It 'pauses for an hour, so a cut-off install does not keep the Ollamas off for good' {
      ($script:pauseUntil - $before).TotalMinutes | Should BeGreaterThan 59
      ($script:pauseUntil - $before).TotalMinutes | Should BeLessThan 61
    }
    It 'lifts the pause once it is done' {
      Get-Paused | Should Be 'not paused'
    }
  }

  Context 'the unpack fails' {
    Mock Stop-ScheduledTask { }
    Mock Get-Process { }
    Mock Stop-Tree { }
    Mock Expand-Archive { throw 'The process cannot access the file ollama.exe because it is being used by another process.' }

    It 'fails the install, and lifts the pause' {
      { Install-OllamaZip 'C:\t\o.zip' $base $tasks } | Should Throw 'being used by another process'
      Get-Paused | Should Be 'not paused'
    }
  }
}
