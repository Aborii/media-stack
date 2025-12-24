#!/bin/bash

###########################################################################
###########################################################################
##
##  MediaStack Unified Management Script
##
##  This script provides complete MediaStack management functionality
##
##  Setup & Installation:
##    ./mediastack.sh setup              - Create directories and setup environment
##    ./mediastack.sh pull               - Pull all Docker images
##    ./mediastack.sh update             - Pull latest images and restart
##
##  Service Management:
##    ./mediastack.sh start              - Start all services (Gluetun first)
##    ./mediastack.sh stop               - Stop all services
##    ./mediastack.sh restart            - Restart all services
##    ./mediastack.sh start-all          - Start all services (Gluetun first)
##    ./mediastack.sh stop-all           - Stop running services (keep containers)
##    ./mediastack.sh restart-all        - Restart all services
##    ./mediastack.sh remove-all         - Stop and remove all containers
##
##  Individual Services:
##    ./mediastack.sh start <service>    - Start individual service
##    ./mediastack.sh stop <service>     - Stop individual service
##    ./mediastack.sh restart <service>  - Restart individual service
##    ./mediastack.sh logs <service>     - Show logs for individual service
##
##  Monitoring:
##    ./mediastack.sh logs               - Show logs for all services
##    ./mediastack.sh status             - Show status of all services
##    ./mediastack.sh list               - List all available services
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

# Function to check if docker-compose.env exists
check_env_file() {
    if [[ ! -f "docker-compose.env" ]]; then
        echo -e "${RED}Error: docker-compose.env file not found!${NC}"
        echo "Please make sure the environment file exists in the same directory as this script."
        exit 1
    fi
}

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

# Function to get filtered compose files based on whitelist
get_filtered_compose_files() {
    local use_all=${1:-false}
    local whitelist=$(load_whitelist)
    local filtered_files=""
    
    for file in compose/docker-compose-*.yaml; do
        if [[ -f "$file" ]]; then
            local service=$(basename "$file" .yaml | sed 's/docker-compose-//')
            if is_service_whitelisted "$service" "$whitelist" "$use_all"; then
                filtered_files="$filtered_files $file"
            fi
        fi
    done
    
    echo "$filtered_files"
}

# Function to run docker compose with proper environment
run_compose() {
    docker compose --env-file docker-compose.env "$@"
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

# Function to find the compose file for a service
find_compose_file() {
    local service_name=$1
    local compose_file=""
    
    # Check if it's a direct docker-compose file name
    if [[ -f "compose/docker-compose-${service_name}.yaml" ]]; then
        compose_file="compose/docker-compose-${service_name}.yaml"
    else
        # Search for the service in all compose files
        for file in compose/docker-compose-*.yaml; do
            if [[ -f "$file" ]]; then
                if grep -q "container_name: ${service_name}" "$file" 2>/dev/null; then
                    compose_file="$file"
                    break
                fi
            fi
        done
    fi
    
    echo "$compose_file"
}

# Function to list available services
list_services() {
    echo -e "${BLUE}Available services:${NC}"
    echo "==================="
    
    for file in compose/docker-compose-*.yaml; do
        if [[ -f "$file" ]]; then
            service=$(basename "$file" .yaml | sed 's/docker-compose-//')
            container_name=$(grep "container_name:" "$file" 2>/dev/null | head -1 | awk '{print $2}')
            if [[ -n "$container_name" ]]; then
                echo -e "${GREEN}$service${NC} (container: $container_name)"
            else
                echo -e "${YELLOW}$service${NC}"
            fi
        fi
    done
    
    echo ""
    echo -e "${BLUE}Running containers:${NC}"
    sudo docker ps --format "table {{.Names}}\t{{.Status}}"
}

# Function to start all services in correct order (Gluetun first)
start_all_services() {
    local use_all=${1:-false}
    local whitelist=$(load_whitelist)
    
    if [[ "$use_all" == "true" ]]; then
        echo -e "${GREEN}Starting ALL MediaStack services (--all flag used)...${NC}"
    elif [[ -n "$whitelist" ]]; then
        echo -e "${GREEN}Starting whitelisted services: $(echo "$whitelist" | tr '|' ', '), gluetun${NC}"
    else
        echo -e "${GREEN}Starting all MediaStack services (no whitelist found)...${NC}"
    fi
    echo -e "${BLUE}Starting in correct order (Gluetun first)${NC}"
    echo ""
    
    # Always start Gluetun first (required for network setup) - regardless of whitelist
    if [[ -f "compose/docker-compose-gluetun.yaml" ]]; then
        echo -e "${GREEN}Starting Gluetun VPN (required first)...${NC}"
        sudo docker compose --file "compose/docker-compose-gluetun.yaml" --env-file docker-compose.env up -d
        echo ""
        
        # Wait for Gluetun to establish VPN connection
        wait_for_gluetun_connection
    fi
    
    # Start all other whitelisted services
    local started_count=0
    for file in compose/docker-compose-*.yaml; do
        if [[ "$file" != "compose/docker-compose-gluetun.yaml" && -f "$file" ]]; then
            service=$(basename "$file" .yaml | sed 's/docker-compose-//')
            if is_service_whitelisted "$service" "$whitelist" "$use_all"; then
                echo -e "${BLUE}Starting $service...${NC}"
                sudo docker compose --file "$file" --env-file docker-compose.env up -d
                ((started_count++))
            fi
        fi
    done
    
    echo ""
    if [[ $started_count -gt 0 ]] || is_service_whitelisted "gluetun" "$whitelist" "$use_all"; then
        echo -e "${GREEN}✓ Whitelisted services started!${NC}"
    else
        echo -e "${YELLOW}⚠ No services were started (check your whitelist)${NC}"
    fi
}

# Function to stop all running services (without removing containers)
stop_all_services() {
    echo -e "${YELLOW}Stopping all running MediaStack services...${NC}"
    echo ""
    
    # Get list of running MediaStack containers
    local all_running=$(sudo docker ps --format "{{.Names}}" | grep -E "(gluetun|bazarr|immich|jellyfin|jellyseerr|lidarr|mylar|plex|portainer|prowlarr|qbittorrent|radarr|readarr|sabnzbd|sonarr|swag|tdarr|unpackerr|whisparr|flaresolverr|homarr|homepage|heimdall|ddns-updater|authelia|filebot)")
    
    if [[ -z "$all_running" ]]; then
        echo -e "${BLUE}No MediaStack containers are currently running.${NC}"
        return
    fi
    
    local stopped_count=0
    # Stop each running container
    while IFS= read -r container; do
        if [[ -n "$container" ]]; then
            echo -e "${YELLOW}Stopping $container...${NC}"
            sudo docker stop "$container"
            ((stopped_count++))
        fi
    done <<< "$all_running"
    
    echo ""
    if [[ $stopped_count -gt 0 ]]; then
        echo -e "${YELLOW}✓ All running services stopped!${NC}"
    else
        echo -e "${BLUE}ℹ No services were running.${NC}"
    fi
    echo -e "${BLUE}Containers are preserved and can be started again.${NC}"
}

# Function to remove all services (stop and remove containers)
remove_all_services() {
    echo -e "${RED}Removing ALL MediaStack services and containers...${NC}"
    echo -e "${YELLOW}This will stop and remove containers but preserve volumes/data.${NC}"
    echo ""
    
    # Get list of all MediaStack containers (running and stopped)
    local all_containers=$(sudo docker ps -a --format "{{.Names}}" | grep -E "(gluetun|bazarr|immich|jellyfin|jellyseerr|lidarr|mylar|plex|portainer|prowlarr|qbittorrent|radarr|readarr|sabnzbd|sonarr|swag|tdarr|unpackerr|whisparr|flaresolverr|homarr|homepage|heimdall|ddns-updater|authelia|filebot)")
    
    if [[ -z "$all_containers" ]]; then
        echo -e "${BLUE}No MediaStack containers found.${NC}"
        return
    fi
    
    local removed_count=0
    # Stop and remove each container
    while IFS= read -r container; do
        if [[ -n "$container" ]]; then
            echo -e "${RED}Removing $container...${NC}"
            # Stop container if running, then remove it
            sudo docker stop "$container" 2>/dev/null || true
            sudo docker rm "$container" 2>/dev/null || true
            ((removed_count++))
        fi
    done <<< "$all_containers"
    
    # Clean up the mediastack network
    echo -e "${BLUE}Cleaning up mediastack network...${NC}"
    sudo docker network rm mediastack 2>/dev/null || true
    
    echo ""
    if [[ $removed_count -gt 0 ]]; then
        echo -e "${RED}✓ All services removed!${NC}"
    else
        echo -e "${BLUE}ℹ No services were found to remove.${NC}"
    fi
    echo -e "${BLUE}Data volumes are preserved. Use start-all to recreate containers.${NC}"
}

# Function to check health of services (container status + port connectivity)
check_health() {
    local service_name="$1"
    
    echo -e "${BLUE}MediaStack Health Check${NC}"
    echo "============================"
    echo ""
    
    # Function to get port from env file (handles Windows line endings)
    get_port_from_env() {
        local service="$1"
        local port=""
        local var_name=""
        
        case "$service" in
            "gluetun")          var_name="GLUETUN_CONTROL_PORT" ;;
            "bazarr")           var_name="WEBUI_PORT_BAZARR" ;;
            "immich")           var_name="IMMICH_PORT" ;;
            "jellyfin")         var_name="WEBUI_PORT_JELLYFIN" ;;
            "jellyseerr")       var_name="WEBUI_PORT_JELLYSEERR" ;;
            "lidarr")           var_name="WEBUI_PORT_LIDARR" ;;
            "mylar")            var_name="WEBUI_PORT_MYLAR" ;;
            "prowlarr")         var_name="WEBUI_PORT_PROWLARR" ;;
            "radarr")           var_name="WEBUI_PORT_RADARR" ;;
            "readarr")          var_name="WEBUI_PORT_READARR" ;;
            "sabnzbd")          var_name="WEBUI_PORT_SABNZBD" ;;
            "sonarr")           var_name="WEBUI_PORT_SONARR" ;;
            "whisparr")         var_name="WEBUI_PORT_WHISPARR" ;;
            "filebot")          var_name="WEBUI_PORT_FILEBOT" ;;
            "qbittorrent")      var_name="WEBUI_PORT_QBITTORRENT" ;;
            "flaresolverr")     var_name="FLARESOLVERR_PORT" ;;
            "tdarr")            var_name="WEBUI_PORT_TDARR" ;;
            "portainer")        var_name="WEBUI_PORT_PORTAINER" ;;
            "ddns-updater")     var_name="WEBUI_PORT_DDNS_UPDATER" ;;
            "heimdall")         var_name="WEBUI_PORT_HEIMDALL" ;;
            "homarr")           var_name="WEBUI_PORT_HOMARR" ;;
            "homepage")         var_name="WEBUI_PORT_HOMEPAGE" ;;
            "plex")             var_name="WEBUI_PORT_PLEX" ;;
            "swag")             port="443"; echo "$port"; return ;;  # SWAG always uses 443
            "authelia")         var_name="WEBUI_PORT_AUTHELIA" ;;
            "unpackerr")        port=""; echo "$port"; return ;;     # No WebUI
        esac
        
        if [[ -n "$var_name" && -f "docker-compose.env" ]]; then
            # Read port from env file, handling Windows line endings
            port=$(grep "^${var_name}=" docker-compose.env 2>/dev/null | cut -d'=' -f2 | tr -d '\r\n')
        fi
        
        echo "$port"
    }
    
    # Get list of running MediaStack containers
    local containers
    if [[ -n "$service_name" ]]; then
        # Check specific service
        if sudo docker ps --format "{{.Names}}" | grep -q "^${service_name}$"; then
            containers="$service_name"
        else
            echo -e "${RED}✗ Container '$service_name' is not running${NC}"
            return 1
        fi
    else
        # Check all MediaStack containers
        containers=$(sudo docker ps --format "{{.Names}}" | grep -E "(gluetun|bazarr|immich|jellyfin|jellyseerr|lidarr|mylar|plex|portainer|prowlarr|qbittorrent|radarr|readarr|sabnzbd|sonarr|swag|tdarr|unpackerr|whisparr|flaresolverr|homarr|homepage|heimdall|ddns-updater|authelia|filebot)")
    fi
    
    if [[ -z "$containers" ]]; then
        echo -e "${YELLOW}ℹ No MediaStack containers are currently running.${NC}"
        return 0
    fi
    
    local healthy_count=0
    local unhealthy_count=0
    local total_count=0
    
    # Check each container
    while IFS= read -r container; do
        if [[ -n "$container" ]]; then
            ((total_count++))
            
            # Get container status
            local status=$(sudo docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null)
            local health=$(sudo docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-health-check{{end}}' 2>/dev/null)
            
            # Get port for this service from env file
            local port=$(get_port_from_env "$container")
            
            echo -e "${BLUE}Checking $container...${NC}"
            
            # Check container status
            if [[ "$status" == "running" ]]; then
                echo -e "  ${GREEN}✓ Container: Running${NC}"
                
                # Check Docker health if available
                if [[ "$health" != "no-health-check" ]]; then
                    if [[ "$health" == "healthy" ]]; then
                        echo -e "  ${GREEN}✓ Docker Health: Healthy${NC}"
                    else
                        echo -e "  ${YELLOW}⚠ Docker Health: $health${NC}"
                    fi
                fi
                
                # Check HTTP service if port is defined
                if [[ -n "$port" ]]; then
                    # First check if port is open
                    if timeout 3 bash -c "</dev/tcp/localhost/$port" 2>/dev/null; then
                        echo -e "  ${GREEN}✓ Port $port: Open${NC}"
                        
                        # Now test HTTP response
                        local http_status
                        if [[ "$port" == "443" ]]; then
                            # HTTPS for SWAG
                            http_status=$(timeout 5 curl -k -s -o /dev/null -w "%{http_code}" "https://localhost:$port/" 2>/dev/null || echo "000")
                        else
                            # HTTP for most services
                            http_status=$(timeout 5 curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/" 2>/dev/null || echo "000")
                        fi
                        
                        # Check if we got a valid HTTP response
                        case "$http_status" in
                            200|302|401|403)
                                # Common successful responses:
                                # 200 = OK, 302 = Redirect (login page), 401 = Auth required, 403 = Forbidden but working
                                echo -e "  ${GREEN}✓ HTTP $port: WebUI responding (${http_status})${NC}"
                                ((healthy_count++))
                                ;;
                            000)
                                echo -e "  ${RED}✗ HTTP $port: No response from WebUI${NC}"
                                ((unhealthy_count++))
                                ;;
                            5*)
                                # 5xx = Server errors
                                echo -e "  ${RED}✗ HTTP $port: Server error (${http_status})${NC}"
                                ((unhealthy_count++))
                                ;;
                            404)
                                echo -e "  ${YELLOW}⚠ HTTP $port: Service may be starting (${http_status})${NC}"
                                ((unhealthy_count++))
                                ;;
                            *)
                                echo -e "  ${YELLOW}⚠ HTTP $port: Unexpected response (${http_status})${NC}"
                                ((unhealthy_count++))
                                ;;
                        esac
                    else
                        echo -e "  ${RED}✗ Port $port: Not responding${NC}"
                        ((unhealthy_count++))
                    fi
                else
                    echo -e "  ${BLUE}ℹ Port: No WebUI port defined${NC}"
                    ((healthy_count++))
                fi
            else
                echo -e "  ${RED}✗ Container: $status${NC}"
                echo -e "  ${RED}✗ Port: Container not running${NC}"
                ((unhealthy_count++))
            fi
            
            echo ""
        fi
    done <<< "$containers"
    
    # Summary
    echo -e "${BLUE}Health Check Summary:${NC}"
    echo "===================="
    echo -e "${GREEN}Healthy services: $healthy_count${NC}"
    if [[ $unhealthy_count -gt 0 ]]; then
        echo -e "${RED}Unhealthy services: $unhealthy_count${NC}"
    fi
    echo -e "${BLUE}Total checked: $total_count${NC}"
    
    if [[ $unhealthy_count -eq 0 ]]; then
        echo -e "${GREEN}🎉 All services are healthy!${NC}"
        return 0
    else
        echo -e "${YELLOW}⚠ Some services need attention.${NC}"
        return 1
    fi
}

# Function to restart all services
restart_all_services() {
    echo -e "${YELLOW}Restarting all MediaStack services...${NC}"
    
    # For restart, we need to fully recreate containers
    remove_all_services
    echo ""
    echo -e "${BLUE}Waiting 5 seconds before restart...${NC}"
    sleep 5
    start_all_services
}

# Handle commands that don't need service_name first
case "$1" in
    setup)
        echo -e "${GREEN}Setting up MediaStack directories...${NC}"
        "$SCRIPT_DIR/setup-directories.sh"
        exit 0
        ;;
    pull)
        echo -e "${BLUE}Pulling Docker images...${NC}"
        "$SCRIPT_DIR/pull-images.sh"
        exit 0
        ;;
    update)
        echo -e "${BLUE}Updating MediaStack...${NC}"
        "$SCRIPT_DIR/update-stack.sh"
        exit 0
        ;;
    list)
        list_services
        exit 0
        ;;
    start-all)
        check_env_file
        use_all_flag=false
        if [[ "$2" == "--all" ]]; then
            use_all_flag=true
        fi
        start_all_services "$use_all_flag"
        exit 0
        ;;
    stop-all)
        check_env_file
        stop_all_services
        exit 0
        ;;
    restart-all)
        check_env_file
        use_all_flag=false
        if [[ "$2" == "--all" ]]; then
            use_all_flag=true
        fi
        stop_all_services
        start_all_services "$use_all_flag"
        exit 0
        ;;
    remove-all)
        check_env_file
        remove_all_services
        exit 0
        ;;
    status)
        echo -e "${BLUE}MediaStack services status:${NC}"
        "$SCRIPT_DIR/status.sh"
        exit 0
        ;;
    health)
        check_health "$2"
        exit $?
        ;;
    health)
        check_health "$2"
        exit $?
        ;;
esac

# Handle commands that may have individual service operations
command=$1
service_name=$2

case "$command" in
    start)
        check_env_file
        if [[ -n "$service_name" ]]; then
            # Start individual service
            compose_file=$(find_compose_file "$service_name")
            if [[ -z "$compose_file" ]]; then
                echo -e "${RED}✗ Service '$service_name' not found!${NC}"
                echo ""
                list_services
                exit 1
            fi
            echo -e "${GREEN}Starting service: $service_name${NC}"
            echo -e "${BLUE}Using file: $compose_file${NC}"
            if sudo docker compose --file "$compose_file" --env-file docker-compose.env up -d; then
                echo -e "${GREEN}✓ $service_name started successfully${NC}"
                
                # If Gluetun was started individually, wait for VPN connection
                if [[ "$service_name" == "gluetun" ]]; then
                    wait_for_gluetun_connection
                fi
            else
                echo -e "${RED}✗ Failed to start $service_name${NC}"
            fi
        else
            # Start all services - check for --all flag
            use_all_flag=false
            if [[ "$2" == "--all" ]]; then
                use_all_flag=true
            fi
            start_all_services "$use_all_flag"
        fi
        ;;
    stop)
        check_env_file
        if [[ -n "$service_name" ]]; then
            # Stop individual service
            compose_file=$(find_compose_file "$service_name")
            if [[ -z "$compose_file" ]]; then
                echo -e "${RED}✗ Service '$service_name' not found!${NC}"
                echo ""
                list_services
                exit 1
            fi
            echo -e "${YELLOW}Stopping service: $service_name${NC}"
            echo -e "${BLUE}Container: $service_name${NC}"
            if sudo docker stop "$service_name" 2>/dev/null; then
                echo -e "${YELLOW}✓ $service_name stopped successfully${NC}"
                echo -e "${BLUE}Container preserved and can be restarted.${NC}"
            else
                echo -e "${RED}✗ Failed to stop $service_name (may not be running)${NC}"
            fi
        else
            # Stop all services (preserve containers)
            stop_all_services
        fi
        ;;
    restart)
        check_env_file
        if [[ -n "$service_name" ]]; then
            # Restart individual service
            compose_file=$(find_compose_file "$service_name")
            if [[ -z "$compose_file" ]]; then
                echo -e "${RED}✗ Service '$service_name' not found!${NC}"
                echo ""
                list_services
                exit 1
            fi
            echo -e "${YELLOW}Restarting service: $service_name${NC}"
            echo -e "${BLUE}Using file: $compose_file${NC}"
            sudo docker compose --file "$compose_file" --env-file docker-compose.env down
            sleep 2
            if sudo docker compose --file "$compose_file" --env-file docker-compose.env up -d; then
                echo -e "${GREEN}✓ $service_name restarted successfully${NC}"
                
                # If Gluetun was restarted individually, wait for VPN connection
                if [[ "$service_name" == "gluetun" ]]; then
                    wait_for_gluetun_connection
                fi
            else
                echo -e "${RED}✗ Failed to restart $service_name${NC}"
            fi
        else
            # Restart all services - check for --all flag (applies only to start)
            use_all_flag=false
            if [[ "$2" == "--all" ]]; then
                use_all_flag=true
            fi
            stop_all_services
            start_all_services "$use_all_flag"
        fi
        ;;
    logs)
        if [[ -n "$service_name" ]]; then
            # Show logs for individual service
            echo -e "${BLUE}Showing logs for service: $service_name${NC}"
            echo -e "${YELLOW}Press Ctrl+C to exit${NC}"
            echo ""
            # Try container name first, then service name
            if sudo docker logs -f "$service_name" 2>/dev/null; then
                :
            else
                compose_file=$(find_compose_file "$service_name")
                if [[ -n "$compose_file" ]]; then
                    sudo docker compose --file "$compose_file" --env-file docker-compose.env logs -f
                else
                    echo -e "${RED}✗ Service '$service_name' not found!${NC}"
                fi
            fi
        else
            # Show logs for all services
            echo -e "${BLUE}Showing logs for MediaStack services...${NC}"
            "$SCRIPT_DIR/logs.sh"
        fi
        ;;
    health)
        check_health "$service_name"
        exit $?
        ;;
    health)
        check_health "$service_name"
        exit $?
        ;;
    *)
        echo -e "${BLUE}MediaStack Unified Management Script${NC}"
        echo "======================================="
        echo ""
        echo "Usage: $0 <command> [service_name]"
        echo ""
        echo -e "${GREEN}Setup & Installation:${NC}"
        echo "  setup                  - Create directories and setup environment"
        echo "  pull                   - Pull all Docker images"
        echo "  update                 - Pull latest images and restart services"
        echo ""
        echo -e "${GREEN}Service Management:${NC}"
        echo "  start [--all]          - Start services (whitelist applies, Gluetun always starts)"
        echo "  stop                   - Stop all running services (keep containers)"
        echo "  restart [--all]        - Stop all, then start services (whitelist applies to start only)"
        echo "  start-all [--all]      - Start services (whitelist applies, Gluetun always starts)"
        echo "  stop-all               - Stop all running services (keep containers)"
        echo "  restart-all [--all]    - Stop all, then start services (whitelist applies to start only)"
        echo "  remove-all             - Stop and remove ALL containers"
        echo ""
        echo -e "${BLUE}Whitelist Support:${NC}"
        echo "  Whitelist only applies to START and RESTART operations (Gluetun always starts)"
        echo "  STOP and REMOVE operations always affect all services"
        echo "  Use --all flag to bypass whitelist for start/restart operations"
        echo ""
        echo -e "${GREEN}Individual Services:${NC}"
        echo "  start <service>        - Start individual service"
        echo "  stop <service>         - Stop individual service"
        echo "  restart <service>      - Restart individual service"
        echo "  logs <service>         - Show logs for individual service"
        echo "  health <service>       - Check health for individual service"
        echo ""
        echo -e "${GREEN}Monitoring:${NC}"
        echo "  logs                   - Show logs for all services (Ctrl+C to exit)"
        echo "  status                 - Show status of all services"
        echo "  health [service]       - Check health of all or specific service (container + port)"
        echo "  health [service]       - Check health of all or specific service (container + port)"
        echo "  list                   - List all available services"
        echo ""
        echo -e "${YELLOW}Examples:${NC}"
        echo "  $0 start gluetun       - Start only Gluetun"
        echo "  $0 stop-all            - Stop ALL running services"
        echo "  $0 start-all           - Start Gluetun + whitelisted services"
        echo "  $0 start-all --all     - Start ALL services (bypass whitelist)"
        echo "  $0 restart-all         - Stop all, start Gluetun + whitelisted services"
        echo "  $0 restart-all --all   - Stop all, start ALL services"
        echo "  $0 remove-all          - Remove ALL containers"
        echo "  $0 logs immich         - Show Immich logs"
        echo "  $0 logs jellyfin       - Show Jellyfin logs"
        echo "  $0 health              - Check health of all running services"
        echo "  $0 health prowlarr     - Check health of Prowlarr only"
        echo ""
        echo -e "${YELLOW}First time setup:${NC}"
        echo "1. $0 setup"
        echo "2. $0 pull"
        echo "3. $0 start"
        echo ""
        list_services
        exit 1
        ;;
esac