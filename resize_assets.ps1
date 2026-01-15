
Add-Type -AssemblyName System.Drawing

function Resize-Image {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [int]$Width,
        [int]$Height
    )

    if (-not (Test-Path $SourcePath)) {
        Write-Error "Source file not found: $SourcePath"
        return
    }

    $srcImage = [System.Drawing.Image]::FromFile($SourcePath)
    $newImage = new-object System.Drawing.Bitmap $Width, $Height

    $graphics = [System.Drawing.Graphics]::FromImage($newImage)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $graphics.DrawImage($srcImage, 0, 0, $Width, $Height)
    
    $newImage.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Png)
    
    $graphics.Dispose()
    $srcImage.Dispose()
    $newImage.Dispose()
    
    Write-Host "Created $DestinationPath (${Width}x${Height})"
}

# Paths
$iconSource = "C:\Users\GuestUser\.gemini\antigravity\brain\5266951c-af51-4231-8cfe-148cbe5af4af\netrot_minimal_icon_v2_1767572171947.png"
$promoSource = "C:\Users\GuestUser\.gemini\antigravity\brain\5266951c-af51-4231-8cfe-148cbe5af4af\netrot_store_promo_tile_1767572262877.png"
$assetsDir = "d:\extensions\NetRot\assets"
$promoDir = "d:\extensions\NetRot\store_assets"

# Ensure directories exist
if (-not (Test-Path $promoDir)) { New-Item -ItemType Directory -Path $promoDir | Out-Null }

# Resize Icons (Manifest requirements)
Resize-Image -SourcePath $iconSource -DestinationPath "$assetsDir\icon128.png" -Width 128 -Height 128
Resize-Image -SourcePath $iconSource -DestinationPath "$assetsDir\icon48.png" -Width 48 -Height 48
Resize-Image -SourcePath $iconSource -DestinationPath "$assetsDir\icon16.png" -Width 16 -Height 16

# Resize Store Assets (Upload requirements)
Resize-Image -SourcePath $promoSource -DestinationPath "$promoDir\marquee_1400x560.png" -Width 1400 -Height 560
Resize-Image -SourcePath $promoSource -DestinationPath "$promoDir\small_tile_440x280.png" -Width 440 -Height 280
