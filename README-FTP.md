# MediaStack FTP Stack

This stack provides both an FTP server and a modern web-based file manager for easy file transfers within your local network and mobile access.

## Components

- **FTP Server** (`stilliard/pure-ftpd`): Pure-FTPd server with passive mode support
- **File Manager** (`filebrowser/filebrowser`): Modern web-based file manager with intuitive interface

## Features

- ✅ **Mobile-Friendly FTP Access** - Connect from Android/iOS FTP clients
- ✅ **Passive Mode Support** - Works through NAT and firewalls
- ✅ **Modern Web Interface** - FileBrowser instead of FileZilla VNC
- ✅ **Dynamic IP Detection** - Automatic network configuration
- ✅ **Windows WSL Support** - Port forwarding script for external access
- ✅ **Secure Configuration** - Local network focused with proper authentication

## Quick Start

1. **Configure environment variables** (if not already done):
   ```bash
   cp docker-compose.env.example docker-compose.env
   ```
   
   Edit `docker-compose.env` and set:
   - `FTP_USER=your-username`
   - `FTP_PASS=your-secure-password`
   - `WEBUI_PORT_FTP_CLIENT=5800` (or your preferred port)

2. **Create the shared directory**:
   ```bash
   # The setup script will create this automatically
   ./scripts/mediastack.sh setup
   
   # Or create manually:
   mkdir -p "${FOLDER_FOR_CONFIG_DATA}/ftp-shared"
   ```

3. **Start the FTP stack**:
   ```bash
   ./scripts/mediastack.sh start ftp
   
   # Or start all services:
   ./scripts/mediastack.sh start
   ```

## Access

- **FTP Server**: 
  - Host: `localhost` or your Docker host IP (configured as `${LOCAL_DOCKER_IP}`)
  - Port: `21` (standard FTP)
  - Username/Password: As configured in `FTP_USER`/`FTP_PASS`
  - Passive Ports: `40000-40009`

- **File Manager Web UI**: 
  - URL: `http://localhost:5800` (or your configured `WEBUI_PORT_FILE_MANAGER`)
  - Username: `admin` (default)
  - Password: `admin` (default - change after first login)

## Mobile Access Setup (Windows WSL)

For external access from phones/tablets on your network:

1. **Run the Windows port forwarding script** (as Administrator):
   ```powershell
   # Navigate to MediaStack directory in Windows PowerShell
   cd "D:\MediaStack\AppData"  # Adjust path as needed
   .\scripts\setup-ftp-windows-access.ps1
   ```

2. **The script automatically**:
   - Detects your WSL IP address
   - Detects your Windows host IP  
   - Sets up port forwarding (21, 20, 40000-40009)
   - Configures Windows Firewall rules
   - Shows connection details

3. **Connect from your phone** using the detected IP addresses

## Configuration
## Configuration

### Changing FTP Credentials

1. Edit `docker-compose.env`:
   ```env
   FTP_USER=newusername
   FTP_PASS=newsecurepassword
   ```

2. Restart the FTP stack:
   ```bash
   ./scripts/mediastack.sh restart ftp
   ```

### Changing Web UI Port

1. Edit `docker-compose.env`:
   ```env
   WEBUI_PORT_FILE_MANAGER=5900
   ```

2. Restart the file manager:
   ```bash
   ./scripts/mediastack.sh restart ftp
   ```

### Dynamic IP Configuration

The FTP server now uses environment variables for flexible deployment:
- `FTP_PASV_ADDRESS=${LOCAL_DOCKER_IP}` - Automatically uses your host IP
- No hardcoded IP addresses in compose files
- Easy network reconfiguration by updating `docker-compose.env`

## Usage

### Using FileBrowser Web Interface

1. Open your browser to `http://localhost:5800` (or your configured port)
2. Login with default credentials (`admin`/`admin`)
3. **IMPORTANT**: Change the default password on first login
4. Upload, download, and manage files through the modern web interface
5. Supports drag-and-drop, file previews, and mobile-responsive design

### Connecting via FTP Client

**Desktop FTP Clients** (FileZilla, WinSCP, etc.):
- Host: `localhost` or your Docker host IP
- Port: `21`
- Username: Your `FTP_USER` value  
- Password: Your `FTP_PASS` value
- Mode: Passive (recommended)

**Mobile FTP Clients** (after running Windows port forwarding script):
- Host: Your Windows machine IP (displayed by setup script)
- Port: `21`
- Same username/password as above

### File Storage

Files uploaded/downloaded through both the FTP server and FileBrowser are stored in:
- Container path: `/data` (FTP server) and `/srv` (FileBrowser)  
- Host path: `${FOLDER_FOR_FTP_STORAGE}` (configured in `docker-compose.env`)

Both services share the same directory for seamless file access.

## Security Notes

- **LAN Only**: The FTP server is configured for local network access only
- **No Public Access**: Do not expose FTP ports (20-21, 40000-40009) to the internet
- **Firewall**: Consider restricting access to trusted IPs only
- **Passive Ports**: Range 40000-40009 is used for passive FTP connections

## Troubleshooting

### Check Service Status
```bash
./scripts/mediastack.sh status
```

### View Logs
```bash
./scripts/mediastack.sh logs ftp
```

### Connection Issues

1. **Can't connect to FTP server**:
   - Verify FTP server is running: `docker ps | grep ftp-server`
   - Check firewall settings on Docker host
   - Ensure passive port range (40000-40009) is accessible
   - For external access, run the Windows port forwarding script

2. **FileBrowser web UI not accessible**:
   - Verify container is running: `docker ps | grep file-manager`
   - Check if port is in use: `netstat -ln | grep 5800`
   - Try different port in `WEBUI_PORT_FILE_MANAGER`

3. **File permission issues**:
   - Ensure `PUID`/`PGID` in `docker-compose.env` match your user
   - Check ownership of `${FOLDER_FOR_FTP_STORAGE}`

4. **Mobile access not working**:
   - Ensure Windows port forwarding script was run as Administrator
   - Check Windows Firewall allows the FTP ports
   - Verify your phone is on the same network as your Windows machine

## Advanced Configuration

### Custom Passive Port Range

Edit [compose/docker-compose-ftp.yaml](compose/docker-compose-ftp.yaml) and [compose/docker-compose-gluetun.yaml](compose/docker-compose-gluetun.yaml) to change the passive port range:
```yaml
# In docker-compose-gluetun.yaml
ports:
  - "21:21"
  - "20:20" 
  - "50000-50010:50000-50010"  # Custom range
```

Then update `FTP_PASV_PORTRANGE` in the FTP server environment.

### Windows Port Forwarding Script

The included PowerShell script (`scripts/setup-ftp-windows-access.ps1`) provides:
- **Dynamic IP Detection** - Automatically finds WSL and Windows IPs
- **Automatic Port Forwarding** - Sets up all required port mappings
- **Firewall Configuration** - Creates Windows Firewall rules
- **Connection Information** - Shows exact connection details for mobile access

Run as Administrator for full functionality.

### Additional FTP Users

Pure-FTPd supports virtual users. For multiple users, modify the FTP server configuration to use a user database file.

## Integration with MediaStack

The FTP stack integrates seamlessly with MediaStack:
- Uses the same `mediastack` network
- Follows MediaStack naming conventions
- Managed by [mediastack.sh](scripts/mediastack.sh) scripts
- Environment variables in `docker-compose.env`
- Service whitelist support
