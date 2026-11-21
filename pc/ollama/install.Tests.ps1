# Tests for install.ps1's check of whether a model is already there, which
# decides whether a failed pull fails the install. Run with the rest:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Pester I:\Projects\media-stack\pc\ollama"
#
# install.ps1 needs an elevated PowerShell and changes the PC, so only the
# function is loaded, read out of the file by the parser, and the call to
# Ollama is faked. Pester 3.4: a mock lasts for its whole Context.

$script = Join-Path $PSScriptRoot 'install.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if ($fn.Name -eq 'Test-ModelThere') { . ([scriptblock]::Create($fn.Extent.Text)) }
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
