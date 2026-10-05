// Messenger pigeons between Discord and the game.
//   Every letter lands in the recipient's in-game letterbox, and, if their
//   account is linked, also in their Discord DMs with a Reply button, no
//   matter whether it was written in game or from Discord.
//   Game -> Discord : pigeon_out events.
//   Discord -> game : /pigeon (or Reply) queues a `pigeon` action for the
//                     recipient; the game filters + delivers it.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type User,
  MessageFlags,
} from "discord.js";
import { store } from "../store.js";
import { name, on } from "../bridge/events.js";
import { queueAction } from "../bridge/game.js";
import { line } from "./channels.js";
import { ensureLinked } from "./autolink.js";

export const MAX_LETTER = 1000;

let client: Client | undefined;

interface Sender {
  UserId?: number;
  Name?: string;
  Character?: string;
}

/** DM a letter to the recipient's linked Discord account (no-op if they aren't linked). */
async function dmLetter(toUserId: number, from: Sender, text: string, via: "game" | "discord", at = Date.now()) {
  const link = store.linkByRoblox(toUserId);
  if (!link || !client) return;
  const user = await client.users.fetch(link.discordId).catch(() => undefined);
  if (!user) return;
  const fromName = from.Character || from.Name || "someone";
  await user
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xc8a96e)
          .setTitle(`🕊️ A pigeon from ${fromName}`)
          .setDescription(text.slice(0, 4000))
          .setFooter({ text: `@${from.Name ?? "?"} · sent ${via === "game" ? "in game" : "from Discord"}` })
          .setTimestamp(at),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`pigeon_reply:${from.UserId}:${from.Name}`).setLabel("Reply").setStyle(ButtonStyle.Primary),
        ),
      ],
    })
    .catch(() => undefined);
}

/** Send a letter from a linked Discord user to a Roblox user. Returns an error message or undefined. */
export async function sendPigeonFromDiscord(sender: User, toUserId: number, toName: string, text: string): Promise<string | undefined> {
  const link = await ensureLinked(sender.id);
  if (!link) return "You need to link your Roblox account first (`/link`).";
  if (toUserId === link.robloxId) return "You can't send a letter to yourself.";
  const body = text.trim();
  if (!body || body.length > MAX_LETTER) return `Letters must be 1-${MAX_LETTER} characters.`;

  await queueAction(
    toUserId,
    "pigeon",
    {
      Id: `d-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      From: { UserId: link.robloxId, Name: link.robloxName, Character: "", Discord: sender.username },
      Text: body,
      Via: "discord",
      At: Math.floor(Date.now() / 1000),
    },
    `Discord (${sender.username})`,
  );
  line("pigeons", `🕊️ **${link.robloxName}** (via Discord, ${sender}) → **${toName}**: ${body.replace(/@/g, "@​").slice(0, 300)}`);
  await dmLetter(toUserId, { UserId: link.robloxId, Name: link.robloxName }, body, "discord");
  return undefined;
}

export function registerPigeons(c: Client) {
  client = c;
  on("pigeon_out", async (e) => {
    line("pigeons", `🕊️ ${name(e.From)} → **${e.ToName}**: ${String(e.Text).replace(/@/g, "@​").slice(0, 300)}`);
    await dmLetter(Number(e.ToUserId), e.From ?? {}, String(e.Text), "game", (e.At ?? Date.now() / 1000) * 1000);
  });

  c.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith("pigeon_reply:")) {
      const [, userId, name] = interaction.customId.split(":");
      const modal = new ModalBuilder()
        .setCustomId(`pigeon_send:${userId}:${name}`)
        .setTitle(`Reply to ${name}`.slice(0, 45))
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("text")
              .setLabel("Your letter")
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(MAX_LETTER)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith("pigeon_send:")) {
      const [, userId, name] = interaction.customId.split(":");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const error = await sendPigeonFromDiscord(interaction.user, Number(userId), name, interaction.fields.getTextInputValue("text")).catch(
        (err) => `The pigeon couldn't take off: ${err instanceof Error ? err.message : err}`,
      );
      await interaction.editReply(error ?? `🕊️ Your pigeon is flying to **${name}**.`);
    }
  });
}
