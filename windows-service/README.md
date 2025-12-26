# WSL Ubuntu Monitoring Service Setup

This directory contains automated scripts to set up WSL as a Windows Service for Docker container stacks.

## What This Does

The WSL Ubuntu Monitoring service ensures that:
- WSL Ubuntu starts automatically when Windows boots
- Docker containers can run in WSL even when no user is logged in
- The system maintains WSL connectivity for background operations
- Docker daemon stays active for container stacks (MediaStack, other projects)

## Quick Setup

### 1. Run the Installer (As Administrator)

Right-click `install-wsl-service.bat` and select **"Run as administrator"**

The installer will:
- ✅ Download Windows Service Wrapper automatically
- ✅ Create service configuration files  
- ✅ Install the WSL Ubuntu Monitoring service
- ✅ Configure automatic startup

### 2. Configure Service Credentials

After installation, you MUST configure the service to run with your user account:

1. Open **Services** (`Win+R` → `services.msc`)
2. Find **"WSL Ubuntu Monitoring Service"**
3. Right-click → **Properties** → **Log On** tab
4. Select **"This account"** 
5. Enter your Windows username and password
6. Click **OK**

**⚠️ IMPORTANT:** Your Windows account MUST have a password set!

### 3. Start the Service

The installer will attempt to start the service automatically, or you can use:
```cmd
manage-service.bat
```

## Files Created

The installer automatically determines your MediaStack directory from `docker-compose.env` and creates:

```
{YOUR_MEDIASTACK_DIR}\windows-service\
├── wsl-ubuntu-monitoring.exe      # Windows Service Wrapper
├── wsl-ubuntu-monitoring.xml      # Service configuration  
├── wsl-ubuntu-monitoring.out.log  # Service output logs
└── wsl-ubuntu-monitoring.err.log  # Service error logs
```

**Example paths:**
- If `FOLDER_FOR_CONFIG_DATA=/mnt/d/MediaStack/AppData/data` → Service files in `D:\MediaStack\windows-service\`
- If `FOLDER_FOR_CONFIG_DATA=/mnt/h/MyMedia/AppData/data` → Service files in `H:\MyMedia\windows-service\`

## Service Management

Use `manage-service.bat` for easy service management:

- **Start Service** - Start WSL MediaStack service
- **Stop Service** - Stop the service
- **Restart Service** - Restart the service  
- **Service Status** - Check if service is running
- **View Logs** - View service output logs
- **Uninstall Service** - Remove the service completely

## Manual Commands

Replace `{YOUR_MEDIASTACK_DIR}` with your actual MediaStack directory:

```cmd
# Service management
{YOUR_MEDIASTACK_DIR}\windows-service\wsl-ubuntu-monitoring.exe start
{YOUR_MEDIASTACK_DIR}\windows-service\wsl-ubuntu-monitoring.exe stop  
{YOUR_MEDIASTACK_DIR}\windows-service\wsl-ubuntu-monitoring.exe status
{YOUR_MEDIASTACK_DIR}\windows-service\wsl-ubuntu-monitoring.exe restart

# Uninstall
{YOUR_MEDIASTACK_DIR}\windows-service\wsl-ubuntu-monitoring.exe uninstall
```

**Note:** The scripts automatically detect your MediaStack directory from `docker-compose.env`

## Troubleshooting

### Service Won't Start
- Ensure your Windows account has a password
- Check service is configured to run as your user account
- Verify WSL Ubuntu is installed and working

### Service Starts But MediaStack Won't Work
- Check WSL is actually running: `wsl --status`
- Test WSL access: `wsl -d ubuntu`
- Check Docker is installed in WSL Ubuntu

### View Service Logs
```cmd
# Use manage-service.bat for easy log viewing, or manually:
type {YOUR_MEDIASTACK_DIR}\windows-service\wsl-ubuntu-monitoring.out.log
type {YOUR_MEDIASTACK_DIR}\windows-service\wsl-ubuntu-monitoring.err.log
```

## What the Service Does

The service runs this command in WSL:
```bash
wsl -d ubuntu --exec /bin/bash -c "echo 'WSL Ubuntu monitoring service started' && while true; do sleep 30; done"
```

This:
- Starts WSL Ubuntu distribution
- Keeps WSL running in background
- Allows Docker daemon to stay active
- Enables container stacks to run (MediaStack, other Docker projects)

## Testing

After setup and reboot:

1. Check service is running:
   ```cmd
   # Use manage-service.bat, or manually check status
   {YOUR_MEDIASTACK_DIR}\windows-service\wsl-ubuntu-monitoring.exe status
   ```

2. Test WSL access:
   ```cmd
   wsl -d ubuntu
   ```

3. Start your container stacks:
   ```bash
   # For MediaStack
   cd /mnt/d/MediaStack/AppData
   ./mediastack.sh start-all
   
   # For other Docker projects
   cd /path/to/your/project
   docker compose up -d
   ```

## Benefits

- **Automatic Startup** - WSL starts with Windows
- **Background Operation** - Works without user login
- **Universal Support** - Works for MediaStack and other Docker projects
- **Service Management** - Standard Windows service controls
- **Logging** - Service logs for troubleshooting
- **Easy Management** - Batch scripts for common tasks