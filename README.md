# iliiad-bot

Discord bot for Odyssey. It:

- **Logs the game** to Discord channels: joins/leaves, chat, admin commands, every death (with cause, killer, location and what was dropped), item drops and pickups, corpse looting, titan kills, trades, crate theft, branch changes, server start/stop.
- **Announces PDs** (start / type / end) with a ping, and keeps a PD log (deaths, MIA).
- **Syncs ranks both ways, across every branch's own Discord server.** Promote someone in their branch's server (give them the rank role, or `/rank` there) and their in-game rank changes. Change it in game and their roles follow in every server. See [Branch servers](#branch-servers).
- **Handles messenger pigeons.** Letters sent in game reach linked players' DMs (with a Reply button). `/pigeon` sends a letter into the game.
- **Staff tools:** look up a player's data and check it for corruption, kick, ban, unban, warn, void a death, set ranks, announce to all servers, list servers, shut down one or all servers, and restart servers. PDs can only be started and stopped in game.

The game side is in the framework repo (`BotBridgeService`, `PigeonService`, `docs/features/DiscordBridge.md`). The bot needs **no public URL**. It polls the game through Roblox Open Cloud, so it runs anywhere that can make outbound HTTPS requests.

```
game ──(MemoryStore queue "IliadOutbox")──> bot polls (Open Cloud)
bot  ──(MessagingService "IliadBot")──────> live servers
bot  ──(DataStore "IliadPending")─────────> offline players, applied on next join
```

## Commands

| Command | Who | What |
|---|---|---|
| `/link`, `/unlink` | everyone | Link a Roblox account (type the code in game chat) |
| `/pigeon to message` | linked | Send a letter into the game |
| `/whois player` | moderator | Show who's linked to whom |
| `/lookup player [raw]` | moderator | Stats, branch/rank, wipe state, warnings, ban, **data health check**, optional raw JSON |
| `/kick`, `/warn`, `/ban [duration] [alts]` | moderator | `duration` like `30m`, `12h`, `7d`, `2w`, or blank for permanent |
| `/unban`, `/void`, `/rank` | admin | `/rank` updates both the game and Discord roles |
| `/announce message [style]` | moderator | System chat message or shout on every server (you must be linked) |
| `/servers`, `/status` | moderator | Live servers + players, and a bridge connection check |
| `/shutdown server\|all [reason]` | admin | Shut down one server (job id from `/servers`) or all of them |
| `/restart confirm [bleed_minutes]` | admin | Restart every server onto the latest version |

Permission tiers are set in `config.json` (`commandPermissions`). Members with Discord's Administrator permission count as owner. All of the commands above are in the main server.

Each branch server gets `/link`, `/unlink`, `/pigeon` and its own `/rank player rank`, described below.

## Branch servers

Each branch has its own Discord server with its own rank roles. The bot sits in the main server and in every branch server. One `/link` (from any of them) covers all of them.

**Where the roles live**

| Server | Roles the bot manages |
|---|---|
| A branch's server | That branch's member role (`role`) and one role per rank (`ranks`) |
| Main server | `mainRole` for whichever branch the player is in (optional), plus `linkedRole` |

A branch with an empty `guildId` keeps its roles in the main server instead.

**Game → Discord.** When someone's rank changes in game, or they join the game or link their account, the bot sets their roles in every server to match. If they move from one branch to another, they lose the old branch's roles in its server and get the new branch's roles in its server. In the main server their `mainRole` is swapped. If a linked player joins a branch server later, their roles are applied straight away. The bot only touches roles listed in the config.

**Discord → game.** There are two ways to change a rank from a branch's server:

- **Give the rank role directly** in the branch's server. Discord's own role permissions decide who can do this. The bot picks it up and changes the rank in game.
- **`/rank player rank`** in the branch's server. Only the branch's `officerRoles` (and the server's Administrators) can use it. Officers can only give ranks **below their own**, can only change people ranked below them, and can't change their own rank. Use `None` to discharge someone.

**Transfers between branches.** A branch server can recruit someone who isn't in any branch. It can't take someone out of another branch: if a branch server gives a rank role to someone who's already in another branch, the bot reverts it and logs why. Transfers go through staff with `/rank` in the main server. Set `allowDiscordTransfers: true` to let branch servers do transfers themselves.

**Logs.** Every rank change is posted to the main server's `ranks` channel. It's also posted to the `rankLog` channel of each branch involved, so a transfer shows up in both branches' logs.

**Note:** the bot remembers each player's branch and rank from the game. Someone who hasn't joined the game since the bot started running is "unknown" until they do, or until staff `/rank` them.

## Setup

### 1. Discord application

1. In <https://discord.com/developers/applications>, create an application and add a **Bot**.
2. Under **Bot**, turn on the **Server Members Intent**. Rank sync needs it.
3. Copy the bot token and the application (client) ID.
4. Invite the bot to the **main server and every branch server**. Use the scopes `bot` and `applications.commands`, plus the permissions **Manage Roles**, **Send Messages**, **Embed Links**, **Attach Files** and **Mention Everyone** (for PD pings).
5. In each server, go to Server Settings → Roles and drag the bot's role **above** every branch and rank role it should manage.

### 2. Roblox Open Cloud API key

At <https://create.roblox.com/dashboard/credentials>, create an API key. Restrict it to the experience and give it these permissions:

| API | Permissions |
|---|---|
| Messaging Service | `universe-messaging-service:publish` |
| Memory Store | `memory-store.queue:dequeue`, `memory-store.queue:discard` |
| Data Stores (ordered/standard objects) | `universe-datastores.objects:read`, `:create`, `:update` |
| User Restrictions | `universe.user-restriction:read`, `:write` |
| Universes | `universe:write` (server restarts) |

For the IP allowlist, enter your droplet's IP, or `0.0.0.0/0` while testing.

### 3. Config

```bash
cp .env.example .env               # DISCORD_TOKEN, DISCORD_CLIENT_ID, ROBLOX_API_KEY
cp config.example.json config.json
```

In `config.json`, fill in:

- `guildId`: your server's ID. Turn on Developer Mode in Discord, then right-click the server → Copy ID.
- `roblox.universeId`: the experience's universe ID (shown on the Creator Dashboard). `placeIds` is optional and limits restarts to those places.
- `channels.*`: a channel ID for each log. Leave a channel `""` to turn that log off. Several logs can share one channel. `items` covers drops and pickups of other players' drops; `loot` covers corpse looting.
- `pdAnnouncePing`: a role ID, `"@everyone"`, `"@here"` or `""`.
- `staffRoles`: role IDs for moderator / admin / owner.
- For each branch under `branches.<id>`:
  - `guildId`: the branch's Discord server ID (`""` = use the main server).
  - `role`: the branch member role in that server.
  - `ranks`: a role ID in that server for each rank ID, **lowest rank first**. Rank IDs must match the game's `BranchConfig`.
  - `officerRoles`: roles in that server allowed to use `/rank` there.
  - `mainRole`: an optional role in the main server for members of this branch.
  - `rankLog`: an optional channel in that server for the branch's rank changes.
- `allowDiscordTransfers`: see [Branch servers](#branch-servers).
- `linkedRole`: an optional role for linked members.

The queue, topic and store names must match the game's `BotBridgeConfig` (defaults: `IliadOutbox`, `IliadBot`, `IliadPending`). `profileStore` must match the game's profile store (`FrameworkDevData_v.0003`).

In game, set `BotBridgeConfig.Enabled = true` and publish. Studio needs **Enable Studio Access to API Services**.

### 4. Run locally

Requires Node 22.9 or newer.

```bash
npm install
npm run build
npm run deploy-commands   # once, again whenever commands change, and after adding a branch server
npm start
```

Run `/status` in Discord. It pings every server and reports how many answered.

## Hosting on DigitalOcean

The smallest Basic droplet ($4–6/mo, 512 MB–1 GB) is plenty.

1. Create an **Ubuntu 24.04** droplet and SSH in.
2. Install Node 22 and pm2:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   sudo npm install -g pm2
   ```
3. Clone and configure:
   ```bash
   git clone https://github.com/Pacriptct/iliiad-bot.git && cd iliiad-bot
   npm install
   nano .env           # paste the three secrets
   nano config.json    # or scp your filled-in config.json up
   npm run build && npm run deploy-commands
   ```
4. Start it and keep it running across reboots:
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup         # run the command it prints
   ```
5. Useful commands: `pm2 logs iliiad-bot`, `pm2 restart iliiad-bot`.

To update:

```bash
git pull && npm install && npm run build && npm run deploy-commands && pm2 restart iliiad-bot
```

**Back up `data/store.json`.** It holds account links, the bot-side warning history and each player's last known rank. A weekly `scp` or DigitalOcean droplet backups both work.

## Notes

- **Rank sync loop guard:** the game tags each rank change with `Source` (`game` or `discord`), and the bot ignores role changes it made itself for a few seconds.
- **Offline actions:** void, rank, warn and pigeon are written to `IliadPending` and applied when the player next joins. If the player is online, the bot also sends a live nudge so the action applies right away. Each action has an ID and is applied only once.
- **Text from Discord** (pigeons, announcements) is run through Roblox's text filter as written by the sender's linked Roblox account, so senders must be linked.
- **Bans** use Roblox's built-in ban API, so they work across every server and server instance. `alts` also bans detected alt accounts.
