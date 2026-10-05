# iliiad-bot

Discord bot for Odyssey. It:

- **Logs the game** to Discord channels: joins/leaves, chat, admin commands, every death (with cause, killer, location and what was dropped), item drops and pickups, corpse looting, titan kills, trades, crate theft, branch changes, server start/stop.
- **Announces PDs** (start / type / end) with a ping, and keeps a PD log (deaths, MIA).
- **Syncs ranks both ways, across every branch's own Discord server.** Promote someone in their branch's server (give them the rank role, or `/rank` there) and their in-game rank changes. Change it in game and their roles follow in every server. See [Branch servers](#branch-servers).
- **Handles messenger pigeons.** Letters sent in game reach linked players' DMs (with a Reply button). `/pigeon` sends a letter into the game.
- **Staff tools:** look up a player's data and check it for corruption, kick, ban, unban, warn, void a death, set ranks, announce to all servers, list servers, and shut down or restart servers: one server, every server of one place, or everything. PDs can only be started and stopped in game.

The game side is in the framework repo (`BotBridgeService`, `PigeonService`, `docs/features/DiscordBridge.md`). The bot needs **no public URL**. It polls the game through Roblox Open Cloud, so it runs anywhere that can make outbound HTTPS requests.

```
game ──(MemoryStore queue "IliadOutbox")──> bot polls (Open Cloud)
bot  ──(MessagingService "IliadBot")──────> live servers
bot  ──(DataStore "IliadPending")─────────> offline players, applied on next join
```

## Commands

| Command | Who | What |
|---|---|---|
| `/link`, `/unlink` | everyone | Link a Roblox account. Instant if they're verified with Bloxlink / RoVer, otherwise a code to type in game chat |
| `/pigeon to message` | linked | Send a letter into the game |
| `/whois player` | moderator | Show who's linked to whom |
| `/lookup player [raw]` | moderator | Stats, branch/rank, wipe state, warnings, ban, **data health check**, optional raw JSON |
| `/kick`, `/warn`, `/ban [duration] [alts]` | moderator | `duration` like `30m`, `12h`, `7d`, `2w`, or blank for permanent |
| `/mute member [duration] [reason]`, `/unmute member` | moderator | Discord mute (timeout) in the main server **and every branch server**. It follows them if they join another server or leave and rejoin. Leave `duration` empty for permanent; the bot keeps renewing it past Discord's 28-day timeout limit. Use `/unmute`, because a timeout removed by hand gets put back |
| `/unban`, `/void`, `/rank` | admin | `/rank` updates both the game and Discord roles |
| `/linkall` | admin | Auto-link everyone in the main server who's verified with Bloxlink / RoVer |
| `/announce message [style]` | moderator | System chat message or shout on every server (you must be linked) |
| `/servers`, `/status` | moderator | Live servers + players, and a bridge connection check |
| `/shutdown target [reason]` | admin | `target` is one server (job id), one place (every server of it), or `all`. The list suggests live servers and your configured places. |
| `/restart place confirm [bleed_minutes]` | admin | Restart one place's servers (or `all`) onto the latest version |

Permission tiers are set in `config.json` (`commandPermissions`). Members with Discord's Administrator permission count as owner. All of the commands above are in the main server.

Each branch server gets `/link`, `/unlink`, `/pigeon`, and its own `/rank player rank` and `/transfer player [rank] [note]`, described below.

## Linking (automatic)

If your servers already use **Bloxlink** or **RoVer** for verification, players never have to do anything:

- When someone joins the main server or a branch server, the bot asks Bloxlink / RoVer which Roblox account they verified, and links them.
- Anyone who's still unlinked is looked up the moment they use `/link` or `/pigeon`, or when staff @mention them in a command.
- Run `/linkall` once after setting this up to link everyone who's already in the main server.
- Their roles are applied as soon as the bot knows their rank, which happens the next time they join the game.

For players who aren't verified with either bot, `/link` gives them a 6-letter code to type in game chat, which takes about 10 seconds.

**Setup:**

1. In `config.json`, set `autoLink.provider` to `"bloxlink"` or `"rover"`. `autoLink.dm` sends people a short "you're linked" DM.
2. Put the API key in `.env`:
   - **Bloxlink:** Bloxlink dashboard → your main server → Developer / API → create a Server API key → `BLOXLINK_API_KEY`.
   - **RoVer:** in your main server, run RoVer's API key command (see rover.link) → `ROVER_API_KEY`.
3. The provider's bot has to be in your **main server**, and lookups go through the main server. If someone joins a branch server without being in the main server, they use `/link` instead.

`/unlink` removes a link, but a Bloxlink / RoVer link comes straight back the next time they use a command. To link a different account, they use `/link` and type the code on that account.

## Branch servers

Each branch has its own Discord server with its own rank roles. The bot sits in the main server and in every branch server. One `/link` (from any of them) covers all of them.

**Where the roles live**

| Server | Roles the bot manages |
|---|---|
| A branch's server | That branch's member role (`role`) and one role per rank (`ranks`) |
| Main server | `mainRole` for whichever branch the player is in (optional), plus `linkedRole` |
| Any server | Discord-only roles from `roleRules` (see below) |

A branch with an empty `guildId` keeps its roles in the main server instead.

**Game → Discord.** When someone's rank changes in game, or they join the game or link their account, the bot sets their roles in every server to match. If they move from one branch to another, they lose the old branch's roles in its server and get the new branch's roles in its server. In the main server their `mainRole` is swapped. If a linked player joins a branch server later, their roles are applied straight away. The bot only touches roles listed in the config.

**Discord → game.** There are two ways to change a rank from a branch's server:

- **Give the rank role directly** in the branch's server. Discord's own role permissions decide who can do this. The bot picks it up and changes the rank in game.
- **`/rank player rank`** in the branch's server. Only the branch's `officerRoles` (and the server's Administrators) can use it. Officers can only give ranks **below their own**, can only change people ranked below them, and can't change their own rank. Use `None` to discharge someone.

**Transfers between branches.** A branch can recruit someone who isn't in any branch with `/rank`. To take someone from another branch, use `/transfer`:

1. An officer of the receiving branch runs `/transfer player [rank] [note]` in their branch's server. The rank defaults to the lowest and must be below the officer's own.
2. The bot posts the request with **Approve** and **Deny** buttons in the leaving branch's `transferChannel`. If that isn't set, it uses the branch's `rankLog`, and failing that the main server's `ranks` log.
3. Someone from the leaving branch decides. It can be an officer who outranks the player, that server's Administrator, or admin staff if the request landed in the main server.
4. Once approved, the player is moved in game and their roles follow in every server. The requester and the player get a DM. Requests expire after 7 days.

If someone gives a rank role directly to a member of another branch, the bot reverts it and points them to `/transfer`. Set `allowDiscordTransfers: true` to let direct role changes and `/rank` move people between branches without approval. Main-server staff can always move anyone with `/rank`.

**Discord-only roles (`roleRules`).** These are roles that don't exist in game but come from someone's game rank, like "Other Branch Hicom" or "Foreign Branch Commander" in the Scouting Legion server. Each rule names a server, a role, which branches qualify and, optionally, which ranks:

```json
"roleRules": [
  {
    "name": "Other Branch Hicom (SL server)",
    "guildId": "<SL server id>",
    "role": "<Other Branch Hicom role id>",
    "branches": "others",
    "ranks": ["SectionCommander", "AssistantCommander", "Commander", "DeputyHeadInstructor", "HeadInstructor", "ViceCIC", "CIC"]
  }
]
```

- `branches` can be `"others"` (every branch except the one whose server this is), `"any"`, or a list such as `["MP", "SG"]`.
- If `ranks` is left out, any rank in those branches qualifies.
- Add one rule per role per server. The bot gives and removes these roles as ranks change. They only go from game to Discord: handing one out by hand won't change anything in game.
- The bot never touches roles that aren't in the config, so purely Discord-side roles (event team, verified, and so on) are left alone.

**Logs.** Every rank change is posted to the main server's `ranks` channel. It's also posted to the `rankLog` channel of each branch involved, so a transfer shows up in both branches' logs.

**Note:** the bot remembers each player's branch and rank from the game. Someone who hasn't joined the game since the bot started running is "unknown" until they do, or until staff `/rank` them.

## Setup

### 1. Discord application

1. In <https://discord.com/developers/applications>, create an application and add a **Bot**.
2. Under **Bot**, turn on the **Server Members Intent**. Rank sync needs it.
3. Copy the bot token and the application (client) ID.
4. Invite the bot to the **main server and every branch server**. Use the scopes `bot` and `applications.commands`, plus the permissions **Manage Roles**, **Timeout Members** (for `/mute`), **Send Messages**, **Embed Links**, **Attach Files** and **Mention Everyone** (for PD pings).
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
cp .env.example .env               # DISCORD_TOKEN, DISCORD_CLIENT_ID, ROBLOX_API_KEY (+ BLOXLINK_API_KEY / ROVER_API_KEY)
cp config.example.json config.json
```

In `config.json`, fill in:

- `guildId`: your server's ID. Turn on Developer Mode in Discord, then right-click the server → Copy ID.
- `roblox.universeId`: the experience's universe ID (shown on the Creator Dashboard).
- `roblox.places`: a name for each place ID, e.g. `{ "Main": 1234567, "Trost": 7654321 }`. Place IDs are on the Creator Dashboard under each place. `/restart`, `/shutdown` and `/servers` use these names, and you can also type a raw place ID.
- `channels.*`: a channel ID for each log. Leave a channel `""` to turn that log off. Several logs can share one channel. `items` covers drops and pickups of other players' drops; `loot` covers corpse looting.
- `pdAnnouncePing`: a role ID, `"@everyone"`, `"@here"` or `""`.
- `staffRoles`: role IDs for moderator / admin / owner.
- For each branch under `branches.<id>`:
  - `guildId`: the branch's Discord server ID (`""` = use the main server).
  - `role`: the branch member role in that server.
  - `ranks`: a role ID in that server for each rank ID, **lowest rank first**. Rank IDs must match the game's `BranchConfig`. `npm run setup-roles` can fill these in for you (see below).
  - `officerRoles`: roles in that server allowed to use `/rank` and `/transfer` there, and to approve transfers out.
  - `mainRole`: an optional role in the main server for members of this branch.
  - `rankLog`: an optional channel in that server for the branch's rank changes.
  - `transferChannel`: an optional channel in that server where requests to transfer people **out** of this branch are approved (defaults to `rankLog`).
- `allowDiscordTransfers` and `roleRules`: see [Branch servers](#branch-servers).
- `linkedRole`: an optional role for linked members.

#### Filling in rank roles automatically

Each branch's ranks are set separately, and a branch only lists the ranks it has in game. To fill in a branch:

1. Put the branch server's ID in `branches.<id>.guildId` and invite the bot to that server.
2. Run:
   ```bash
   npm run build
   npm run setup-roles            # dry run: shows the role it found for each rank
   npm run setup-roles -- --write # saves them to config.json
   ```
   Add branch IDs to do only some branches (`npm run setup-roles -- SL MP --write`), or `--overwrite` to replace IDs already filled in.

The script matches a role to a rank by its in-game name or ID, ignoring case and punctuation. Prefixes and suffixes are fine, so `Captain`, `[SL] Captain` and `Captain | SL` all match. It also finds the branch member role by the branch's name. Anything it can't match is listed, along with the server's other roles, so you can copy those IDs by hand: turn on Developer Mode, then go to Server Settings → Roles, right-click a role → Copy Role ID. `officerRoles`, `mainRole`, the log channels and `roleRules` are always filled in by hand.

If a branch's Discord ranks don't line up with the game's, for example the Discord server has an extra rank, add it to the game's `BranchConfig` first, or leave it as a Discord-only role. A rank left blank still syncs in game. Players at that rank just get the member role in Discord.

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

**Back up `data/store.json`.** It holds account links, the bot-side warning history, Discord mutes and each player's last known rank. A weekly `scp` or DigitalOcean droplet backups both work.

## Notes

- **Rank sync loop guard:** the game tags each rank change with `Source` (`game` or `discord`), and the bot ignores role changes it made itself for a few seconds.
- **Offline actions:** void, rank, warn and pigeon are written to `IliadPending` and applied when the player next joins. If the player is online, the bot also sends a live nudge so the action applies right away. Each action has an ID and is applied only once.
- **Text from Discord** (pigeons, announcements) is run through Roblox's text filter as written by the sender's linked Roblox account, so senders must be linked.
- **Bans** use Roblox's built-in ban API, so they work across every server and server instance. `alts` also bans detected alt accounts.
