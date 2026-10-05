// Messenger pigeons between Discord and the game.
//   Game -> Discord : pigeon_out events are DMed to the recipient if their
//                     account is linked (with a Reply button).
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
} from "discord.js";
import { store } from "../store.js";
import { on, who } from "../bridge/events.js";
import { queueAction } from "../bridge/game.js";
import { line } from "./channels.js";
import { ensureLinked } from "./autolink.js";

export const MAX_LETTER = 1000;

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
  return undefined;
}

export function registerPigeons(client: Client) {
  on("pigeon_out", async (e) => {
    line("pigeons", `🕊️ **${who(e.From)}** → **${e.ToName}**: ${String(e.Text).replace(/@/g, "@​").slice(0, 300)}`);
    const link = store.linkByRoblox(Number(e.ToUserId));
    if (!link) return;
    const user = await client.users.fetch(link.discordId).catch(() => undefined);
    if (!user) return;
    const fromName = e.From?.Character || e.From?.Name || "someone";
    await user
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xc8a96e)
            .setTitle(`🕊️ A pigeon from ${fromName}`)
            .setDescription(String(e.Text).slice(0, 4000))
            .setFooter({ text: `@${e.From?.Name ?? "?"} · sent in game` })
            .setTimestamp(e.At * 1000),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`pigeon_reply:${e.From?.UserId}:${e.From?.Name}`)
              .setLabel("Reply")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      })
      .catch(() => undefined);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
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
      await interaction.deferReply({ ephemeral: true });
      const error = await sendPigeonFromDiscord(interaction.user, Number(userId), name, interaction.fields.getTextInputValue("text")).catch(
        (err) => `The pigeon couldn't take off: ${err instanceof Error ? err.message : err}`,
      );
      await interaction.editReply(error ?? `🕊️ Your pigeon is flying to **${name}**.`);
    }
  });
}
