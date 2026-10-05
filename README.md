# iliiad-bot

Discord bot for Odyssey. It:

- **Logs the game** to Discord channels: joins/leaves, chat, admin commands, deaths, titan kills, trades, crate theft, branch changes, server start/stop.
- **Announces PDs** (start / type / end) with a ping, and keeps a PD log (deaths, MIA).
- **Syncs ranks both ways.** Promote someone in Discord (give them the rank role) and their in-game rank changes. Change it in game and their Discord roles follow.
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

Permission tiers are set in `config.json` (`commandPermissions`). Members with Discord's Administrator permission count as owner.

## Setup

### 1. Discord application

1. In <https://discord.com/developers/applications>, create an application and add a **Bot**.
2. Under **Bot**, turn on the **Server Members Intent**. Rank sync needs it.
3. Copy the bot token and the application (client) ID.
4. Invite the bot with the scopes `bot` and `applications.commands`, plus the permissions **Manage Roles**, **Send Messages**, **Embed Links**, **Attach Files** and **Mention Everyone** (for PD pings).
5. In Server Settings → Roles, drag the bot's role **above** every branch and rank role it should manage.

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
- `channels.*`: a channel ID for each log. Leave a channel `""` to turn that log off. Several logs can share one channel.
- `pdAnnouncePing`: a role ID, `"@everyone"`, `"@here"` or `""`.
- `staffRoles`: role IDs for moderator / admin / owner.
- `branches.<id>.role`: the branch's role. `branches.<id>.ranks`: a rank-role ID for each rank ID, **lowest rank first**. Rank IDs must match the game's `BranchConfig`.
- `linkedRole`: an optional role for linked members.

The queue, topic and store names must match the game's `BotBridgeConfig` (defaults: `IliadOutbox`, `IliadBot`, `IliadPending`). `profileStore` must match the game's profile store (`FrameworkDevData_v.0003`).

In game, set `BotBridgeConfig.Enabled = true` and publish. Studio needs **Enable Studio Access to API Services**.

### 4. Run locally

Requires Node 22.9 or newer.

```bash
npm install
npm run build
npm run deploy-commands   # once, and again whenever commands change
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

**Back up `data/store.json`.** It holds account links and the bot-side warning history. A weekly `scp` or DigitalOcean droplet backups both work.

## Notes

- **Rank sync loop guard:** the game tags each rank change with `Source` (`game` or `discord`), and the bot ignores role changes it made itself for a few seconds.
- **Offline actions:** void, rank, warn and pigeon are written to `IliadPending` and applied when the player next joins. If the player is online, the bot also sends a live nudge so the action applies right away. Each action has an ID and is applied only once.
- **Text from Discord** (pigeons, announcements) is run through Roblox's text filter as written by the sender's linked Roblox account, so senders must be linked.
- **Bans** use Roblox's built-in ban API, so they work across every server and server instance. `alts` also bans detected alt accounts.
