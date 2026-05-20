#!/bin/bash
set -e

# /app/.mdauth is bind-mounted from the host for persistence — don't wipe it.
# Stale tokens are handled by the OAuth refresh path. Just ensure the file
# exists in case the bind mount is fresh / empty.
touch /app/.mdauth 2>/dev/null || true

echo "Installing Python dependencies from requirements.txt files..."

# Recursively install all requirements.txt files in the app directory
find /app -type f -name "requirements.txt" | while read -r req; do
    echo "Installing dependencies from $req..."
    pip install --no-cache-dir -r "$req"
done

echo "Python dependencies installed."

# If a Discord bot token is configured, start the control bot alongside the
# main scheduler. They live in the same container and talk over a unix socket
# under /app/resources, so co-location is required anyway.
start_bot_if_configured() {
    local token=""
    if [ -n "${PUBLOADER_DISCORD_TOKEN:-}" ]; then
        token="$PUBLOADER_DISCORD_TOKEN"
    elif [ -f /app/config.ini ]; then
        token="$(grep -E '^DISCORD_BOT_TOKEN=' /app/config.ini | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
    fi

    if [ -n "$token" ]; then
        echo "Starting Discord control bot in background..."
        python -m publoader.bot.server &
    else
        echo "No DISCORD_BOT_TOKEN configured; skipping control bot."
    fi
}

# If no args were passed to the container, run the default app.
# If args were passed, execute them (so `docker run ... python run.py` works).
if [ "$#" -eq 0 ]; then
    start_bot_if_configured
    exec python run.py
elif [ "$1" = "python" ] && [ "$2" = "run.py" ]; then
    start_bot_if_configured
    exec "$@"
else
    exec "$@"
fi
