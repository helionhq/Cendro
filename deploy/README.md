# Deploying Cendro

Production is one OVHcloud VPS running the Next.js app in Docker. Convex stays on
Convex Cloud for now. GitHub Actions deploys the Convex functions and publishes
the web image on every push to `main`; the VPS pulls that image on a one-minute
systemd timer.

```
GitHub main ──> npx convex deploy (Convex Cloud)
            └─> ghcr.io/helionhq/cendro-web
VPS timer ──> docker compose pull + up -d
Browser ──> Caddy :443 (cendro.im) ──> web :3000
                  └─ /api/convex-relay/* ──> Convex (backup route)
Tailscale ──> SSH / admin (SSH is closed to the public internet)
```

Why Caddy instead of the Cloudflare proxy or a Cloudflare Tunnel: from the office
network in Pakistan, ISP filtering intermittently resets connections to shared
Cloudflare addresses. `*.convex.cloud` is also behind Cloudflare. Serving
cendro.im from the VPS's own address keeps the page reachable. The Convex backup
route goes VPS → Convex, so browsers that cannot reach Convex directly still
connect.

## One-time VPS setup

Assumes Ubuntu 24.04 LTS with OVH's default sudo user `ubuntu`, and the domain
`cendro.im` already on Cloudflare. Do not run `do-release-upgrade`; 24.04 is the
supported target for this setup.

### 1. SSH and updates

Confirm `ssh ubuntu@<vps-ip>` works with your key. Then:

```sh
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ufw
```

If the upgrade installed a new kernel, `sudo reboot` and reconnect.

### 2. Tailscale

```sh
curl -fsSL https://tailscale.com/install.sh | sudo sh
sudo tailscale up --hostname=cendro-vps
```

Approve the URL it prints. From your laptop: `ssh ubuntu@cendro-vps`. If the
short name does not resolve, use the address from `tailscale ip -4`.

### 3. Docker, swap, firewall

```sh
sudo ufw allow in on tailscale0 to any port 22 proto tcp
sudo ufw --force enable

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

SSH is reachable only over Tailscale. Ports 80/443 are published by Docker for
Caddy; Docker manages those firewall rules itself, so ufw needs no 80/443 rule.

Harden SSH (key-only, no root):

```sh
printf 'PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
' | sudo tee /etc/ssh/sshd_config.d/00-cendro-hardening.conf
sudo sshd -t && sudo systemctl reload ssh
```

### 4. DNS

In Cloudflare DNS for `cendro.im`, create these records with the proxy **off**
(grey cloud, "DNS only"). The VPS address comes from `curl -4 ifconfig.me`.

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `cendro.im` | VPS IPv4 | DNS only |
| A | `www` | VPS IPv4 | DNS only |

Caddy redirects `www` to the apex and fetches certificates itself. Cloudflare
redirect rules, WAF and tunnels do not apply to grey-cloud records. Do **not**
touch the Clerk CNAMEs, Resend MX/SPF/DKIM records, or any other DNS records.

### 5. Checkout and environment

Create a read-only deploy key for the private repo:

```sh
ssh-keygen -t ed25519 -C "cendro-vps" -f ~/.ssh/cendro_deploy -N ""
cat ~/.ssh/cendro_deploy.pub
```

Add it under GitHub **Settings > Deploy keys** (read-only). The key uses a
non-default filename, so tell Git to use it explicitly when cloning:

```sh
sudo mkdir -p /opt/cendro
sudo chown ubuntu:ubuntu /opt/cendro
GIT_SSH_COMMAND='ssh -i ~/.ssh/cendro_deploy -o IdentitiesOnly=yes' git clone git@github.com:helionhq/Cendro.git /opt/cendro
cd /opt/cendro/deploy
cp .env.example .env
chmod 600 .env
```

Fill `.env`:

- `NEXT_PUBLIC_CONVEX_URL` — `https://animated-opossum-192.convex.cloud`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — the live publishable key
- `CLERK_SECRET_KEY` — the live secret key
- `PLATFORM_ADMIN_CLERK_USER_IDS` and `AI_CHAT_PERSISTENCE_SECRET` — exactly the
  values already in the Convex production deployment
- `FIREWORKS_API_KEY`, `AI_GATEWAY_API_KEY`, `FIRECRAWL_API_KEY`

The `NEXT_PUBLIC_*` values are baked into the image at build time. Keep them
identical to the GitHub Actions repository variables.

### 6. GHCR login

Create a GitHub PAT with `read:packages` (and `repo` if you use a classic
token). Then:

```sh
echo '<pat>' | sudo docker login ghcr.io -u <github-username> --password-stdin
```

This writes credentials for root, which is what the systemd service uses.

### 7. First start

After the first GitHub Actions run has pushed an image:

```sh
cd /opt/cendro/deploy
sudo docker compose up -d --wait --wait-timeout 180
sudo docker compose ps
curl -f http://127.0.0.1:3000/api/health
curl -fI https://cendro.im
```

The timer only updates `web`. After changing `Caddyfile`, run
`sudo docker compose up -d --force-recreate caddy`.

### 8. Auto-update timer

```sh
sudo cp /opt/cendro/deploy/cendro-update.service /etc/systemd/system/
sudo cp /opt/cendro/deploy/cendro-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cendro-update.timer
```

## GitHub configuration

Repository **Settings > Secrets and variables > Actions**:

Variables:

- `NEXT_PUBLIC_CONVEX_URL` = `https://animated-opossum-192.convex.cloud`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = live publishable key

Secret:

- `CONVEX_DEPLOY_KEY` = production deploy key from the Convex dashboard
  (production deployment > Settings > Deploy keys)

`GITHUB_TOKEN` handles the GHCR push; no extra secret is needed for that.

## Deploy flow

Opening or updating a PR deploys nothing. Only a push to `main` runs
`.github/workflows/publish-web.yml`, and the order is deliberate:

1. Build and push only the immutable `:sha-<short>` tag. A failed build leaves
   Convex and the running app untouched.
2. `npx convex deploy` pushes functions/schema to Convex Cloud.
3. Promote `:latest` to that image. If the Convex deploy fails, `:latest` stays
   on the previous release and the VPS keeps running the old web.

The VPS timer then pulls `:latest` and restarts the container within about a
minute. To deploy immediately:

```sh
sudo systemctl start cendro-update.service
journalctl -u cendro-update -f
```

There is a short window after Convex deploys where the old web is still running
against the new backend. That is why deploys must stay backward-compatible. For
a breaking change (removing or renaming a function, making a field required),
split it across two PRs: first ship code that supports both shapes, then remove
the old path once the web is live. Do not add `workflow_dispatch` without a
branch guard; a manual run on a feature branch would deploy that branch's
Convex functions to production before the PR is merged.

## Rollback

The workflow publishes an immutable `sha-<short>` tag. To pin the previous
image:

```sh
sudo nano /opt/cendro/deploy/.env
# WEB_IMAGE=ghcr.io/helionhq/cendro-web:sha-<short>
cd /opt/cendro/deploy
sudo docker compose up -d web
```

Roll back in the opposite order from a deploy: put the **web** on the previous
image first, then revert the commit and run `npx convex deploy` with the
production deploy key. Rolling Convex back first can strand the new web on
functions that no longer exist. Keep the web and Convex rollbacks compatible.

## Operations

```sh
cd /opt/cendro/deploy
sudo docker compose ps
sudo docker compose logs -f web
curl -f http://127.0.0.1:3000/api/health
df -h
docker system df
```

- The app is bound to `127.0.0.1:3000`; the public reaches it only through Caddy.
- Caddy is pinned in `docker-compose.yml`. Bump it when a new 2.x release ships.
- Docker logs rotate at 10 MB x 3 per container.
- Old `sha-*` images are intentionally kept for rollback. Prune manually when
  disk usage matters.
- Convex Cloud backups are separate from the VPS. If the Convex plan does not
  include daily backups, schedule
  `npx convex export --prod --include-file-storage` and store the ZIP off-site.
- Update the OS and Docker monthly: `sudo apt update && sudo apt upgrade`.
- Tailscale updates itself; Ubuntu security updates install automatically.

## Troubleshooting

- **Site unreachable or 502** — check `docker compose ps`, the health endpoint,
  and `docker compose logs caddy` (certificate errors appear there).
- **App loads but Convex calls fail** — the `NEXT_PUBLIC_CONVEX_URL` baked into
  the image must match the runtime value in `.env`; rebuild the image if it
  changed.
- **Clerk "Missing secretKey"** — `.env` is missing or the container was not
  restarted after editing it.
- **Image pull denied** — GHCR login expired or the PAT lacks `read:packages`.
- **Timer is not updating** — `systemctl list-timers`, then
  `journalctl -u cendro-update`.
- **Update failed and the timer stopped** — a new image that never becomes
  healthy is rolled back to the previous image, and
  `/var/lib/cendro/update-hold` is created. An image whose baked Convex URL
  differs from `.env` is refused with the same hold, before it starts. The hold survives reboots, so the
  timer does not retry the bad release every minute. Inspect
  `journalctl -u cendro-update`, fix the release, then
  `sudo rm /var/lib/cendro/update-hold` and `sudo systemctl start
  cendro-update.service` to resume.
- **Workflow fails at Convex deploy** — `CONVEX_DEPLOY_KEY` is missing or
  expired. `latest` was not promoted, so the VPS is still on the previous
  release.
- **Workflow fails at Promote latest** — Convex has already moved. Re-run the
  failed job (or the workflow) so the web catches up; do not leave Convex ahead
  for long.
