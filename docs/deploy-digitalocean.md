# Deploy on DigitalOcean (step by step)

What you'll end up with:

```
Laravel page ──HTTPS──▶ chat.yourdomain.com (nginx + free SSL)
                              │
                              ▼  127.0.0.1 only (not reachable from the internet)
                        agent-service :3000 ──▶ mcp-server :3100     (both kept alive by PM2)
```

- **Time:** about 40 minutes.
- **Cost:** $12/month (2 GB Droplet).

Replace these placeholders everywhere below:

| Placeholder | Example |
| --- | --- |
| `chat.yourdomain.com` | the subdomain for the chat service |
| `YOUR_DROPLET_IP` | shown in the DigitalOcean dashboard after step 1 |
| `https://your-laravel-site.com` | the address your Laravel app is served from |

---

## 1. Create the Droplet

In the DigitalOcean dashboard, go to **Create → Droplets**:

1. **Region:** Bangalore (BLR1). If your Laravel app or MySQL database is already on DigitalOcean,
   pick **the same region** and the same VPC so the chat can reach the database privately.
2. **Image:** Ubuntu 24.04 (LTS) x64.
3. **Size:** Basic, Regular, **2 GB / 1 CPU ($12/mo)**. The 1 GB ($6) plan works if you add swap (step 3).
4. **Authentication:** SSH key. Add your PC's public key. On Windows, run `ssh-keygen` in PowerShell if you
   don't have one, then paste the contents of `C:\Users\<you>\.ssh\id_ed25519.pub`.
5. Tick **Monitoring**, name it `mf-chat`, and click **Create Droplet**. Copy its IPv4 address.

## 2. Point your domain at it

At your DNS provider, add an **A record**:

| Type | Name | Value |
| --- | --- | --- |
| A | `chat` | `YOUR_DROPLET_IP` |

If you use Cloudflare, leave the record **DNS only** (grey cloud) until SSL is working in step 9.

## 3. Log in and secure the server

From PowerShell on your PC:

```bash
ssh root@YOUR_DROPLET_IP
```

On the server, create a normal user, allow SSH through the firewall, and turn the firewall on:

```bash
adduser deploy                       # choose a password; the other questions can be left blank
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
ufw allow OpenSSH
ufw enable                           # answer y
exit
```

Log back in as the new user. **Do everything from here on as `deploy`:**

```bash
ssh deploy@YOUR_DROPLET_IP
sudo apt update && sudo apt upgrade -y
```

Add 2 GB of swap. This is required on the 1 GB plan and harmless on 2 GB; it stops builds running out of memory:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Install Node.js 24, nginx and PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git nginx
sudo npm install -g pm2
node -v        # should print v24.x
```

## 5. Put the code on the server

### Option A: via GitHub (recommended; makes updates one command)

**On your PC** (PowerShell), push the project to a **private** GitHub repository. `.env` files,
`node_modules` and build output are already excluded by `.gitignore`.

```bash
cd "E:\projects\Agentic AI\Mutual-funds-chat"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR_GITHUB_USER/mutual-funds-chat.git
git push -u origin main
```

**On the server**, create a read-only deploy key and clone:

```bash
ssh-keygen -t ed25519 -C "mf-chat-droplet"     # press Enter at every question
cat ~/.ssh/id_ed25519.pub
```

Copy the printed key into GitHub: open the repo, then **Settings → Deploy keys → Add deploy key**
(leave "Allow write access" unticked). Then:

```bash
git clone git@github.com:YOUR_GITHUB_USER/mutual-funds-chat.git ~/mf-chat
```

### Option B: upload directly (no GitHub)

On your PC (PowerShell):

```bash
cd "E:\projects\Agentic AI\Mutual-funds-chat"
tar --exclude=node_modules --exclude=dist --exclude=.env -czf mf-chat.tgz .
scp mf-chat.tgz deploy@YOUR_DROPLET_IP:~
```

On the server:

```bash
mkdir -p ~/mf-chat && tar -xzf ~/mf-chat.tgz -C ~/mf-chat && rm ~/mf-chat.tgz
```

With option B, repeat this upload for every update instead of using `deploy.sh`.

## 6. Configure the environment

```bash
cd ~/mf-chat
cp mcp-server/.env.example mcp-server/.env
cp agent-service/.env.example agent-service/.env
```

Generate two random secrets and keep them handy:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → WIDGET_TOKEN_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # → MCP_AUTH_TOKEN
```

Edit `agent-service/.env` with `nano agent-service/.env` (save: Ctrl+O, Enter; exit: Ctrl+X) and set:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `GEMINI_API_KEY` | your key |
| `WIDGET_TOKEN_SECRET` | the first secret. Laravel's `MF_CHAT_SECRET` must be identical (step 12) |
| `ALLOWED_ORIGINS` | `https://your-laravel-site.com`. Exact, no trailing slash. Add `,https://www.your-laravel-site.com` if you use www |
| `ENABLE_PLAYGROUND` | `false` |
| `MCP_AUTH_TOKEN` | the second secret |
| `PORTFOLIO_SOURCE` | `none` for now (see step 11) |
| `APP_NAME` | your app's name, e.g. `MyFunds` |

Leave `HOST=127.0.0.1`, `PORT=3000` and `TRUST_PROXY=loopback` as they are. nginx on the same machine
passes the real visitor IP through.

Edit `mcp-server/.env` with `nano mcp-server/.env` and set `MCP_AUTH_TOKEN` to **the same second secret**.
Leave `MCP_ALLOWED_HOSTS` **empty**.

Lock the files down:

```bash
chmod 600 agent-service/.env mcp-server/.env
```

> **Gemini tier:** for real users, enable billing on your Gemini API key. The paid tier has much higher
> rate limits, and Google's terms allow prompts sent on the free tier to be used to improve its products.

## 7. Build

```bash
cd ~/mf-chat
npm ci --include=dev
npm run build
npm run smoke        # optional: calls all 14 data tools against live AMFI data; ends with "All tools OK"
```

## 8. Start with PM2 (auto-restart and start on boot)

```bash
cd ~/mf-chat
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd
```

`pm2 startup` prints a `sudo env PATH=… pm2 startup …` command. **Copy that printed line and run it.** Then:

```bash
pm2 install pm2-logrotate          # keeps log files from growing forever
curl -s http://127.0.0.1:3000/health
```

Expected: `{"status":"ok",…,"mcp":[{"name":"india-mf","connected":true,"tools":14}]}`.
If `connected` is `false`, wait 5 seconds and try again; the agent reconnects automatically.

## 9. nginx and free HTTPS

Create the site config:

```bash
sudo nano /etc/nginx/sites-available/mf-chat
```

Paste this (change `server_name`):

```nginx
server {
    listen 80;
    server_name chat.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;          # required: replies stream word by word
        proxy_read_timeout 180s;
    }
}
```

Enable it and open the web ports:

```bash
sudo ln -s /etc/nginx/sites-available/mf-chat /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default    # skip this line if this server also hosts your Laravel site
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 'Nginx Full'
```

Get a free SSL certificate. It renews automatically.

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d chat.yourdomain.com --redirect --agree-tos -m you@yourdomain.com
sudo certbot renew --dry-run
```

Check from your PC's browser: **https://chat.yourdomain.com/health** should show `"status":"ok"`.

## 10. (Optional) Keep chat memory across restarts: Redis

Without Redis, conversations live in memory and are forgotten when the service restarts (for example on
each deploy). To keep them:

```bash
sudo apt install -y redis-server     # listens on 127.0.0.1 only by default
nano ~/mf-chat/agent-service/.env    # set REDIS_URL=redis://127.0.0.1:6379
pm2 restart mf-agent
pm2 logs mf-agent --lines 20         # look for "Conversation store: Redis"
```

## 11. (Optional) "How is my portfolio doing?" from your Laravel database

1. **Create a read-only MySQL user** on the Laravel database. Use `127.0.0.1` for the host if MySQL is on this
   Droplet, the Droplet's private VPC IP if it's on another Droplet, or `YOUR_DROPLET_IP` otherwise.

   ```sql
   CREATE USER 'mfchat_ro'@'YOUR_DROPLET_IP' IDENTIFIED BY 'a-long-random-password';
   GRANT SELECT ON your_laravel_db.holdings TO 'mfchat_ro'@'YOUR_DROPLET_IP';
   GRANT SELECT ON your_laravel_db.transactions TO 'mfchat_ro'@'YOUR_DROPLET_IP';
   ```

2. **Allow the connection:**
   - **DigitalOcean Managed MySQL:** add the Droplet under **Trusted sources**.
   - **MySQL on another server:** allow only `YOUR_DROPLET_IP` on port 3306 in that server's firewall.

3. **Configure** `agent-service/.env`. Adjust the table and column names to your schema; the queries only
   need to return these column names.

   ```env
   PORTFOLIO_SOURCE=mysql
   PORTFOLIO_DB_URL=mysql://mfchat_ro:a-long-random-password@DB_HOST:3306/your_laravel_db
   PORTFOLIO_HOLDINGS_SQL="SELECT scheme_code, units, invested_amount FROM holdings WHERE user_id = :user_id AND units > 0"
   PORTFOLIO_TRANSACTIONS_SQL="SELECT scheme_code, DATE(created_at) AS date, IF(type = 'redeem', -amount, amount) AS amount FROM transactions WHERE user_id = :user_id"
   ```

   If the database is reached over the internet, add TLS to the URL:
   `…/your_laravel_db?ssl={"rejectUnauthorized":true}`

4. `pm2 restart mf-agent`, then `pm2 logs mf-agent --lines 20` should show `Portfolio source: MySQL`.

## 12. Connect your Laravel app

Follow [`laravel-embed/README.md`](../laravel-embed/README.md) with these values in Laravel's `.env`:

```env
MF_CHAT_URL=https://chat.yourdomain.com
MF_CHAT_SECRET=<exactly the same as WIDGET_TOKEN_SECRET>
```

Then run `php artisan config:clear` (or `php artisan config:cache` in production).

## 13. Test everything

On the server, send a real question the same way the widget does:

```bash
cd ~/mf-chat
TOKEN=$(npm run -s token -w agent-service -- 1 Test)
curl -N https://chat.yourdomain.com/api/chat/stream \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"What is the latest NAV of SBI Small Cap?"}'
```

You should see `event: meta`, a tool event, then `event: delta` lines and `event: done`.

Then open your Laravel site while logged in. The chat button appears in the bottom-right corner.

## Updating later

After pushing changes to GitHub from your PC:

```bash
ssh deploy@YOUR_DROPLET_IP
chmod +x ~/mf-chat/scripts/deploy.sh     # first time only
~/mf-chat/scripts/deploy.sh
```

It pulls, installs, builds, restarts both services and prints the health check.

## Everyday commands

| Task | Command |
| --- | --- |
| Status | `pm2 status` |
| Live logs | `pm2 logs` (or `pm2 logs mf-agent`) |
| Restart after editing `.env` | `pm2 restart all` |
| CPU / memory | `pm2 monit` |

Also set up a **DigitalOcean Uptime check** on `https://chat.yourdomain.com/health` so you get an email if the
service goes down.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Widget shows "Your session has expired" | `MF_CHAT_SECRET` (Laravel) ≠ `WIDGET_TOKEN_SECRET` (server). Make them identical, then `php artisan config:clear` and `pm2 restart mf-agent`. |
| Browser console shows `403` / `origin_not_allowed` | `ALLOWED_ORIGINS` doesn't exactly match the site address (https, www, no trailing slash). |
| Reply appears all at once instead of streaming | A proxy is buffering. Check `proxy_buffering off;` in nginx; with Cloudflare, make sure no caching rule applies to `/api/*`. |
| `/health` shows `connected: false` | Check `pm2 logs mf-mcp`. `MCP_AUTH_TOKEN` must match in both `.env` files, and `MCP_ALLOWED_HOSTS` must be empty. |
| "Something went wrong while generating a reply" | `pm2 logs mf-agent`. Usually the Gemini key, quota (429) or all models overloaded (503). |
| Build fails with "Killed" | Out of memory. Add the swap from step 3. |
| `certbot` fails | The DNS A record isn't live yet (check with `nslookup chat.yourdomain.com`), or Cloudflare proxy is on. |
