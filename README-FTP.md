# MediaStack FTP Stack

This stack provides both an FTP server and a web-based FTP client for easy file transfers within your local network.

## Components

- **FTP Server** (`garethflowers/ftp-server`): Lightweight FTP server
- **FTP Client** (`jlesage/filezilla`): Web-based FileZilla client

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
  - Host: `localhost` or your Docker host IP
  - Port: `21` (standard FTP)
  - Username/Password: As configured in `FTP_USER`/`FTP_PASS`

- **FileZilla Web UI**: 
  - URL: `http://localhost:5800` (or your configured port)
  - No authentication required for the web interface

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
   WEBUI_PORT_FTP_CLIENT=5900
   ```

2. Restart the FTP client:
   ```bash
   ./scripts/mediastack.sh restart ftp
   ```

## Usage

### Connecting via FileZilla Web UI

1. Open your browser to `http://localhost:5800`
2. In FileZilla, connect to your FTP server:
   - Host: `ftp-server` (Docker service name) or Docker host IP
   - Port: `21`
   - Username: Your `FTP_USER` value
   - Password: Your `FTP_PASS` value
   - Protocol: FTP

### File Storage

Files uploaded/downloaded through the FTP server are stored in:
- Container path: `/home/${FTP_USER}/shared`
- Host path: `${FOLDER_FOR_CONFIG_DATA}/ftp-shared`

Both the FTP server and FileZilla client have access to this shared directory.

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

2. **FileZilla web UI not accessible**:
   - Verify container is running: `docker ps | grep ftp-client`
   - Check if port is in use: `netstat -ln | grep 5800`
   - Try different port in compose file

3. **File permission issues**:
   - Ensure `PUID`/`PGID` in `docker-compose.env` match your user
   - Check ownership of `${FOLDER_FOR_CONFIG_DATA}/ftp-shared`

## Advanced Configuration

### Custom Passive Port Range

Edit [compose/docker-compose-ftp.yaml](compose/docker-compose-ftp.yaml) to change the passive port range:
```yaml
ports:
  - "21:21"
  - "20:20"
  - "50000-50010:50000-50010"  # Custom range
```

### Additional FTP Users

The current setup supports a single FTP user. For multiple users, consider using a more advanced FTP server like `stilliard/pure-ftpd`.

## Integration with MediaStack

The FTP stack integrates seamlessly with MediaStack:
- Uses the same `mediastack` network
- Follows MediaStack naming conventions
- Managed by [mediastack.sh](scripts/mediastack.sh) scripts
- Environment variables in `docker-compose.env`
- Service whitelist support
