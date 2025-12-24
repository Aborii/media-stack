#!/bin/bash

###########################################################################
###########################################################################
##
##  MediaStack Startup Script
##
##  This script starts all MediaStack services in the correct order
##  Based on the MediaStack Guide - GLUETUN MUST BE STARTED FIRST
##
##  Usage: ./start-stack.sh
##
###########################################################################
###########################################################################

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}MediaStack Startup${NC}"
echo "==================="

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Change to parent directory where docker-compose files are located
cd "$(dirname "$SCRIPT_DIR")"

# Check if docker-compose.env exists
if [[ ! -f "docker-compose.env" ]]; then
    echo -e "${RED}✗ docker-compose.env file not found!${NC}"
    echo "Please make sure the environment file exists in the same directory as this script."
    exit 1
fi

# Function to start a service
start_service() {
    local file=$1
    local service_name=$2
    
    if [[ -f "$file" ]]; then
        echo -e "${BLUE}Starting $service_name...${NC}"
        if sudo docker compose --file "$file" --env-file docker-compose.env up -d; then
            echo -e "${GREEN}✓ $service_name started successfully${NC}"
        else
            echo -e "${RED}✗ Failed to start $service_name${NC}"
        fi
        echo ""
    else
        echo -e "${YELLOW}⚠ $file not found, skipping $service_name${NC}"
    fi
}

echo -e "${YELLOW}Starting MediaStack services in correct order...${NC}"
echo ""

# GLUETUN MUST BE THE FIRST CONTAINER CREATED - IT SETS UP DOCKER NETWORK AND VPN
start_service "compose/docker-compose-gluetun.yaml" "Gluetun VPN"

# Download clients
start_service "compose/docker-compose-qbittorrent.yaml" "qBittorrent"
start_service "compose/docker-compose-sabnzbd.yaml" "SABnzbd"

# Media management applications
start_service "compose/docker-compose-prowlarr.yaml" "Prowlarr"
start_service "compose/docker-compose-lidarr.yaml" "Lidarr"
start_service "compose/docker-compose-mylar.yaml" "Mylar3"
start_service "compose/docker-compose-radarr.yaml" "Radarr"
start_service "compose/docker-compose-readarr.yaml" "Readarr"
start_service "compose/docker-compose-sonarr.yaml" "Sonarr"
start_service "compose/docker-compose-whisparr.yaml" "Whisparr"
start_service "compose/docker-compose-bazarr.yaml" "Bazarr"

# Media servers
start_service "compose/docker-compose-jellyfin.yaml" "Jellyfin"
start_service "compose/docker-compose-jellyseerr.yaml" "Jellyseerr"
start_service "compose/docker-compose-plex.yaml" "Plex"
start_service "compose/docker-compose-immich.yaml" "Immich"

# Dashboards
start_service "compose/docker-compose-homarr.yaml" "Homarr"
start_service "compose/docker-compose-homepage.yaml" "Homepage"
start_service "compose/docker-compose-heimdall.yaml" "Heimdall"

# Utility services
start_service "compose/docker-compose-flaresolverr.yaml" "FlareSolverr"
start_service "compose/docker-compose-unpackerr.yaml" "Unpackerr"
start_service "compose/docker-compose-tdarr.yaml" "Tdarr"

# Management and tools
start_service "compose/docker-compose-portainer.yaml" "Portainer"
start_service "compose/docker-compose-filebot.yaml" "FileBot"

# Reverse proxy and authentication (optional)
start_service "compose/docker-compose-swag.yaml" "SWAG"
start_service "compose/docker-compose-authelia.yaml" "Authelia"
start_service "compose/docker-compose-ddns-updater.yaml" "DDNS Updater"

echo -e "${GREEN}✓ MediaStack startup complete!${NC}"
echo ""
echo -e "${BLUE}Service Status:${NC}"
sudo docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Check service logs: ./logs.sh"
echo "2. View service status: ./status.sh"
echo "3. Import bookmarks and configure applications"
echo "4. Visit https://MediaStack.Guide for configuration details"