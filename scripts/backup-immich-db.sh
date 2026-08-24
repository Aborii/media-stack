#!/bin/bash

###########################################################################
###########################################################################
##
##  Immich Database Backup Script
##  
##  This script backs up the Immich PostgreSQL database from the Docker
##  named volume to the MediaStack data directory for easy access and backup.
##
##  Usage: ./backup-immich-db.sh
##
###########################################################################
###########################################################################

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Change to parent directory where docker-compose files are located
cd "$(dirname "$SCRIPT_DIR")"

# Load environment variables
source docker-compose.env

# Create backup directory
BACKUP_DIR="${FOLDER_FOR_DATA}/immich/backups"
mkdir -p "$BACKUP_DIR"

echo -e "${BLUE}Immich Database Backup${NC}"
echo "======================"
echo ""

# Check if Immich is running
if ! sudo docker ps --format "{{.Names}}" | grep -q "^immich_postgres$"; then
    echo -e "${RED}✗ Immich PostgreSQL container is not running${NC}"
    echo "Please start Immich first with: ./mediastack.sh start immich"
    exit 1
fi

# Create timestamp
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="immich_db_backup_${TIMESTAMP}.sql"

echo -e "${YELLOW}Creating database backup...${NC}"
echo "Backup file: ${BACKUP_FILE}"
echo ""

# Create database dump
if sudo docker exec immich_postgres pg_dump -U "$IMMICH_DB_USERNAME" -d "$IMMICH_DB_DATABASE_NAME" > "$BACKUP_DIR/$BACKUP_FILE" 2>/dev/null; then
    echo -e "${GREEN}✓ Database backup created successfully${NC}"
    echo -e "${BLUE}Location: ${BACKUP_DIR}/${BACKUP_FILE}${NC}"
    
    # Show backup size
    BACKUP_SIZE=$(du -h "$BACKUP_DIR/$BACKUP_FILE" | cut -f1)
    echo -e "${BLUE}Size: ${BACKUP_SIZE}${NC}"
    
    # Compress the backup
    echo -e "${YELLOW}Compressing backup...${NC}"
    gzip "$BACKUP_DIR/$BACKUP_FILE"
    
    COMPRESSED_SIZE=$(du -h "$BACKUP_DIR/$BACKUP_FILE.gz" | cut -f1)
    echo -e "${GREEN}✓ Backup compressed: ${BACKUP_FILE}.gz (${COMPRESSED_SIZE})${NC}"
    
    echo ""
    echo -e "${GREEN}Backup completed successfully!${NC}"
    echo -e "${BLUE}To restore: gunzip ${BACKUP_FILE}.gz && sudo docker exec -i immich_postgres psql -U $IMMICH_DB_USERNAME -d $IMMICH_DB_DATABASE_NAME < ${BACKUP_FILE}${NC}"
    
else
    echo -e "${RED}✗ Failed to create database backup${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}Note: The backup is stored in your MediaStack data directory for easy access and backup.${NC}"