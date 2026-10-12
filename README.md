# You only get one slot

One Pokémon Crystal Archipelago slot, played in relay. Players sign in with Discord and queue up. Each player gets **one turn, ever**, and the turn ends after **10 new location checks**. Turns run one at a time, in the browser.

Built on [crystal.ap](https://github.com/gerbiljames/crystal-ap-web), which provides patching and the game client in Pyodide plus emulation via binjgb. The whole thing ships as one Docker image. That image holds:
- the site;
- a small Node server for the queue, sessions and Discord sign-in;
- Archipelago's `MultiServer.py`, which hosts the slot.

## How a turn works

- **Signing in and queueing.** Players sign in with Discord and join the queue. While they wait, they drop in their own vanilla Crystal ROM (English 1.0 or 1.1), which is patched in the browser. The ROM never leaves the browser.
- **Starting.** When a player's turn comes up they have `READY_TIMEOUT_SECONDS` to start it. Missing it passes the turn on without using up their attempt.
- **Fresh save.** Each turn starts from a fresh save. With `remote_items` on, the server hands the new game every item found so far. The save lives only for the turn, and the browser deletes it when the turn ends.
- **What counts.** Only *new* checks count toward the limit. Locations someone else already checked are free, and the server never forwards checks past the limit.
- **PopTracker.** Players get connection details for one PopTracker. If any other client connects with those details, the turn ends.
- **Disconnects.** The game pauses whenever it isn't connected. If it stays disconnected for `DISCONNECT_GRACE_SECONDS`, the turn ends.
- **When a turn ends**, its credentials are discarded and every connection using them is closed. MultiServer itself is only reachable from inside the container, through the proxy that checks those credentials.
- **Off limits.** There are no hints, chat, `!` commands, release or collect.

## What the server can and can't enforce

The game runs in each player's browser, so the browser holds the credentials for its turn. A player willing to use devtools can drive that game connection with a script instead of the emulator. The server can't tell the two apart (nothing can, for a game running on the player's machine). What it does guarantee, whatever connects:

- At most `CHECK_LIMIT` new checks per turn, and one turn per Discord account.
- No hints, chat, `!` commands, release or collect.
- The goal only counts once an admin confirms it.
- Only one PopTracker alongside the game. Anything else using the turn's details ends the turn.
- Data storage only takes the writes the Crystal client makes: its own keys, operations and value shapes, all bounded in size. So a turn can't stall MultiServer, fill its memory or corrupt what later players read.

Scouting locations reveals nothing new either: with `remote_items` the patched ROM already names every location's item for its in-game text.

What the server can't check is whether the progress a game reports is real. Story events, fly points, the Pokédex, EnergyLink and wonder trades pass from turn to turn through data storage. That's how each player picks up where the last one left off, and later players' games load it. A player who edits their emulator's memory (or scripts the connection) can therefore hand later players progress nobody earned, or a wonder-trade Pokémon nobody caught. Location checks stay capped either way. The admin page shows every turn's finds, and admins can ban players.

## The seed

Generate a seed with a **single slot: one Pokémon Crystal player and nothing else**. Every player in the event plays that one slot in turn, and nobody could ever connect to another slot, so items placed in one would be lost. The slot needs these options:

```yaml
Pokemon Crystal:
  remote_items: true   # required: items come from the server, so they pass from player to player and the check limit holds
  death_link: false
  trap_link: false
```

The server checks the slot count, `remote_items` and `trap_link` when it starts: a seed it can't relay is refused, and the lobby says why. (`death_link` isn't visible to it, and with one slot there's nobody to link with anyway.)

Generate it with the same Crystal apworld version the image bundles (shown in the nav bar). Then put the generator's output `.zip` (or the loose `.archipelago` and `.apcrystal`) in `data/seed/`.

Progress lives in `data/`:
- `data/yogos.db` holds players, turns and the queue.
- `data/run/` holds MultiServer's `.apsave`.

One data directory belongs to one seed. To start a new seed, use an empty data directory.

## Deploying

The image is built on the server from a checkout of this branch; nothing is published.

1. Create a Discord application. Under OAuth2, add the redirect `https://<your host>/api/auth/callback`.
2. On the server: `git clone --recurse-submodules -b you-only-get-one-slot https://github.com/gerbiljames/crystal-ap-web`.
3. Copy `docker-compose.example.yml` to `docker-compose.yml` and `.env.example` to `.env`, fill in `.env` (it's gitignored), and put the seed in `data/seed/`.
4. Run `docker compose up -d --build`. After pulling changes, run it again to rebuild.

The container serves plain HTTP on port 8080, so put TLS in front of it (the example uses Caddy). Players' browsers reach Archipelago at `wss://<host>/archipelago`. PopTracker connects to the bare `<host>:443`, which is also the address shown to players.

### Environment

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | `http://127.0.0.1:8080` | Where players reach the site. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | — | Discord application credentials. |
| `DISCORD_GUILD_ID` | — | Only members of this Discord server may sign in. |
| `SESSION_SECRET` | — | Signs the login cookie. Use a long random string. |
| `ADMIN_DISCORD_IDS` | — | Comma-separated Discord user ids allowed on the admin page (menu → admin). |
| `CHECK_LIMIT` | `10` | New checks per turn. |
| `DISCONNECT_GRACE_SECONDS` | `120` | How long the game may be disconnected before the turn ends. |
| `READY_TIMEOUT_SECONDS` | `180` | How long a player has to start their turn. |
| `QUEUE_ABSENT_SECONDS` | `60` | How long a queued player may have no page open before losing their place. |
| `AP_PUBLIC_ADDRESS` | host:port of `PUBLIC_URL` | The address shown for PopTracker. |
| `TRUST_PROXY` | — | Set to `1` behind a reverse proxy (the compose file's Caddy) so connection limits apply per real client address, read from `X-Forwarded-For`. |

### Admin

Admins can do the following from the admin page:
- pause and resume the queue;
- end the running turn;
- skip an offered turn;
- remove players from the queue;
- give a player another turn;
- ban and unban players;
- read every turn's finds.

A server restart keeps the running turn. The player has the grace period to reconnect.

## Updating the Crystal apworld

The browser bundle and the server's MultiServer are both built from the `vendor/archipelago` submodule, so one version covers both. To move to another release:

```bash
scripts/bump-world.sh 6.0.4    # checks out the tag and re-runs pack.sh
git add vendor/archipelago src/generated/versions.json && git commit
```

Then pull on the server and `docker compose up -d --build`. Seeds have to be generated with the matching version.

## Developing

```bash
git clone --recurse-submodules -b you-only-get-one-slot https://github.com/gerbiljames/crystal-ap-web
npm install
./pack.sh                      # browser AP bundle → public/ap/ (needs GNU tar and python3)
npm run typecheck && npm test
```

To run it locally without a Discord app:
- `DEV_LOGIN=1` lets anyone sign in as any name at `/api/auth/dev?name=alice`. Never use it in production.
- The server needs a Python with Archipelago's requirements, and `_speedups` built (`cythonize -b -i _speedups.pyx` in the Archipelago tree).

```bash
DEV_LOGIN=1 PUBLIC_URL=http://127.0.0.1:8765 SEED_DIR=path/to/seed PYTHON=path/to/python \
  npm run server               # API, live socket and AP proxy on :8080
npm run dev                    # site on :8765, proxying /api and /archipelago to :8080
```

The integration test (`server/test/integration.test.ts`) drives a real MultiServer through the proxy. It runs when `YOGOS_IT_SEED`, `YOGOS_IT_PYTHON` and `YOGOS_IT_AP` are set; see the file for details.

## License

MIT.
