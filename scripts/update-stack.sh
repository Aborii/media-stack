#!/bin/bash

###########################################################################
###########################################################################
##
##  MediaStack Update Script
##
##  This script updates all Docker images and recreates containers
##  Based on the MediaStack Guide
##
##  Usage: ./update-stack.sh
##
###########################################################################
###########################################################################

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}MediaStack Update${NC}"
echo "=================="

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

# Function to load whitelist services
load_whitelist() {
    local whitelist_file="services.whitelist"
    local whitelist_services=""
    
    if [[ -f "$whitelist_file" ]]; then
        # Read whitelist file, ignore comments and empty lines
        whitelist_services=$(grep -v '^#' "$whitelist_file" | grep -v '^[[:space:]]*$' | tr '\n' '|')
        # Remove trailing pipe
        whitelist_services=${whitelist_services%|}
    fi
    
    echo "$whitelist_services"
}

# Function to check if service is in whitelist
is_service_whitelisted() {
    local service_name=$1
    local whitelist=$2
    local use_all=${3:-false}
    
    # If --all flag is used or no whitelist exists, allow all services
    if [[ "$use_all" == "true" ]] || [[ -z "$whitelist" ]]; then
        return 0
    fi
    
    # Check if service is in whitelist
    if echo "$whitelist" | grep -q "$service_name"; then
        return 0
    else
        return 1
    fi
}

# Function to wait for Gluetun VPN connection
wait_for_gluetun_connection() {
    local max_wait=120  # Maximum wait time in seconds
    local wait_interval=5  # Check every 5 seconds
    local elapsed=0
    
    echo -e "${BLUE}Waiting for Gluetun VPN to establish connection...${NC}"
    
    while [[ $elapsed -lt $max_wait ]]; do
        # Check if Gluetun container is running
        if ! sudo docker ps --format "{{.Names}}" | grep -q "^gluetun$"; then
            echo -e "${RED}✗ Gluetun container is not running${NC}"
            return 1
        fi
        
        # Check Gluetun logs for VPN connection status
        local logs=$(sudo docker logs gluetun --tail 50 2>/dev/null)
        
        # Look for the specific successful VPN connection indicator - public IP retrieval
        if echo "$logs" | grep -q "Public IP address is"; then
            local public_ip=$(echo "$logs" | grep "Public IP address is" | tail -1 | sed -n 's/.*Public IP address is \([0-9.]*\).*/\1/p')
            echo -e "${GREEN}✓ Gluetun VPN connection established successfully${NC}"
            if [[ -n "$public_ip" ]]; then
                echo -e "${GREEN}  Public IP: $public_ip${NC}"
            fi
            echo -e "${BLUE}Waiting additional 5 seconds for network stabilization...${NC}"
            sleep 5
            return 0
        fi
        
        # Check for critical connection errors that would prevent IP retrieval
        if echo "$logs" | grep -qE "(fatal|authentication failed|connection refused)" && \
           echo "$logs" | grep -qvE "(retrying|will retry)"; then
            echo -e "${YELLOW}⚠ Warning: Gluetun may have connection issues. Check logs with: ./mediastack.sh logs gluetun${NC}"
        fi
        
        # Show progress
        echo -e "${BLUE}  ⏳ Waiting for VPN connection... (${elapsed}s/${max_wait}s)${NC}"
        sleep $wait_interval
        elapsed=$((elapsed + wait_interval))
    done
    
    echo -e "${YELLOW}⚠ Timeout waiting for Gluetun VPN connection after ${max_wait}s${NC}"
    echo -e "${YELLOW}  Services will start anyway, but VPN may not be ready${NC}"
    echo -e "${BLUE}  Check logs with: ./mediastack.sh logs gluetun${NC}"
    return 1
}

echo -e "${YELLOW}Updating MediaStack: Pulling all images and recreating whitelisted containers...${NC}"
echo ""

# Step 1: Pull ALL Docker images (regardless of whitelist)
echo -e "${BLUE}Step 1: Pulling ALL Docker images...${NC}"
for file in compose/docker-compose-*.yaml; do
    if [[ -f "$file" ]]; then
        service=$(basename "$file" .yaml | sed 's/docker-compose-//')
        echo -e "${YELLOW}Pulling image for $service...${NC}"
        sudo docker compose --file "$file" --env-file docker-compose.env pull
    fi
done

echo ""

# Step 2: Recreate only whitelisted services (same logic as start-all)
echo -e "${BLUE}Step 2: Recreating whitelisted services in correct order...${NC}"

# Load whitelist
whitelist=$(load_whitelist)
use_all=${1:-false}  # Check if --all flag is passed

if [[ "$use_all" == "true" ]]; then
    echo -e "${GREEN}Recreating ALL MediaStack services (--all flag used)...${NC}"
elif [[ -n "$whitelist" ]]; then
    echo -e "${GREEN}Recreating whitelisted services: $(echo "$whitelist" | tr '|' ', '), gluetun${NC}"
else
    echo -e "${GREEN}Recreating all MediaStack services (no whitelist found)...${NC}"
fi
echo ""

# Function to update a service (pull already done, just recreate)
update_service() {
    local file=$1
    local service_name=$2
    
    if [[ -f "$file" ]]; then
        echo -e "${BLUE}Recreating $service_name...${NC}"
        if sudo docker compose --file "$file" --env-file docker-compose.env up -d --force-recreate; then
            echo -e "${GREEN}✓ $service_name recreated successfully${NC}"
        else
            echo -e "${RED}✗ Failed to recreate $service_name${NC}"
        fi
        echo ""
    else
        echo -e "${YELLOW}⚠ $file not found, skipping $service_name${NC}"
    fi
}

# Always start Gluetun first (required for network setup) - regardless of whitelist
if [[ -f "compose/docker-compose-gluetun.yaml" ]]; then
    echo -e "${GREEN}Recreating Gluetun VPN first (required for network setup)...${NC}"
    sudo docker compose --file "compose/docker-compose-gluetun.yaml" --env-file docker-compose.env up -d --force-recreate
    echo ""
    
    # Wait for Gluetun to establish VPN connection
    wait_for_gluetun_connection
fi

# Recreate all other whitelisted services in the correct order
recreated_count=0

# Download clients
if is_service_whitelisted "qbittorrent" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-qbittorrent.yaml" "qBittorrent"
    ((recreated_count++))
fi
if is_service_whitelisted "sabnzbd" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-sabnzbd.yaml" "SABnzbd"
    ((recreated_count++))
fi

# Media management applications
if is_service_whitelisted "prowlarr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-prowlarr.yaml" "Prowlarr"
    ((recreated_count++))
fi
if is_service_whitelisted "lidarr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-lidarr.yaml" "Lidarr"
    ((recreated_count++))
fi
if is_service_whitelisted "mylar" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-mylar.yaml" "Mylar3"
    ((recreated_count++))
fi
if is_service_whitelisted "radarr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-radarr.yaml" "Radarr"
    ((recreated_count++))
fi
if is_service_whitelisted "readarr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-readarr.yaml" "Readarr"
    ((recreated_count++))
fi
if is_service_whitelisted "sonarr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-sonarr.yaml" "Sonarr"
    ((recreated_count++))
fi
if is_service_whitelisted "whisparr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-whisparr.yaml" "Whisparr"
    ((recreated_count++))
fi
if is_service_whitelisted "bazarr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-bazarr.yaml" "Bazarr"
    ((recreated_count++))
fi

# Media servers
if is_service_whitelisted "jellyfin" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-jellyfin.yaml" "Jellyfin"
    ((recreated_count++))
fi
if is_service_whitelisted "jellyseerr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-jellyseerr.yaml" "Jellyseerr"
    ((recreated_count++))
fi
if is_service_whitelisted "plex" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-plex.yaml" "Plex"
    ((recreated_count++))
fi
if is_service_whitelisted "immich" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-immich.yaml" "Immich"
    ((recreated_count++))
fi

# Dashboards
if is_service_whitelisted "homarr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-homarr.yaml" "Homarr"
    ((recreated_count++))
fi
if is_service_whitelisted "homepage" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-homepage.yaml" "Homepage"
    ((recreated_count++))
fi
if is_service_whitelisted "heimdall" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-heimdall.yaml" "Heimdall"
    ((recreated_count++))
fi

# Utility services
if is_service_whitelisted "flaresolverr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-flaresolverr.yaml" "FlareSolverr"
    ((recreated_count++))
fi
if is_service_whitelisted "unpackerr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-unpackerr.yaml" "Unpackerr"
    ((recreated_count++))
fi
if is_service_whitelisted "tdarr" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-tdarr.yaml" "Tdarr"
    ((recreated_count++))
fi

# Management and tools
if is_service_whitelisted "portainer" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-portainer.yaml" "Portainer"
    ((recreated_count++))
fi
if is_service_whitelisted "filebot" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-filebot.yaml" "FileBot"
    ((recreated_count++))
fi

# Reverse proxy and authentication (optional)
if is_service_whitelisted "swag" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-swag.yaml" "SWAG"
    ((recreated_count++))
fi
if is_service_whitelisted "authelia" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-authelia.yaml" "Authelia"
    ((recreated_count++))
fi
if is_service_whitelisted "ddns-updater" "$whitelist" "$use_all"; then
    update_service "compose/docker-compose-ddns-updater.yaml" "DDNS Updater"
    ((recreated_count++))
fi

echo ""
if [[ $recreated_count -gt 0 ]] || is_service_whitelisted "gluetun" "$whitelist" "$use_all"; then
    echo -e "${GREEN}✓ MediaStack update complete! Images pulled and whitelisted services recreated.${NC}"
else
    echo -e "${YELLOW}⚠ Images updated but no services were recreated (check your whitelist)${NC}"
fi
echo ""
echo -e "${BLUE}Service Status:${NC}"
sudo docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
if [[ -n "$whitelist" && "$use_all" != "true" ]]; then
    echo -e "${BLUE}Note: Only whitelisted services were recreated. Use 'update --all' to recreate all services.${NC}"
fi
echo -e "${YELLOW}Update complete! All images are up-to-date and whitelisted services are running latest versions.${NC}"