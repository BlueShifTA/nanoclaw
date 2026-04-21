#!/usr/bin/env bash
set -euo pipefail

# Install the Telegram adapter (Phase A of the /add-telegram skill), collect
# the bot token, write .env + data/env/env, and restart the service so the
# new adapter is live. Idempotent.
#
# Pair-telegram (the interactive code-sending step) is run separately by the
# caller (setup/auto.ts) so it can stream status blocks to the user.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-telegram/SKILL.md.
ADAPTER_VERSION="@chat-adapter/telegram@4.26.0"
CHANNELS_BRANCH="origin/channels"

need_install() {
  [[ ! -f src/channels/telegram.ts ]] && return 0
  [[ ! -f setup/pair-telegram.ts ]] && return 0
  ! grep -q "^import './telegram.js';" src/channels/index.ts 2>/dev/null && return 0
  return 1
}

if need_install; then
  echo "[add-telegram] Fetching channels branch…"
  git fetch origin channels >/dev/null 2>&1

  echo "[add-telegram] Copying adapter files from $CHANNELS_BRANCH…"
  for f in \
    src/channels/telegram.ts \
    src/channels/telegram-pairing.ts \
    src/channels/telegram-pairing.test.ts \
    src/channels/telegram-markdown-sanitize.ts \
    src/channels/telegram-markdown-sanitize.test.ts \
    setup/pair-telegram.ts
  do
    git show "$CHANNELS_BRANCH:$f" > "$f"
  done

  # Append self-registration import if missing.
  if ! grep -q "^import './telegram.js';" src/channels/index.ts; then
    echo "import './telegram.js';" >> src/channels/index.ts
  fi

  # Register pair-telegram step if not already in the STEPS map.
  # Uses node (not sed) since sed's in-place + escape semantics differ
  # between BSD (macOS) and GNU.
  node -e '
    const fs = require("fs");
    const p = "setup/index.ts";
    let s = fs.readFileSync(p, "utf-8");
    if (!s.includes("\047pair-telegram\047")) {
      s = s.replace(
        /(register: \(\) => import\(\x27\.\/register\.js\x27\),)/,
        "$1\n  \x27pair-telegram\x27: () => import(\x27./pair-telegram.js\x27),"
      );
      fs.writeFileSync(p, s);
    }
  '

  echo "[add-telegram] Installing $ADAPTER_VERSION…"
  pnpm install "$ADAPTER_VERSION"

  echo "[add-telegram] Building…"
  pnpm run build >/dev/null
else
  echo "[add-telegram] Adapter files already installed — skipping install phase."
fi

# Token collection.
if grep -q '^TELEGRAM_BOT_TOKEN=.' .env 2>/dev/null; then
  echo "[add-telegram] TELEGRAM_BOT_TOKEN already set in .env — skipping token prompt."
else
  cat <<'EOF'

── Create a Telegram bot ──────────────────────────────────────

  1. Open Telegram and message @BotFather
  2. Send: /newbot
  3. Follow the prompts (bot name, username ending in "bot")
  4. Copy the token it gives you (format: <digits>:<chars>)

Optional but recommended for groups:
  5. @BotFather → /mybots → your bot → Bot Settings → Group Privacy → OFF

EOF
  echo "Paste your TELEGRAM_BOT_TOKEN and press Enter."
  echo "Nothing will appear on the screen as you paste — that's intentional."
  echo "Paste once, then just press Enter to submit."
  read -r -s -p "> " TOKEN </dev/tty
  echo

  if [[ -z "$TOKEN" ]]; then
    echo "[add-telegram] No token entered. Aborting." >&2
    exit 1
  fi

  # Telegram bot tokens: <digits>:<35+ base64url-ish chars>.
  if [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{35,}$ ]]; then
    echo "[add-telegram] Token format looks wrong (expected <digits>:<chars>). Aborting." >&2
    exit 1
  fi

  touch .env
  if grep -q '^TELEGRAM_BOT_TOKEN=' .env; then
    awk -v tok="$TOKEN" '/^TELEGRAM_BOT_TOKEN=/{print "TELEGRAM_BOT_TOKEN=" tok; next} {print}' \
      .env > .env.tmp && mv .env.tmp .env
  else
    echo "TELEGRAM_BOT_TOKEN=$TOKEN" >> .env
  fi
fi

# Validate the token via getMe so a typo surfaces before we restart the
# service, and capture the bot's username for the deep link.
TELEGRAM_BOT_TOKEN_VALUE="$(grep '^TELEGRAM_BOT_TOKEN=' .env | head -1 | cut -d= -f2-)"
BOT_USERNAME=""
if [[ -n "$TELEGRAM_BOT_TOKEN_VALUE" ]]; then
  INFO=$(curl -fsS --max-time 8 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_VALUE}/getMe" 2>/dev/null || true)
  if echo "$INFO" | grep -q '"ok":true'; then
    # Crude JSON parse — the response is always a flat object here.
    BOT_USERNAME=$(echo "$INFO" | sed -nE 's/.*"username":"([^"]+)".*/\1/p')
    if [[ -n "$BOT_USERNAME" ]]; then
      echo "[add-telegram] Token validated — bot is @${BOT_USERNAME}."
    fi
  else
    echo "[add-telegram] Warning: getMe did not return ok. Continuing, but the token may be wrong."
  fi
fi

# Container reads from data/env/env (the host mounts it).
mkdir -p data/env
cp .env data/env/env

# Deep-link into the bot's chat in the installed Telegram app so the user
# is already on the right screen when pair-telegram prints the code. Also
# always print the URL so headless / remote-SSH users can open it manually.
if [[ -n "$BOT_USERNAME" ]]; then
  BOT_URL="https://t.me/${BOT_USERNAME}"
  case "$(uname -s)" in
    Darwin)
      open "tg://resolve?domain=${BOT_USERNAME}" >/dev/null 2>&1 \
        || open "$BOT_URL" >/dev/null 2>&1 \
        || true
      ;;
    Linux)
      xdg-open "tg://resolve?domain=${BOT_USERNAME}" >/dev/null 2>&1 \
        || xdg-open "$BOT_URL" >/dev/null 2>&1 \
        || true
      ;;
  esac
  echo "[add-telegram] Bot chat: ${BOT_URL}"
  echo "[add-telegram] (If Telegram didn't open automatically, click the link above.)"
fi

echo "[add-telegram] Restarting service so the new adapter picks up the token…"
case "$(uname -s)" in
  Darwin)
    launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" >/dev/null 2>&1 || true
    ;;
  Linux)
    systemctl --user restart nanoclaw >/dev/null 2>&1 \
      || sudo systemctl restart nanoclaw >/dev/null 2>&1 \
      || true
    ;;
esac

# Give the Telegram adapter a moment to finish starting before pair-telegram
# begins polling for the user's code message.
sleep 5

echo "[add-telegram] Install + credentials complete."
