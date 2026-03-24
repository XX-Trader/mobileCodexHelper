param(
    [string]$ExtensionsRoot = (Join-Path $HOME ".vscode/extensions"),
    [string]$ExtensionNamePattern = "openai.chatgpt-*",
    [string]$PatchScriptPath = (Join-Path $PSScriptRoot "patch-vscode-codex-session-time.ps1"),
    [string]$StateFilePath = (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) ".runtime") "vscode-codex-session-time-patch-state.json")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$patchMarker = "mobilecodexhelper-vscode-codex-session-time"
$createdAtBindingSnippet = 'let{conversationId:r,preview:n,createdAtMs:o}=e'
$updatedAtBindingSnippet = 'let{conversationId:r,preview:n,updatedAtMs:o}=e'
$createdAtSummarySnippet = 'let n=Number(e.createdAt)*1e3,o=Number.isFinite(n)?n:null,i=e.name?.trim()??"";return{conversationId:e.id,preview:i||r||e.preview,createdAtMs:o,modelProvider:e.modelProvider}'
$updatedAtSummarySnippet = 'let n=Number(e.updatedAt??e.createdAt)*1e3,o=Number.isFinite(n)?n:null,i=e.name?.trim()??"";return{conversationId:e.id,preview:i||r||e.preview,updatedAtMs:o,modelProvider:e.modelProvider}'
$createdAtSortSnippet = 'sortKey:"created_at"'

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

function Ensure-ParentDirectory {
    param([string]$Path)

    $parentDirectory = Split-Path -Parent $Path
    if ([string]::IsNullOrWhiteSpace($parentDirectory)) {
        return
    }

    if (-not (Test-Path -LiteralPath $parentDirectory)) {
        New-Item -ItemType Directory -Path $parentDirectory -Force | Out-Null
    }
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

function Read-OptionalJson {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    try {
        return (Read-Utf8Text -Path $Path | ConvertFrom-Json)
    } catch {
        throw "Invalid JSON file: $Path`n$($_.Exception.Message)"
    }
}

function Get-ExtensionPatchStatus {
    param([System.IO.DirectoryInfo]$ExtensionDirectory)

    $bundlePath = Join-Path $ExtensionDirectory.FullName "out/extension.js"
    $backupPath = "$bundlePath.mobilecodexhelper.original.js"
    $metadataPath = "$bundlePath.mobilecodexhelper.patch.json"

    if (-not (Test-Path -LiteralPath $bundlePath)) {
        throw "Extension bundle not found: $bundlePath"
    }

    $bundleContent = Read-Utf8Text -Path $bundlePath
    $metadata = Read-OptionalJson -Path $metadataPath
    $isPatched =
        $bundleContent.Contains($updatedAtBindingSnippet) -and
        $bundleContent.Contains($updatedAtSummarySnippet) -and
        (Get-SnippetCount -Content $bundleContent -Snippet $createdAtSortSnippet) -eq 0

    return [PSCustomObject]@{
        extension_name = $ExtensionDirectory.Name
        extension_directory = $ExtensionDirectory.FullName
        bundle_path = $bundlePath
        backup_path = $backupPath
        metadata_path = $metadataPath
        is_patched = $isPatched
        metadata_patch_id = if ($null -ne $metadata) { [string]$metadata.patch_id } else { $null }
        metadata_patched_at = if ($null -ne $metadata) { [string]$metadata.patched_at } else { $null }
        metadata_extension_name = if ($null -ne $metadata) { [string]$metadata.extension_name } else { $null }
    }
}

function Write-StateFile {
    param(
        [string]$Path,
        [hashtable]$State
    )

    Ensure-ParentDirectory -Path $Path
    Write-Utf8Text -Path $Path -Content (($State | ConvertTo-Json -Depth 6) + "`n")
}

$currentExtensionDirectory = Get-LatestCodexExtensionDirectory -RootPath $ExtensionsRoot -Pattern $ExtensionNamePattern
$previousState = Read-OptionalJson -Path $StateFilePath
$previousRecordedExtensionName = if ($null -ne $previousState) {
    [string]$previousState.last_patched_extension_name
} else {
    $null
}

$currentStatus = Get-ExtensionPatchStatus -ExtensionDirectory $currentExtensionDirectory
$action = "already_patched"
$actionReason = "Current extension bundle already matches the expected patch signature."

Write-Info "Current extension version: $($currentStatus.extension_name)"
if (-not [string]::IsNullOrWhiteSpace($previousRecordedExtensionName)) {
    Write-Info "Last recorded patched version: $previousRecordedExtensionName"
} else {
    Write-Info "Last recorded patched version: <none>"
}

if (-not $currentStatus.is_patched) {
    if ([string]::IsNullOrWhiteSpace($previousRecordedExtensionName)) {
        $actionReason = "No previously recorded patched version was found."
    } elseif ($previousRecordedExtensionName -ne $currentStatus.extension_name) {
        $actionReason = "Detected extension version change from '$previousRecordedExtensionName' to '$($currentStatus.extension_name)'."
    } else {
        $actionReason = "Recorded version matches, but the current bundle is not patched."
    }

    Write-Info "Patch is required: $actionReason"

    if (-not (Test-Path -LiteralPath $PatchScriptPath)) {
        throw "Patch script not found: $PatchScriptPath"
    }

    & $PatchScriptPath -ExtensionsRoot $ExtensionsRoot -ExtensionNamePattern $ExtensionNamePattern
    $currentStatus = Get-ExtensionPatchStatus -ExtensionDirectory $currentExtensionDirectory

    if (-not $currentStatus.is_patched) {
        throw "Patch verification failed: current extension is still not patched after running $PatchScriptPath"
    }

    $action = "patched"
} elseif ([string]::IsNullOrWhiteSpace($previousRecordedExtensionName)) {
    $action = "recorded_existing_patch"
    $actionReason = "Current extension was already patched, but no project-local state existed yet."
} elseif ($previousRecordedExtensionName -ne $currentStatus.extension_name) {
    $action = "recorded_version_change"
    $actionReason = "Current extension was already patched; project-local state has been updated to the new version."
}

$checkedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$lastPatchedAt = if (-not [string]::IsNullOrWhiteSpace($currentStatus.metadata_patched_at)) {
    $currentStatus.metadata_patched_at
} else {
    $checkedAtUtc
}

$state = [ordered]@{
    patch_id = $patchMarker
    checked_at = $checkedAtUtc
    action = $action
    action_reason = $actionReason
    current_extension_name = $currentStatus.extension_name
    current_extension_directory = $currentStatus.extension_directory
    current_bundle_path = $currentStatus.bundle_path
    current_backup_path = $currentStatus.backup_path
    current_metadata_path = $currentStatus.metadata_path
    current_version_is_patched = $currentStatus.is_patched
    last_patched_extension_name = $currentStatus.extension_name
    last_patched_extension_directory = $currentStatus.extension_directory
    last_patched_at = $lastPatchedAt
    previous_recorded_extension_name = $previousRecordedExtensionName
    metadata_extension_name = $currentStatus.metadata_extension_name
}

Write-StateFile -Path $StateFilePath -State $state

Write-Info "State file updated: $StateFilePath"
Write-Info "Current patched version: $($currentStatus.extension_name)"
Write-Info "Action: $action"
