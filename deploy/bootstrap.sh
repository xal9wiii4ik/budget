#!/usr/bin/env bash
# One-shot preparation of a fresh Ubuntu 24.04 VPS. The repo is private, so copy
# this file over from your machine and run it as root there:
#   scp deploy/bootstrap.sh root@<ip>:/root/
#   ssh root@<ip> 'REPO_URL=git@github.com:<owner>/budget.git bash bootstrap.sh'
# Every step is idempotent: rerunning after a fix is the normal way to use it.
# It deliberately does NOT start the stack — deploy/update.sh owns that, after
# you have filled in the optional secrets it prints at the end.
set -euo pipefail

# The repository this server deploys from; pass it in the environment. SSH, not
# HTTPS: the clone authenticates with the read-only Deploy key generated below.
REPO_URL="${REPO_URL:-git@github.com:OWNER/budget.git}"

APP_DIR=/opt/budget
DEPLOY_KEY=/root/.ssh/budget_deploy
# 00- on purpose: sshd keeps the FIRST value it reads for a keyword and the
# Include is processed in lexical order, so a cloud-init drop-in (commonly
# 50-cloud-init.conf, PasswordAuthentication yes) would beat a 99- file.
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-budget.conf

export DEBIAN_FRONTEND=noninteractive

step() { printf '\n==> %s\n' "$1"; }
skip() { printf '    skipped: %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (this installs packages and edits /etc)." >&2
  exit 1
fi

step "Base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssl ufw

step "Docker Engine + compose plugin"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  skip "docker and the compose plugin are already installed"
else
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -s /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  if [ ! -f /etc/apt/sources.list.d/docker.list ]; then
    # shellcheck disable=SC1091  # /etc/os-release only sets VERSION_CODENAME
    codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$(dpkg --print-architecture)" "$codename" >/etc/apt/sources.list.d/docker.list
  fi
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

step "Firewall (22, 80, 443/tcp, 443/udp)"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'

step "Unattended security upgrades"
apt-get install -y -qq unattended-upgrades
if [ -f /etc/apt/apt.conf.d/20auto-upgrades ]; then
  skip "20auto-upgrades already configured"
else
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
fi

step "Swap (the vite build is the memory peak on a 4 GB box)"
if [ -n "$(swapon --show)" ]; then
  skip "swap already active"
else
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

step "Docker log caps"
if [ -f /etc/docker/daemon.json ]; then
  # Never rewrite a daemon config somebody else may own; compose.prod caps logs
  # per service anyway, this is only the default for everything else.
  skip "/etc/docker/daemon.json exists"
else
  mkdir -p /etc/docker
  cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
  systemctl restart docker
fi

step "SSH hardening"
# Gated on purpose: turning password login off on a box that has no key in
# authorized_keys locks the owner out permanently, and so does a config typo.
# Matches ssh-*, ecdsa-*, sk-* (FIDO) and option-prefixed lines
# (command="…" ssh-ed25519 …), which a leading-anchor pattern would miss.
if [ ! -f /root/.ssh/authorized_keys ] || ! grep -qE '(^|[[:space:]])(ssh-|ecdsa-|sk-)' /root/.ssh/authorized_keys; then
  skip "/root/.ssh/authorized_keys has no public key line — password login left ON so you can still get in"
else
  mkdir -p /etc/ssh/sshd_config.d
  cat >"$SSHD_DROPIN" <<'EOF'
# Managed by budget deploy/bootstrap.sh
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    # Measured, not assumed: this is the lock-out-adjacent step, and another
    # drop-in sorting before ours would silently win.
    if sshd -T 2>/dev/null | grep -qi '^passwordauthentication no'; then
      echo "    password login disabled (verified with sshd -T)"
    else
      echo "    WARNING: password login still ON — another sshd_config.d file wins; see docs/deploy.md"
    fi
  else
    rm -f "$SSHD_DROPIN"
    skip "'sshd -t' rejected the new config (printed above) — drop-in removed, sshd untouched"
  fi
fi

step "Deploy key"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ -f "$DEPLOY_KEY" ]; then
  skip "$DEPLOY_KEY already exists"
else
  ssh-keygen -t ed25519 -N '' -C "budget-deploy@$(hostname)" -f "$DEPLOY_KEY" >/dev/null
fi
if ! grep -q 'budget deploy key' /root/.ssh/config 2>/dev/null; then
  cat >>/root/.ssh/config <<EOF

# budget deploy key
Host github.com
  IdentityFile $DEPLOY_KEY
  IdentitiesOnly yes
EOF
  chmod 600 /root/.ssh/config
fi
if ! ssh-keygen -F github.com >/dev/null 2>&1; then
  ssh-keyscan -t rsa,ecdsa,ed25519 github.com >>/root/.ssh/known_hosts 2>/dev/null
fi
echo
echo "---- public deploy key (read-only Deploy key on GitHub) ----"
cat "$DEPLOY_KEY.pub"
echo "------------------------------------------------------------"

step "Clone $REPO_URL -> $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  skip "$APP_DIR is already a git checkout"
elif [ "$REPO_URL" != "${REPO_URL/OWNER/}" ]; then
  # Checked here, not at the top: the steps above are useful on their own, and
  # the deploy key has to exist before a clone can succeed anyway.
  echo "ERROR: REPO_URL still contains the OWNER placeholder ($REPO_URL). Run" >&2
  echo "         export REPO_URL=git@github.com:<owner>/budget.git" >&2
  echo "       then rerun this script." >&2
  exit 1
elif git clone "$REPO_URL" "$APP_DIR"; then
  :
else
  echo "ERROR: clone failed — add the key above as a read-only Deploy key on GitHub, then rerun" >&2
  exit 1
fi

step "$APP_DIR/.env"
if [ -f "$APP_DIR/.env" ]; then
  skip "$APP_DIR/.env exists (secrets are never regenerated over a live stack)"
else
  ipv4="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*[[:space:]]src[[:space:]]\([0-9.]\{7,\}\).*/\1/p' | head -n 1)"
  if [ -z "$ipv4" ]; then
    echo "ERROR: could not determine this server's IPv4 — set SITE_DOMAIN in $APP_DIR/.env by hand" >&2
    exit 1
  fi
  site_domain="${ipv4//./-}.sslip.io"

  # Values are substituted by this shell, never by an external command: a secret
  # passed as argv would show up in `ps`.
  fill() {
    local key="$1" value="$2" file="$3" line out=''
    while IFS= read -r line || [ -n "$line" ]; do
      [ "$line" = "$key=" ] && line="$key=$value"
      out+="$line"$'\n'
    done <"$file"
    printf '%s' "$out" >"$file"
  }

  umask 077
  cp "$APP_DIR/.env.prod.example" "$APP_DIR/.env"
  fill SITE_DOMAIN "$site_domain" "$APP_DIR/.env"
  fill POSTGRES_PASSWORD "$(openssl rand -hex 32)" "$APP_DIR/.env"
  fill MINIO_ROOT_USER "budget-$(openssl rand -hex 4)" "$APP_DIR/.env"
  fill MINIO_ROOT_PASSWORD "$(openssl rand -hex 32)" "$APP_DIR/.env"
  fill JWT_SECRET "$(openssl rand -hex 32)" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    written: $APP_DIR/.env (mode 600), SITE_DOMAIN=$site_domain"
fi

step "Backup directory + systemd timer"
backup_dir="$(sed -n 's/^[[:space:]]*BACKUP_DIR=//p' "$APP_DIR/.env" | tail -n 1)"
mkdir -p "${backup_dir:-/var/backups/budget}/pg" "${backup_dir:-/var/backups/budget}/receipts"
install -m 0644 "$APP_DIR/deploy/systemd/budget-backup.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/systemd/budget-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now budget-backup.timer >/dev/null
systemctl list-timers budget-backup.timer --no-pager | sed 's/^/    /'

cat <<EOF

==> Done. The stack is NOT running yet. Next, in this order:

  1. Point SITE_DOMAIN at a name that resolves here if you have one:
         \$EDITOR $APP_DIR/.env      # SITE_DOMAIN is pre-filled with the sslip.io name
  2. Optional but normally wanted, in the same file:
         VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT   # web push; see the comments there
         ANTHROPIC_API_KEY                                      # advisor + receipt parsing
         R2_*                                                   # offsite backup copy (all four or none)
  3. Start it:
         cd $APP_DIR && deploy/update.sh

The generated POSTGRES_PASSWORD / MINIO_ROOT_PASSWORD / JWT_SECRET are in that
file only and are never printed. Keep the file at mode 600.
EOF
