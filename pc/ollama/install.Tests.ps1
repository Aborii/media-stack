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
Describe 'Install-OllamaZip' {
  $tasks = @('ollama', 'ollama-subtitles')

  Context 'both tasks running' {
    $calls = New-Object System.Collections.ArrayList
    Mock Disable-ScheduledTask { [void]$calls.Add("disable $TaskName") }
    Mock Stop-ScheduledTask { [void]$calls.Add("stop $TaskName") }
    Mock Enable-ScheduledTask { [void]$calls.Add("enable $TaskName") }
    Mock Get-Process { [pscustomobject]@{ Id = 11 }; [pscustomobject]@{ Id = 12 } }
    Mock Stop-Tree { [void]$calls.Add("kill $id") }
    Mock Expand-Archive { [void]$calls.Add("unpack $LiteralPath") }
    Install-OllamaZip 'C:\t\o.zip' 'I:\AI\ollama' $tasks

    It 'disables and stops both tasks before it kills or unpacks anything' {
      ($calls[0..3] -join ', ') | Should Be 'disable ollama, stop ollama, disable ollama-subtitles, stop ollama-subtitles'
      ($calls[4..6] -join ', ') | Should Be 'kill 11, kill 12, unpack C:\t\o.zip'
    }
    It 'unpacks into the Ollama folder' {
      Assert-MockCalled Expand-Archive -Times 1 -Exactly -ParameterFilter { $DestinationPath -eq 'I:\AI\ollama' -and $Force }
    }
    It 'enables both again once it is done' {
      ($calls[7..8] -join ', ') | Should Be 'enable ollama, enable ollama-subtitles'
      $calls.Count | Should Be 9
    }
  }

  Context 'the unpack fails' {
    $calls = New-Object System.Collections.ArrayList
    Mock Disable-ScheduledTask { }
    Mock Stop-ScheduledTask { }
    Mock Enable-ScheduledTask { [void]$calls.Add("enable $TaskName") }
    Mock Get-Process { }
    Mock Stop-Tree { }
    Mock Expand-Archive { throw 'The process cannot access the file ollama.exe because it is being used by another process.' }

    It 'fails the install, and leaves both tasks enabled' {
      { Install-OllamaZip 'C:\t\o.zip' 'I:\AI\ollama' $tasks } | Should Throw 'being used by another process'
      ($calls -join ', ') | Should Be 'enable ollama, enable ollama-subtitles'
    }
  }
}
