<#
.SYNOPSIS
Runs one load suite from an Azure Container Instances group and saves the reports.

.DESCRIPTION
The suite (suites\<name>.sh, behind suites\common.sh) runs inside the LoadGen image. This script creates the container
group through the Azure Resource Manager REST API, waits for it to finish, reads the log, deletes the group and writes
two files to OutDirectory: <suite>-<timestamp>.log (the full log) and <suite>-<timestamp>.json (one report per
LoadGen run, taken from the "#json" lines of the log).

It uses "az account get-access-token --tenant <tenant>" for authorization, so the az CLI must be signed in to an
account that can create container groups in the resource group. Nothing here stores or prints the token.

.EXAMPLE
.\run-suite.ps1 -SubscriptionId $sub -TenantId $tenant -ResourceGroup rg-bench -Image bench.azurecr.io/loadgen:1 `
  -IdentityResourceId $mi -Suite latency -Sites node=http://a.azurewebsites.net,jint=http://b.azurewebsites.net
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $SubscriptionId,
    [Parameter(Mandatory)] [string] $TenantId,
    [Parameter(Mandatory)] [string] $ResourceGroup,
    [Parameter(Mandatory)] [string] $Image,
    [Parameter(Mandatory)] [string] $IdentityResourceId,
    [Parameter(Mandatory)] [ValidateSet('latency', 'sweep', 'mixed', 'soak')] [string] $Suite,
    [Parameter(Mandatory)] [string[]] $Sites,
    [string] $Location = 'westus2',
    [double] $Cpu = 2,
    [double] $MemoryGb = 4,
    [string] $OutDirectory = (Join-Path $PSScriptRoot '..\results\azure'),
    [hashtable] $Environment = @{}
)

$ErrorActionPreference = 'Stop'
$api = '2023-05-01'
$name = 'loadgen-{0}-{1}' -f $Suite, (Get-Date -Format 'yyyyMMddHHmm')
$groupUri = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.ContainerInstance/containerGroups/$name"

function Get-Headers {
    $token = az account get-access-token --tenant $TenantId --resource https://management.azure.com/ --query accessToken -o tsv
    if (-not $token) { throw 'No access token. Sign in with az login.' }
    @{ Authorization = "Bearer $token" }
}

function Invoke-Arm([string] $Method, [string] $Uri, $Body = $null) {
    $arguments = @{ Method = $Method; Uri = $Uri; Headers = (Get-Headers) }
    if ($null -ne $Body) {
        $arguments.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
        $arguments.ContentType = 'application/json'
    }

    try { Invoke-RestMethod @arguments } catch {
        $detail = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        throw "$Method $Uri failed: $detail"
    }
}

$common = (Get-Content (Join-Path $PSScriptRoot 'suites\common.sh') -Raw) -replace "`r`n", "`n"
$body = (Get-Content (Join-Path $PSScriptRoot "suites\$Suite.sh") -Raw) -replace "`r`n", "`n"
$script = $common + "`n" + $body
$registry = $Image.Split('/')[0]

$variables = @($Environment.GetEnumerator() | ForEach-Object { @{ name = $_.Key; value = [string] $_.Value } })
$group = @{
    location = $Location
    identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ $IdentityResourceId = @{} } }
    properties = @{
        osType = 'Linux'
        restartPolicy = 'Never'
        imageRegistryCredentials = @(@{ server = $registry; identity = $IdentityResourceId })
        containers = @(@{
            name = 'loadgen'
            properties = @{
                image = $Image
                command = @('/bin/sh', '-c', $script, 'suite') + $Sites
                resources = @{ requests = @{ cpu = $Cpu; memoryInGB = $MemoryGb } }
                environmentVariables = $variables
            }
        })
    }
}

New-Item -ItemType Directory -Force $OutDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$logPath = Join-Path $OutDirectory "$Suite-$stamp.log"
$jsonPath = Join-Path $OutDirectory "$Suite-$stamp.json"

Write-Host "Creating $name ($Cpu vCPU, $MemoryGb GB) from $Image"
[void] (Invoke-Arm Put "${groupUri}?api-version=$api" $group)
try {
    $lastReport = Get-Date
    while ($true) {
        Start-Sleep -Seconds 20
        $state = Invoke-Arm Get "${groupUri}?api-version=$api"
        $container = $state.properties.containers[0].properties.instanceView.currentState.state
        if ((Get-Date) - $lastReport -gt [TimeSpan]::FromMinutes(1)) {
            $lastReport = Get-Date
            Write-Host ("{0:HH:mm:ss} provisioning={1} container={2}" -f (Get-Date), $state.properties.provisioningState, $container)
        }

        if ($state.properties.provisioningState -eq 'Failed') { throw 'The container group failed to provision.' }
        if ($container -eq 'Terminated') { break }
    }

    $exit = $state.properties.containers[0].properties.instanceView.currentState.exitCode
    $log = (Invoke-Arm Get "$groupUri/containers/loadgen/logs?api-version=$api&tail=50000").content
    [System.IO.File]::WriteAllText($logPath, $log)
    $reports = @($log -split "`n" | Where-Object { $_.StartsWith('#json ') } | ForEach-Object { $_.Substring(6).TrimEnd("`r") })
    [System.IO.File]::WriteAllText($jsonPath, '[' + ($reports -join ',') + ']')
    Write-Host "Exit code $exit, $($reports.Count) reports -> $jsonPath"
}
finally {
    Write-Host "Deleting $name"
    try { [void] (Invoke-Arm Delete "${groupUri}?api-version=$api") } catch { Write-Warning $_ }
}
