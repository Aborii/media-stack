#!/bin/bash

###########################################################################
###########################################################################
##
##  MediaStack Directory Setup Script
##
##  This script creates all necessary directories for the MediaStack
##  Based on the MediaStack Guide
##
##  Usage: ./setup-directories.sh
##
###########################################################################
###########################################################################

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}MediaStack Directory Setup${NC}"
echo "================================="

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Change to parent directory where docker-compose files are located
cd "$(dirname "$SCRIPT_DIR")"

# Check if docker-compose.env exists and source it
if [[ -f "docker-compose.env" ]]; then
    source docker-compose.env
    echo -e "${GREEN}✓ Environment file loaded${NC}"
else
    echo -e "${RED}✗ docker-compose.env file not found!${NC}"
    echo "Please make sure the environment file exists in the same directory as this script."
    exit 1
fi

# Verify required variables
if [[ -z "$FOLDER_FOR_MEDIA" || -z "$FOLDER_FOR_CONFIG_DATA" || -z "$FOLDER_FOR_FTP_STORAGE" || -z "$PUID" || -z "$PGID" ]]; then
    echo -e "${RED}✗ Required environment variables not found in docker-compose.env${NC}"
    echo "Please ensure FOLDER_FOR_MEDIA, FOLDER_FOR_CONFIG_DATA, FOLDER_FOR_FTP_STORAGE, PUID, and PGID are set."
    exit 1
fi

echo -e "${YELLOW}Creating MediaStack directories...${NC}"
echo "Media folder: $FOLDER_FOR_MEDIA"
echo "Data folder: $FOLDER_FOR_CONFIG_DATA"
echo "FTP storage folder: $FOLDER_FOR_FTP_STORAGE"
echo "PUID: $PUID, PGID: $PGID"
echo ""

# Export variables for use with sudo -E
export FOLDER_FOR_MEDIA
export FOLDER_FOR_CONFIG_DATA
export FOLDER_FOR_FTP_STORAGE
export PUID
export PGID

# Create data directories for applications
echo -e "${BLUE}Creating application data directories...${NC}"
sudo -E mkdir -p $FOLDER_FOR_CONFIG_DATA/{authelia/assets,bazarr,ddns-updater,flaresolverr,file-manager,ftp-shared,gluetun,heimdall,homarr/{configs,data,icons},homepage,immich/{library,postgres,model-cache},jellyfin,jellyseerr,lidarr,mylar,plex,portainer,prowlarr,qbittorrent,radarr,readarr,sabnzbd,sonarr,swag,tdarr/{server,configs,logs},tdarr_transcode_cache,unpackerr,whisparr}

# Create media directories
echo -e "${BLUE}Creating media directories...${NC}"
sudo -E mkdir -p $FOLDER_FOR_MEDIA/media/{anime,audio,books,comics,movies,music,photos,tv,xxx}

# Create usenet directories
echo -e "${BLUE}Creating usenet directories...${NC}"
sudo -E mkdir -p $FOLDER_FOR_MEDIA/usenet/{anime,audio,books,comics,complete,console,incomplete,movies,music,prowlarr,software,tv,xxx}

# Create torrent directories
echo -e "${BLUE}Creating torrent directories...${NC}"
sudo -E mkdir -p $FOLDER_FOR_MEDIA/torrents/{anime,audio,books,comics,complete,console,incomplete,movies,music,prowlarr,qbittorrent,software,tv,xxx}

# Create additional directories
echo -e "${BLUE}Creating additional directories...${NC}"
sudo -E mkdir -p $FOLDER_FOR_MEDIA/watch
sudo -E mkdir -p $FOLDER_FOR_MEDIA/filebot/{input,output}
sudo -E mkdir -p $FOLDER_FOR_MEDIA/cloud-backup

# Create FTP storage directory
echo -e "${BLUE}Creating FTP storage directory...${NC}"
sudo -E mkdir -p $FOLDER_FOR_FTP_STORAGE

# Set permissions
echo -e "${BLUE}Setting permissions...${NC}"
sudo -E chmod -R 775 $FOLDER_FOR_MEDIA $FOLDER_FOR_CONFIG_DATA $FOLDER_FOR_FTP_STORAGE
sudo -E chown -R $PUID:$PGID $FOLDER_FOR_MEDIA $FOLDER_FOR_CONFIG_DATA $FOLDER_FOR_FTP_STORAGE

echo ""
echo -e "${GREEN}✓ Directory setup complete!${NC}"
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Run ./pull-images.sh to download all Docker images"
echo "2. Run ./start-stack.sh to start the MediaStack services"