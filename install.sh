#!/bin/bash
# meta-scheduler one-line installer
# Made by Antonio Automates and Claude — https://antonioautomates.com
# Usage: curl -fsSL https://raw.githubusercontent.com/arillera/meta-scheduler/main/install.sh | bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}meta-scheduler installer${NC}"
echo "Made by Antonio Automates and Claude — antonioautomates.com"
echo ""

# 1. Mac check
if [[ "$(uname)" != "Darwin" ]]; then
  echo -e "${RED}Sorry — this tool is currently Mac-only.${NC}"
  exit 1
fi

# 2. Node check
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Node.js is not installed.${NC}"
  echo ""
  echo "Please install Node.js first:"
  echo "  1. Go to https://nodejs.org"
  echo "  2. Click the big green 'LTS' button to download"
  echo "  3. Open the .pkg file you downloaded and follow the installer"
  echo "  4. Then re-run this installer"
  exit 1
fi
echo -e "${GREEN}✓${NC} Node.js found ($(node --version))"

# 3. git check (Mac comes with it but Xcode CLT might not be installed)
if ! command -v git >/dev/null 2>&1; then
  echo -e "${YELLOW}git not found — macOS will prompt to install Xcode Command Line Tools.${NC}"
  echo "Click 'Install' on the popup, wait for it to finish, then re-run this installer."
  git --version  # triggers the Xcode CLT prompt
  exit 1
fi
echo -e "${GREEN}✓${NC} git found"

# 4. Clone or update repo
INSTALL_DIR="$HOME/meta-scheduler"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo -e "${GREEN}✓${NC} meta-scheduler already at $INSTALL_DIR — updating…"
  cd "$INSTALL_DIR"
  git pull --quiet
else
  if [[ -d "$INSTALL_DIR" ]]; then
    echo -e "${RED}Folder $INSTALL_DIR exists but is not a git repo. Move/rename it and re-run.${NC}"
    exit 1
  fi
  echo "Downloading meta-scheduler to $INSTALL_DIR…"
  git clone --quiet https://github.com/arillera/meta-scheduler "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 5. npm install
echo "Installing dependencies (this takes ~30 seconds)…"
npm install --silent --no-audit --no-fund

# 6. Playwright Chromium
echo "Installing Chromium browser (~92 MB, one-time, takes ~30 seconds)…"
npx playwright install chromium >/dev/null 2>&1

# 7. Account setup — interactive
echo ""
if [[ -f "accounts/myaccount.json" ]]; then
  echo -e "${GREEN}✓${NC} Account file already exists at accounts/myaccount.json — skipping account setup."
else
  echo -e "${BOLD}Let's set up your account.${NC}"
  echo ""
  echo "What is the EXACT name of your Facebook Page?"
  echo "(Open Meta Business Suite in your browser — it's the name shown in the top-left switcher.)"
  echo ""
  read -p "Page name: " PAGE_NAME </dev/tty
  if [[ -z "$PAGE_NAME" ]]; then
    echo -e "${RED}No name entered. Aborting.${NC}"
    exit 1
  fi
  cat > accounts/myaccount.json <<JSON
{
  "name": "myaccount",
  "displayName": "$PAGE_NAME",
  "pageName": "$PAGE_NAME",
  "carouselsRoot": "../content",
  "imagesSubpath": "Day-{day}/images",
  "captionSubpath": "Day-{day}/caption.md",
  "captionStartLine": 1,
  "platforms": ["facebook", "instagram"],
  "timezone": "America/New_York"
}
JSON
  echo -e "${GREEN}✓${NC} Created accounts/myaccount.json for \"$PAGE_NAME\""
fi

# 8. Symlink the Claude Code skill (harmless if Claude Code isn't installed)
SKILL_TARGET="$HOME/.claude/skills/meta-scheduler"
mkdir -p "$HOME/.claude/skills"
if [[ -e "$SKILL_TARGET" || -L "$SKILL_TARGET" ]]; then
  rm -rf "$SKILL_TARGET"
fi
ln -s "$INSTALL_DIR/skill" "$SKILL_TARGET"
echo -e "${GREEN}✓${NC} Claude Code skill linked at $SKILL_TARGET"

# 9. Login (opens browser, blocks until user closes window)
echo ""
echo -e "${BOLD}Last step: log into Meta.${NC}"
echo ""
echo "A Chromium browser window is about to open. Inside it:"
echo "  1. Sign into Meta with the account that owns your Facebook Page"
echo "  2. Confirm the top-left switcher shows your business"
echo "  3. ${BOLD}Close the browser window${NC} when you're logged in"
echo ""
read -p "Press Enter to open the browser… " </dev/tty
node schedule-post.js --account myaccount --setup

# 10. Done
echo ""
echo -e "${GREEN}${BOLD}🎉 You're all set up.${NC}"
echo ""
echo -e "${BOLD}Easiest way to schedule posts:${NC} ask Claude (Claude Code, claude.ai/code)."
echo "  Try: \"Schedule a carousel post to my Meta account for tomorrow at 9am.\""
echo "  Claude will pick up the meta-scheduler skill automatically and ask you for the rest."
echo ""
echo -e "${BOLD}Or run the command yourself:${NC}"
echo -e "  ${BOLD}cd ~/meta-scheduler${NC}"
echo -e "  ${BOLD}node schedule-post.js --account myaccount \\${NC}"
echo -e "  ${BOLD}  --images \"/path/to/your/images-folder\" \\${NC}"
echo -e "  ${BOLD}  --caption \"/path/to/your/caption.txt\" \\${NC}"
echo -e "  ${BOLD}  --datetime \"2026-06-01 09:00\"${NC}"
echo ""
echo "Full docs: https://github.com/arillera/meta-scheduler#readme"
echo "Help / questions: https://github.com/arillera/meta-scheduler/issues"
echo ""
