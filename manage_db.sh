#!/bin/bash

# ==============================================================================
# Generic Database Management Script (v3 - Robust)
# ==============================================================================

# --- Configuration ---
DB_NAME="automotive_db"
DB_USER="automotive_scraper_app"
DB_PASS="automotive"
SCHEMA_FILE="schema.sql"

# --- Colors for better output ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# --- Helper Functions ---
function usage() {
    echo -e "${YELLOW}Usage: $0 {start|setup|teardown|reset|verify|status|connect}${NC}"
    exit 1
}

function connect_db() {
    start_server
    echo "-> Connecting to database '$DB_NAME' as user '$DB_USER'..."
    echo "   (Password is: '${DB_PASS}')"
    export PGPASSWORD="${DB_PASS}"
    psql -h localhost -d "$DB_NAME" -U "$DB_USER"
    unset PGPASSWORD
}

# --- Core Logic Functions ---

# MORE ROBUST: Checks if systemd connection is okay before trying to use it.
function start_server() {
    echo "-> Checking PostgreSQL service..."
    if sudo systemctl is-system-running --quiet; then
        if sudo systemctl is-active --quiet postgresql; then
            echo -e "   ${GREEN}Service is already running.${NC}"
        else
            echo "   Service is not running. Starting it..."
            sudo systemctl start postgresql
            echo -e "   ${GREEN}Service started.${NC}"
        fi
    else
        echo -e "   ${RED}WARNING: Cannot connect to systemd. If the script fails,${NC}"
        echo -e "   ${RED}         run 'exec sudo su -l \$USER' and try again.${NC}"
    fi
}

# The fully corrected setup function
function setup_db() {
    start_server
    echo "-> Setting up database '$DB_NAME' and user '$DB_USER'..."

    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
        echo "   User '$DB_USER' not found. Creating..."
        sudo -u postgres psql -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';"
    else
        echo "   User '$DB_USER' already exists."
    fi

    if ! sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
        echo "   Database '$DB_NAME' not found. Creating and granting privileges..."
        sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
    else
        echo "   Database '$DB_NAME' already exists."
    fi

    echo "-> Applying schema from '$SCHEMA_FILE'..."
    if [ ! -f "$SCHEMA_FILE" ]; then
        echo -e "   ${RED}ERROR: Schema file '$SCHEMA_FILE' not found! Cannot create tables.${NC}"
        exit 1
    fi

    # THE FIX: Use psql's own authentication (-U) instead of the wrong system user with sudo.
    export PGPASSWORD="${DB_PASS}"
    psql -h localhost -U "${DB_USER}" -d "${DB_NAME}" -f "${SCHEMA_FILE}"
    unset PGPASSWORD

    echo -e "   ${GREEN}Database setup and schema application complete.${NC}"
}

function teardown_db() {
    start_server
    echo -e "-> ${RED}Preparing to delete database '$DB_NAME' and user '$DB_USER'.${NC}"
    read -p "   Are you absolutely sure? This cannot be undone. (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "   Proceeding with teardown..."
        sudo -u postgres psql <<-EOF
            SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}';
            DROP DATABASE IF EXISTS ${DB_NAME};
            DROP ROLE IF EXISTS ${DB_USER};
EOF
        echo -e "   ${GREEN}Teardown complete.${NC}"
    else
        echo "   Teardown cancelled."
    fi
}

function verify_connection() {
    start_server
    echo "-> Verifying connection..."
    export PGPASSWORD=$DB_PASS
    if pg_isready -h localhost -d "$DB_NAME" -U "$DB_USER" -q; then
        echo -e "   ${GREEN}SUCCESS: Connection verified.${NC}"
    else
        echo -e "   ${RED}FAILURE: Could not connect. Try running './manage_db.sh setup' first.${NC}"
    fi
    unset PGPASSWORD
}

# --- Main script logic ---
if [ -z "$1" ]; then usage; fi
case "$1" in
    start) start_server;;
    setup) setup_db;;
    teardown) teardown_db;;
    reset) teardown_db; setup_db;;
    verify) verify_connection;;
    status) sudo systemctl status postgresql --no-pager;;
    connect) connect_db;;
    *) usage;;
esac