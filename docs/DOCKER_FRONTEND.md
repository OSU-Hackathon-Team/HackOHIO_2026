# Getting the current frontend in Docker

There is one frontend package: `packages/frontend`. Its `src/App.tsx` mounts
`IdeWorkbench`, the Chat / App library / My app workspace. Older components and
the previous builder prototype remain as source, but they are not alternative
Docker frontends. The Dockerfile builds the active entry point from the current
checkout and Express serves that Vite output.

The frontend changes were merged into remote `dev` in `03ee080`. A teammate using
an earlier checkout or an image built before that merge will still see the old UI.
`docker compose up` alone does not rebuild an existing image after a git pull.

## Production: port 3001

From a clean checkout (preserve local edits before switching branches):

```sh
git switch dev
git pull --ff-only origin dev
docker compose up -d --build --force-recreate splice
```

Open **http://localhost:3001**. The sidebar should have **Chat**, **App library**,
and **My app**. The root Dockerfile uses `npm ci`, builds contracts/backend/frontend
in order, and copies the freshly built frontend into the runner. Host `dist`
directories are excluded from the build context.

For frontend branch work, check out and pull `feat/frontend` instead; Docker builds
the branch in the local build context. It does not fetch another branch itself.

## Development: port 5173

```sh
docker compose stop splice
docker compose --profile dev up --build --force-recreate --renew-anon-volumes splice-dev
```

Open **http://localhost:5173** for the live Vite frontend. Port 3001 is the backend;
it may also serve an older host-built `dist` directory mounted from `./packages`.
Use port 5173 when editing source. Renewing anonymous volumes refreshes the isolated
container dependencies; it does not delete host source, fixtures, or browser data.
The production and development services both use API port 3001, so run one at a time.

To return to production:

```sh
docker compose stop splice-dev
docker compose up -d --build --force-recreate splice
```

`compose.yaml` and `docker-compose.yml` currently define the same services. Docker
Compose prefers `compose.yaml`; both use the same Dockerfile and frontend package.
Use Docker Compose v2.24 or newer for the optional environment-file syntax.

## If it still looks old

Check `git log -1`, the checked-out branch, and `git log -1 -- packages/frontend/src/ide/IdeWorkbench.tsx`.
Check `docker compose ps` to confirm the container and port being opened. If the
image was rebuilt from the correct checkout, hard-refresh the browser. An image
that was built from old source must be rebuilt; restarting that image cannot update
the frontend. No cache purge or volume deletion should be necessary.

CI now fetches the actual JavaScript referenced by the production container's HTML
and asserts it contains the current workspace destinations and chat composer, in
addition to existing API smoke checks. A successful Vite dev-server test alone does
not verify which frontend was copied into an image.
