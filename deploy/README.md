# Deploying Cendro

Production is one OVHcloud VPS running the Next.js app in Docker. Convex stays on
Convex Cloud for now. GitHub Actions deploys the Convex functions and publishes
the web image on every push to `main`; the VPS pulls that image on a one-minute
systemd timer.

```
GitHub main ──> npx convex deploy (Convex Cloud)
            └─> ghcr.io/helionhq/cendro-web
VPS timer ──> docker compose pull + up -d
Cloudflare Tunnel ──> 127.0.0.1:3000
Tailscale ──> SSH / admin
```

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
sudo ufw allow OpenSSH
sudo ufw --force enable

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Only SSH is open. Cloudflare Tunnel makes outbound connections; no inbound
80/443 rule is needed.

### 4. Cloudflare Tunnel

In the Cloudflare dashboard: **Networking > Tunnels > Create a tunnel >
Cloudflared**, name it `cendro-vps`, and run the generated install command on
the VPS. Then add a public hostname:

| Hostname | Service |
| --- | --- |
| `cendro.im` | `http://localhost:3000` |
| `www.cendro.im` | `http://localhost:3000` (or a redirect rule to apex) |

If a `cendro.im` record still points at Vercel, replace it. Do **not** touch the
Clerk CNAMEs, Resend MX/SPF/DKIM records, or any other DNS records.

Check: `sudo systemctl status cloudflared` and, from outside the VPS,
`curl -I https://cendro.im`.

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
```

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

- The app is bound to `127.0.0.1:3000`; only Cloudflare Tunnel can reach it.
- Docker logs rotate at 10 MB x 3 per container.
- Old `sha-*` images are intentionally kept for rollback. Prune manually when
  disk usage matters.
- Convex Cloud backups are separate from the VPS. If the Convex plan does not
  include daily backups, schedule
  `npx convex export --prod --include-file-storage` and store the ZIP off-site.
- Update the OS and Docker monthly: `sudo apt update && sudo apt upgrade`.
- Tailscale updates itself; `cloudflared` updates through `apt`.

## Troubleshooting

- **Cloudflare 502/522** — check `docker compose ps`, the health endpoint, and
  `systemctl status cloudflared`.
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
  `/run/cendro-update-hold` is created so the timer does not retry it every
  minute. Inspect `journalctl -u cendro-update`, fix the release, then
  `sudo rm /run/cendro-update-hold` and `sudo systemctl start
  cendro-update.service` to resume.
- **Workflow fails at Convex deploy** — `CONVEX_DEPLOY_KEY` is missing or
  expired. `latest` was not promoted, so the VPS is still on the previous
  release.
- **Workflow fails at Promote latest** — Convex has already moved. Re-run the
  failed job (or the workflow) so the web catches up; do not leave Convex ahead
  for long.
