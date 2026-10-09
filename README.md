# Sub2API today usage

One OpenChamber panel displays the daily actual cost for two API keys. Each request is authenticated with its matching inference key:

```text
ID 1 → key 1 → GET /v1/usage?days=1&timezone=Asia/Shanghai
ID 2 → key 2 → GET /v1/usage?days=1&timezone=Asia/Shanghai
```

The panel reads only `usage.today.actual_cost` from each response. It never combines the keys or shows account balance. A partial failure keeps the last value for that row and marks it stale. A valid zero is shown as `$0.0000`.

## Install in OpenChamber

Use OpenChamber 2.1.1 or newer. The extension folder must be on the same machine as the OpenChamber instance that runs its local service.

1. Clone this repository into OpenChamber's local extensions directory:

   ```sh
   git clone https://github.com/daheli/openchamber-sub2api-usage.git \
     ~/.config/openchamber/extensions-local/sub2api-usage
   cd ~/.config/openchamber/extensions-local/sub2api-usage
   ```

2. Create and configure the local credential file:

   ```sh
   cp .env.example .env
   $EDITOR .env
   chmod 600 .env
   ```

   Set the HTTPS origin and both key entries. Never commit or share `.env`.

3. Install dependencies and build the panel bundle:

   ```sh
   bun install
   bun run build
   bun test
   ```

4. In OpenChamber, open **Settings → Extensions**. Enter the folder path above in **Folder, ZIP, or URL** and select **Add**.
5. Review the requested local Service permission, then choose **Allow and enable**. The Service has no OS sandbox; read its source before granting it.
6. Refresh OpenChamber. The single **Sub2API** section appears in the Work Status panel. If it is hidden, open **Choose sections** and enable it.

To update, run `git pull` in the extension folder, then `bun install` and `bun run build`. Disable and re-enable Sub2API in **Settings → Extensions** to restart its Service with the updated code.

## Local credentials

Copy `.env.example` to `.env`, set `SUB2API_API_ORIGIN` to the Sub2API HTTPS origin
(scheme and origin only, no path or credentials),
put both API keys in their matching ID entries, and set file permissions:

```sh
chmod 600 .env
```

`.env` is excluded by `.gitignore`. Commit `.env.example`, never `.env`. The UI iframe receives only the key names and usage amounts. The local service reads `.env` and sends each key only to the configured Sub2API origin, using the fixed `/v1/usage` path.

**Service permission.** OpenChamber guest services do not run in an OS sandbox. The service runs as your user and could access other files that user can read. This implementation only opens this extension's `.env`, binds HTTP to `127.0.0.1`, authenticates the host proxy, and returns the two usage values. Review the source before approving it in Settings → Extensions.

## Refresh and authentication failures

The panel fetches on open and foreground, supports manual refresh, and refreshes every 300 seconds while visible. The service rereads `.env` for each request, so after rotating a key, update `.env`, keep mode `0600`, and refresh the panel.

## Build and test

```sh
bun install
bun run build
bun test
node --check service/main.js
```

`panel/main.js` is the generated IIFE loaded by OpenChamber. The local service is plain Node.js and has no external package dependencies.
