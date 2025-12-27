# MediaStack FTP Windows Access Setup Script
# This script sets up port forwarding and firewall rules to allow FTP access from Windows/network to WSL
# 
# IMPORTANT: Run this script as Administrator in Windows PowerShell
# Right-click on PowerShell and select "Run as Administrator"
#
# Usage: .\setup-ftp-windows-access.ps1

Write-Host "MediaStack FTP Windows Access Setup" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Green
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")

if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Please right-click PowerShell and select 'Run as Administrator'" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Running as Administrator - OK" -ForegroundColor Green
Write-Host ""

# WSL IP Address (update if different)
$wslIP = "172.21.214.197"
Write-Host "Setting up port forwarding for WSL IP: $wslIP" -ForegroundColor Yellow
Write-Host ""

try {
    Write-Host "Adding port forwarding rules..." -ForegroundColor Blue
    
    # Add FTP control port
    Write-Host "  - Adding FTP control port 21..."
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=21 connectaddress=$wslIP connectport=21
    
    # Add FTP data port  
    Write-Host "  - Adding FTP data port 20..."
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=20 connectaddress=$wslIP connectport=20
    
    # Add passive mode ports
    Write-Host "  - Adding FTP passive ports 40000-40009..."
    for ($i = 40000; $i -le 40009; $i++) {
        netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$i connectaddress=$wslIP connectport=$i | Out-Null
    }
    
    Write-Host "Port forwarding rules added successfully" -ForegroundColor Green
    Write-Host ""
    
    Write-Host "Adding Windows Firewall rules..." -ForegroundColor Blue
    
    # Add firewall rule for FTP control
    Write-Host "  - Adding firewall rule for FTP control port..."
    New-NetFirewallRule -DisplayName "MediaStack-FTP-Control" -Direction Inbound -Protocol TCP -LocalPort 21 -Action Allow | Out-Null
    
    # Add firewall rule for FTP data and passive ports
    Write-Host "  - Adding firewall rule for FTP data and passive ports..."
    New-NetFirewallRule -DisplayName "MediaStack-FTP-Data" -Direction Inbound -Protocol TCP -LocalPort 20,40000-40009 -Action Allow | Out-Null
    
    Write-Host "Firewall rules added successfully" -ForegroundColor Green
    Write-Host ""
    
    Write-Host "Setup completed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "You can now connect to your FTP server from your phone using:" -ForegroundColor Yellow
    Write-Host "  Host: 192.168.0.114" -ForegroundColor White
    Write-Host "  Port: 21" -ForegroundColor White
    Write-Host "  Username: aborii" -ForegroundColor White
    Write-Host "  Password: secure_password_goes_here" -ForegroundColor White
    Write-Host ""
    Write-Host "Web File Manager: http://192.168.0.114:5800" -ForegroundColor Yellow
    Write-Host ""
    
} catch {
    Write-Host "Error occurred: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please ensure you are running as Administrator and try again." -ForegroundColor Red
}

Write-Host "Press Enter to exit..." -ForegroundColor Gray
Read-Host