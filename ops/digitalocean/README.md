# QuietBook DigitalOcean Runbook

This deployment runs the authenticated Testnet indexer and live-round coordinator on one DigitalOcean Droplet. Caddy is the only public container. The Node service stays on the private Compose network and keeps SQLite plus the private settlement vault on the `quietbook-data` volume.

## 1. Infrastructure

Create an Ubuntu 24.04 LTS Droplet with:

- 4 dedicated vCPU and 8 GB RAM minimum.
- 80 GB SSD minimum.
- A region close to the demo audience.
- IPv4 enabled and an SSH key; do not enable password login.
- DigitalOcean monitoring enabled.

The backend generates settlement proofs and must not use a 1-2 GB basic Droplet. Do not use a stateless Function. A Droplet is intentional because the service needs a persistent private vault and SQLite WAL files.

Create a DigitalOcean Cloud Firewall:

| Direction | Protocol | Port | Source |
| --- | --- | --- | --- |
| Inbound | TCP | 22 | Your fixed admin IP only |
| Inbound | TCP | 80 | All IPv4/IPv6 |
| Inbound | TCP | 443 | All IPv4/IPv6 |
| Inbound | UDP | 443 | All IPv4/IPv6 |
| Outbound | TCP | 80 | All IPv4/IPv6 |
| Outbound | TCP | 443 | All IPv4/IPv6 |
| Outbound | UDP | 53 | All IPv4/IPv6 |
| Outbound | TCP | 53 | All IPv4/IPv6 |
| Outbound | UDP | 123 | All IPv4/IPv6 |

Never expose port `8787`. It is only reachable by Caddy inside Docker.

Create an `A` record such as `api.quietbook.example` pointing to the Droplet IPv4 address before starting Caddy. Add an `AAAA` record only when the Droplet has working IPv6.

## 2. Base Server

Connect as root for initial provisioning:

```sh
ssh root@DROPLET_IP
apt-get update
apt-get install -y ca-certificates curl git gnupg sqlite3 unattended-upgrades
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

Create a 2 GB emergency swap file. It is not a substitute for RAM, but prevents an abrupt OOM during an unusually heavy proof:

```sh
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Clone the exact release branch:

```sh
git clone https://github.com/karagozemin/QuietBook.git /opt/quietbook
cd /opt/quietbook
git checkout main
```

## 3. Secrets

Create the production environment from the template:

```sh
cd /opt/quietbook/ops/digitalocean
cp .env.example .env.production
chmod 600 .env.production
openssl rand -hex 32
```

Edit `.env.production` as root. Set:

- `QUIETBOOK_API_DOMAIN` to the DNS name without a scheme.
- `QUIETBOOK_ALLOWED_ORIGINS` to exact HTTPS frontend origins, comma-separated and without trailing slashes.
- `QUIETBOOK_AUTH_AUDIENCE` to the public backend origin, including `https://`.
- `QUIETBOOK_SESSION_SECRET` to the random 64-character hex output.
- The three `S...` Testnet role secrets.
- `QUIETBOOK_IMAGE_TAG` to the Git commit SHA for the first release.

Retrieve Testnet role secrets only from the trusted development machine. Transfer them over SSH directly into the root-owned file. Never put them in Git, shell history, a Dockerfile, Vercel, screenshots, chat, or build logs.

At production startup the service derives each public key and refuses to boot unless it matches the pinned deployer, issuer, and operator addresses in `deployment.json`.

## 4. First Deployment

From the repository:

```sh
cd /opt/quietbook
./ops/digitalocean/deploy.sh
```

The first build compiles the round controller, downloads the pinned upstream SDK, verifies the Stellar CLI archive checksum, installs production Node dependencies, and may take several minutes. Later builds use Docker cache.

Validate all layers:

```sh
cd /opt/quietbook/ops/digitalocean
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=100 indexer caddy
curl -fsS https://api.quietbook.example/health
curl -fsS https://api.quietbook.example/ready
```

Expected readiness response:

```json
{"status":"ready"}
```

Caddy obtains and renews the TLS certificate automatically. Certificate issuance fails when DNS is not pointing at the Droplet or ports 80/443 are blocked.

## 5. Backup And Restore

Install the daily systemd timer:

```sh
cp /opt/quietbook/ops/digitalocean/quietbook-backup.service /etc/systemd/system/
cp /opt/quietbook/ops/digitalocean/quietbook-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now quietbook-backup.timer
systemctl list-timers quietbook-backup.timer
```

The backup uses SQLite's online backup command and copies the private JSON vault into a mode-`0600` archive under `/var/backups/quietbook`. Local archives older than seven days are removed. Configure an additional encrypted offsite copy or DigitalOcean backup job; a backup that exists only on the same Droplet is not disaster recovery.

Manual backup:

```sh
sudo /opt/quietbook/ops/digitalocean/backup.sh
```

Restore is intentionally explicit and stops the indexer while files are replaced:

```sh
sudo /opt/quietbook/ops/digitalocean/restore.sh /var/backups/quietbook/quietbook-YYYYMMDDTHHMMSSZ.tar.gz
curl -fsS https://api.quietbook.example/ready
```

## 6. Release And Rollback

Deploy a new commit:

```sh
cd /opt/quietbook
git fetch origin
git checkout main
git pull --ff-only
./ops/digitalocean/deploy.sh "$(git rev-parse --short=12 HEAD)"
```

Rollback uses an existing local immutable image tag and does not alter persistent data:

```sh
cd /opt/quietbook
./ops/digitalocean/rollback.sh PREVIOUS_GIT_SHA
```

Take a backup before any release that changes the state schema. This version has no schema migration, but that rule should remain part of the release process.

## 7. Operations

Useful checks:

```sh
docker stats --no-stream
docker system df
df -h
free -h
journalctl -u quietbook-backup.service --since today
docker compose -f /opt/quietbook/ops/digitalocean/compose.yaml --env-file /opt/quietbook/ops/digitalocean/.env.production logs -f --tail=100
```

Alert on:

- `/ready` returning non-200 for two consecutive minutes.
- Disk usage above 75%.
- RAM above 90% for more than five minutes.
- Container restart count increasing.
- Backup timer failure or no backup archive for 26 hours.

The public API intentionally exposes read-only evidence and round listings. Every mutation requires a short-lived wallet-signed session, exact actor matching, route rate limits, and an allowed browser origin. CORS is not treated as authentication.
