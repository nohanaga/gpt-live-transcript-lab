#requires -Version 7.0
[CmdletBinding()]
param([string]$OutputPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourceRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) {
    $OutputPath = Join-Path $sourceRoot 'delivery/gpt-live-transcript-lab'
}
$destination = [System.IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $destination) {
    if (-not (Test-Path -LiteralPath $destination -PathType Container) -or
        @(Get-ChildItem -LiteralPath $destination -Force).Count -gt 0) {
        throw 'The output must be a new or empty directory. Existing files will not be overwritten.'
    }
}

$relativeFiles = @(
    '.env.example', '.gitattributes', '.gitignore', 'app.py',
    'package.json', 'package-lock.json', 'pyproject.toml', 'requirements.txt',
    'README.md', 'README.en.md', 'SECURITY.md', 'SECURITY.en.md', 'THIRD_PARTY_NOTICES.md',
    'docs/usage.md', 'docs/usage.en.md',
    'scripts/build-grouper.mjs', 'scripts/prepare-delivery.ps1'
)
$sourceGroups = [ordered]@{
    lab = @('.py')
    tests = @('.py', '.mjs')
    frontend = @('.ts')
    static = @('.html', '.css', '.js')
    vendor = @('.py', '.ts')
}
foreach ($group in $sourceGroups.GetEnumerator()) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot $group.Key) -File -Recurse -Force) {
        $relative = $file.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/')
        if ($relative -match '(^|/)(node_modules|__pycache__|\.git|\.venv)(/|$)') { continue }
        if ($file.Extension -in $group.Value -or $file.Name -eq 'LICENSE' -or $file.Name -eq 'LICENSE.openai-node') {
            $relativeFiles += $relative
        }
    }
}
$relativeFiles = @($relativeFiles | Sort-Object -Unique)
foreach ($relative in $relativeFiles) {
    $file = Get-Item -LiteralPath (Join-Path $sourceRoot $relative)
    if ($file.PSIsContainer -or ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Only regular source files can be delivered: $relative"
    }
}

$package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json -AsHashtable
$entries = foreach ($relative in $relativeFiles) {
    $target = Join-Path $destination $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $target
    [ordered]@{
        path = $relative
        bytes = (Get-Item -LiteralPath $target).Length
        sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$manifest = [ordered]@{
    name = $package.name
    version = $package.version
    generated_utc = [DateTime]::UtcNow.ToString('o')
    application_license = 'Not specified'
    tests_run_by_packaging = $false
    upstream = [ordered]@{
        openai_node = '5d258e4e82d7655fa82a4688fc04c53359417d27'
        openai_cookbook = '5986832a554169dc87285b1b0b396941f235a62e'
    }
    files = @($entries)
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $destination 'RELEASE_MANIFEST.json') -Encoding utf8
Write-Output ('Prepared {0} files plus RELEASE_MANIFEST.json in {1}' -f $relativeFiles.Count, $destination)