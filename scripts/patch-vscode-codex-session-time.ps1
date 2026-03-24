param(
    [string]$ExtensionsRoot = (Join-Path $HOME ".vscode/extensions"),
    [string]$ExtensionNamePattern = "openai.chatgpt-*"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$patchMarker = "mobilecodexhelper-vscode-codex-session-time"

function Write-Info {
    param([string]$Message)

    Write-Host "[info] $Message"
}

function Read-Utf8Text {
    param([string]$Path)

    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8Text {
    param(
        [string]$Path,
        [string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Get-LatestCodexExtensionDirectory {
    param(
        [string]$RootPath,
        [string]$Pattern
    )

    if (-not (Test-Path -LiteralPath $RootPath)) {
        throw "VS Code extensions root not found: $RootPath"
    }

    $directories = Get-ChildItem -LiteralPath $RootPath -Directory |
        Where-Object { $_.Name -like $Pattern } |
        Sort-Object LastWriteTimeUtc -Descending

    if (-not $directories) {
        throw "No VS Code extension matching '$Pattern' was found under $RootPath"
    }

    return $directories[0]
}

function Assert-ContainsExactlyOnce {
    param(
        [string]$Content,
        [string]$Snippet,
        [string]$Label
    )

    $firstIndex = $Content.IndexOf($Snippet, [System.StringComparison]::Ordinal)
    if ($firstIndex -lt 0) {
        throw "Patch anchor missing: $Label"
    }

    $secondIndex = $Content.IndexOf(
        $Snippet,
        $firstIndex + $Snippet.Length,
        [System.StringComparison]::Ordinal
    )
    if ($secondIndex -ge 0) {
        throw "Patch anchor is no longer unique: $Label"
    }
}

function Get-SnippetCount {
    param(
        [string]$Content,
        [string]$Snippet
    )

    $count = 0
    $cursor = 0
    while ($true) {
        $matchIndex = $Content.IndexOf($Snippet, $cursor, [System.StringComparison]::Ordinal)
        if ($matchIndex -lt 0) {
            break
        }

        $count += 1
        $cursor = $matchIndex + $Snippet.Length
    }

    return $count
}

$createdAtBindingSnippet = 'let{conversationId:r,preview:n,createdAtMs:o}=e'
$updatedAtBindingSnippet = 'let{conversationId:r,preview:n,updatedAtMs:o}=e'

$createdAtSummarySnippet = 'let n=Number(e.createdAt)*1e3,o=Number.isFinite(n)?n:null,i=e.name?.trim()??"";return{conversationId:e.id,preview:i||r||e.preview,createdAtMs:o,modelProvider:e.modelProvider}'
$updatedAtSummarySnippet = 'let n=Number(e.updatedAt??e.createdAt)*1e3,o=Number.isFinite(n)?n:null,i=e.name?.trim()??"";return{conversationId:e.id,preview:i||r||e.preview,updatedAtMs:o,modelProvider:e.modelProvider}'

$createdAtSortSnippet = 'sortKey:"created_at"'
$updatedAtSortSnippet = 'sortKey:"updated_at"'

$extensionDirectory = Get-LatestCodexExtensionDirectory -RootPath $ExtensionsRoot -Pattern $ExtensionNamePattern
$targetFile = Join-Path $extensionDirectory.FullName "out/extension.js"
$backupFile = "$targetFile.mobilecodexhelper.original.js"
$metadataFile = "$targetFile.mobilecodexhelper.patch.json"

if (-not (Test-Path -LiteralPath $targetFile)) {
    throw "Extension bundle not found: $targetFile"
}

Write-Info "Target extension: $($extensionDirectory.Name)"
Write-Info "Bundle path: $targetFile"

$originalContent = Read-Utf8Text -Path $targetFile
$isAlreadyPatched =
    $originalContent.Contains($updatedAtBindingSnippet) -and
    $originalContent.Contains($updatedAtSummarySnippet) -and
    (Get-SnippetCount -Content $originalContent -Snippet $createdAtSortSnippet) -eq 0

if ($isAlreadyPatched) {
    Write-Info "Extension bundle is already patched. No changes applied."
    exit 0
}

Assert-ContainsExactlyOnce -Content $originalContent -Snippet $createdAtBindingSnippet -Label "conversation timing binding"
Assert-ContainsExactlyOnce -Content $originalContent -Snippet $createdAtSummarySnippet -Label "conversation summary timestamp"

$sortAnchorCount = Get-SnippetCount -Content $originalContent -Snippet $createdAtSortSnippet
if ($sortAnchorCount -lt 1) {
    throw "Patch anchor missing: thread list sort key"
}

if (-not (Test-Path -LiteralPath $backupFile)) {
    Copy-Item -LiteralPath $targetFile -Destination $backupFile
    Write-Info "Created backup: $backupFile"
} else {
    Write-Info "Backup already exists: $backupFile"
}

$patchedContent = $originalContent.Replace($createdAtBindingSnippet, $updatedAtBindingSnippet)
$patchedContent = $patchedContent.Replace($createdAtSummarySnippet, $updatedAtSummarySnippet)
$patchedContent = $patchedContent.Replace($createdAtSortSnippet, $updatedAtSortSnippet)

if ($patchedContent -eq $originalContent) {
    throw "Patch produced no changes. Aborting."
}

if (-not $patchedContent.Contains($updatedAtBindingSnippet)) {
    throw "Patched content verification failed: updated timing binding was not written"
}

if (-not $patchedContent.Contains($updatedAtSummarySnippet)) {
    throw "Patched content verification failed: updated summary timestamp was not written"
}

if ((Get-SnippetCount -Content $patchedContent -Snippet $createdAtSortSnippet) -ne 0) {
    throw "Patched content verification failed: created_at sort key still exists"
}

$temporaryFile = "$targetFile.$patchMarker.tmp"
Write-Utf8Text -Path $temporaryFile -Content $patchedContent
Move-Item -LiteralPath $temporaryFile -Destination $targetFile -Force

$metadata = [ordered]@{
    patch_id = $patchMarker
    patched_at = (Get-Date).ToUniversalTime().ToString("o")
    extension_directory = $extensionDirectory.FullName
    extension_name = $extensionDirectory.Name
    bundle_path = $targetFile
    backup_path = $backupFile
    replaced_sort_key_occurrences = $sortAnchorCount
}

Write-Utf8Text -Path $metadataFile -Content (($metadata | ConvertTo-Json -Depth 4) + "`n")

Write-Info "Patch applied successfully."
Write-Info "Reload VS Code to make the updated session-time logic take effect."
