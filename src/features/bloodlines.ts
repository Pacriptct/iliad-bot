// Player-run bloodline applications, reviewed by staff in Discord.
//
//   1. A player with the Bloodline Founder pass applies in game. The game
//      emits bloodline_application; the bot posts a card in
//      channels.bloodlineReview with Approve / Request changes / Reject.
//   2. A staff member (main server, tier >= bloodlineReviewTier, with a linked
//      Roblox account) clicks; a modal takes the reason (a note for approve).
//   3. The decision is queued for the game (game.ts queueBloodlineDecision).
//      A live server applies it as the linked Roblox account, re-checking that
//      account's staff level from the Roblox group, and reports back with
//      bloodline_review_result. While no server runs it waits.
//   4. bloodline_decision (from Discord, in game or by chat command) finishes
//      the card and DMs the applicant's linked Discord account.
// A revision posts a new card and marks the old one superseded; a decision
// carries the revision it was made on, so the game refuses it if the text
// changed since.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { config, TIERS } from "../config.js";
import { log } from "../log.js";
import { store, type BloodlineCard } from "../store.js";
import { tierOf } from "../commands/permissions.js";
import { on, type GameEvent } from "../bridge/events.js";
import { liveServers } from "../bridge/servers.js";
import { queueBloodlineDecision } from "../bridge/game.js";

type Action = "approve" | "changes" | "reject";
const ACTIONS: Action[] = ["approve", "changes", "reject"];
const VERB: Record<Action, string> = { approve: "Approve", changes: "Request changes", reject: "Reject" };
const REASON_MAX = 300;
/** A queued decision with no answer after this long no longer blocks a new one. */
const QUEUE_LOCK_MS = 10 * 60 * 1000;

let client: Client;

const clean = (s: unknown) => String(s ?? "").replace(/@/g, "@​");

function cardEmbed(c: BloodlineCard): EmbedBuilder {
  const colour: Record<string, number> = {
    Pending: 0xd4a017,
    Approved: 0x2e8b57,
    Rejected: 0xc0392b,
    ChangesRequested: 0x5865f2,
    Withdrawn: 0x777777,
    Superseded: 0x777777,
  };
  const e = new EmbedBuilder()
    .setColor(colour[c.state] ?? 0x777777)
    .setTitle(`Bloodline application: ${clean(c.surname)} (${clean(c.name)})`.slice(0, 256))
    .setDescription(clean(c.lore) || "*No lore given.*")
    .addFields(
      { name: "Applicant", value: `${clean(c.applicantName)} (\`${c.applicantId}\`)`, inline: true },
      { name: "Founder", value: clean(c.founderName) || "?", inline: true },
      { name: "Ranks", value: c.ranks.length ? clean(c.ranks.join(", ")) : "none", inline: true },
      { name: "Application", value: `\`${c.appId}\` · revision ${c.revision}`, inline: true },
    )
    .setTimestamp(c.submittedAt * 1000);

  let status: string;
  if (c.state === "Pending") {
    status = c.queued
      ? `⏳ **${VERB[c.queued.action]}** by <@${c.queued.by}> is on its way to the game.`
      : "Waiting for staff review.";
  } else if (c.state === "Superseded") {
    status = `**Superseded** by revision ${c.supersededBy}: see the newer card.`;
  } else {
    const label = c.state === "ChangesRequested" ? "Changes requested" : c.state;
    status = `**${label}**${c.decidedBy ? ` by ${clean(c.decidedBy)}` : ""}${c.reason ? `: ${clean(c.reason)}` : ""}`;
  }
  if (c.note && c.state === "Pending") status += `\n-# ${clean(c.note)}`;
  e.addFields({ name: "Status", value: status.slice(0, 1024) });
  return e;
}

function buttons(c: BloodlineCard) {
  const disabled = c.state !== "Pending" || Boolean(c.queued);
  const id = (a: Action) => `blapp:${a}:${c.appId}:${c.revision}`;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id("approve")).setLabel("Approve").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(id("changes")).setLabel("Request changes").setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(id("reject")).setLabel("Reject").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

async function refreshCard(c: BloodlineCard) {
  const channel = await client.channels.fetch(c.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const msg = await channel.messages.fetch(c.messageId).catch(() => undefined);
  await msg?.edit({ embeds: [cardEmbed(c)], components: [buttons(c)] }).catch((err) => log.warn("bloodline card edit failed:", err.message));
}

async function dm(discordId: string | undefined, text: string) {
  if (!discordId) return;
  const user = await client.users.fetch(discordId).catch(() => undefined);
  await user?.send(text).catch(() => undefined);
}

// ── Game events ──────────────────────────────────────────────────────────────

async function onApplication(e: GameEvent) {
  const appId = String(e.AppId ?? "");
  const revision = Number(e.Revision) || 0;
  if (!appId) return;
  const existing = store.bloodlineCard(appId);
  // Already have this revision (a resync, or a repeat): nothing to post.
  if (existing && existing.revision >= revision) return;

  const channelId = config.channels.bloodlineReview;
  const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    log.warn(`bloodline application ${appId}: channels.bloodlineReview isn't set or isn't a text channel`);
    return;
  }

  if (existing && existing.state === "Pending") {
    existing.state = "Superseded";
    existing.supersededBy = revision;
    existing.queued = undefined;
    store.saveBloodlineCard(existing);
    await refreshCard(existing);
  }

  const card: BloodlineCard = {
    appId,
    revision,
    state: "Pending",
    name: String(e.Name ?? ""),
    surname: String(e.Surname ?? ""),
    lore: String(e.Lore ?? "").slice(0, 2000),
    ranks: Array.isArray(e.Ranks) ? e.Ranks.map(String) : [],
    founderName: String(e.FounderName ?? ""),
    applicantId: Number(e.Applicant?.UserId) || 0,
    applicantName: String(e.Applicant?.Name ?? "?"),
    submittedAt: Number(e.SubmittedAt) || Math.floor(Date.now() / 1000),
    channelId: "",
    messageId: "",
  };
  const msg = await channel.send({ embeds: [cardEmbed(card)], components: [buttons(card)] });
  card.channelId = msg.channelId;
  card.messageId = msg.id;
  store.saveBloodlineCard(card);
}

const APPLICANT_DM: Record<string, (surname: string, reason: string) => string> = {
  approve: (s) => `📜 Your bloodline application for **${s}** was approved. You are its founder: invite your family from the Bloodline tab in game.`,
  reject: (s, r) => `📜 Your bloodline application for **${s}** was rejected${r ? `: ${r}` : "."}`,
  changes: (s, r) => `📜 Staff asked for changes to your bloodline application for **${s}**${r ? `: ${r}` : "."} Revise it from the Bloodline tab in game.`,
};

async function onDecision(e: GameEvent) {
  const appId = String(e.AppId ?? "");
  const card = store.bloodlineCard(appId);
  const reason = String(e.Reason ?? "");
  if (card && card.revision === Number(e.Revision) && card.state !== "Superseded") {
    card.state = String(e.State ?? card.state);
    card.decidedBy = `${e.By?.Name ?? "?"}${e.Via === "discord" ? "" : " (in game)"}`;
    card.reason = reason || undefined;
    card.queued = undefined;
    store.saveBloodlineCard(card);
    await refreshCard(card);
  }
  const action = String(e.Action ?? "");
  const text = APPLICANT_DM[action];
  if (text && e.Changed) {
    await dm(store.linkByRoblox(Number(e.Applicant?.UserId))?.discordId, text(clean(e.Surname), clean(reason)));
  }
}

async function onResult(e: GameEvent) {
  const card = store.bloodlineCard(String(e.AppId ?? ""));
  if (card?.queued && card.queued.decisionId === e.DecisionId) {
    card.queued = undefined;
    card.note = e.Ok ? undefined : `Last attempt refused: ${String(e.Message ?? "")}`;
    store.saveBloodlineCard(card);
    await refreshCard(card);
  }
  if (!e.Ok) {
    await dm(String(e.DiscordId ?? ""), `📜 Your decision on bloodline application \`${e.AppId}\` wasn't applied: ${clean(e.Message)}`);
  }
}

// ── Buttons and the reason modal ─────────────────────────────────────────────

/** Why this person may not decide, or undefined if they may. */
function cannotReview(i: ButtonInteraction | ModalSubmitInteraction): string | undefined {
  if (i.guildId !== config.guildId || !i.inCachedGuild()) return "Bloodline applications are reviewed in the main server.";
  const tier = tierOf(i.member);
  if (!tier || TIERS.indexOf(tier) < TIERS.indexOf(config.bloodlineReviewTier)) return "You can't review bloodline applications.";
  if (!store.linkByDiscord(i.user.id)) return "Link your Roblox account first (`/link`): the game checks your staff rank on it.";
  return undefined;
}

/** The card if it can still be decided at this revision, or why not. */
function openCard(appId: string, revision: number): BloodlineCard | string {
  const card = store.bloodlineCard(appId);
  if (!card) return "That application isn't known to the bot any more.";
  if (card.revision !== revision || card.state === "Superseded") return "This card is out of date: decide on the newer one.";
  if (card.state !== "Pending") return "This application was already decided.";
  if (card.queued && Date.now() - card.queued.at < QUEUE_LOCK_MS) return `A decision by <@${card.queued.by}> is already on its way.`;
  return card;
}

async function onButton(i: ButtonInteraction, action: Action, appId: string, revision: number) {
  const why = cannotReview(i);
  const card = openCard(appId, revision);
  if (why || typeof card === "string") {
    await i.reply({ flags: MessageFlags.Ephemeral, content: why ?? (card as string) });
    return;
  }
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(REASON_MAX)
    .setRequired(action !== "approve");
  if (action === "approve") reason.setLabel("Note (optional, shown to the applicant)");
  else reason.setLabel("Reason (shown to the applicant)");
  const modal = new ModalBuilder()
    .setCustomId(`blapp_reason:${action}:${appId}:${revision}`)
    .setTitle(`${VERB[action]}: ${card.surname}`.slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reason));
  await i.showModal(modal);
}

async function onModal(i: ModalSubmitInteraction, action: Action, appId: string, revision: number) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  // Checked again: the card may have moved on while the modal was open.
  const why = cannotReview(i);
  const card = openCard(appId, revision);
  if (why || typeof card === "string") {
    await i.editReply(why ?? (card as string));
    return;
  }
  const reason = i.fields.getTextInputValue("reason").trim();
  if (action !== "approve" && !reason) {
    await i.editReply("Give the applicant a reason.");
    return;
  }
  const link = store.linkByDiscord(i.user.id)!;
  const decisionId = randomUUID();
  card.queued = { decisionId, by: i.user.id, action, at: Date.now() };
  card.note = undefined;
  store.saveBloodlineCard(card);
  await refreshCard(card);

  try {
    await queueBloodlineDecision({
      Id: decisionId,
      AppId: appId,
      Revision: revision,
      Action: action,
      Reason: reason,
      RobloxUserId: link.robloxId,
      RobloxName: link.robloxName,
      DiscordId: i.user.id,
      DiscordName: i.user.username,
      At: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    card.queued = undefined;
    store.saveBloodlineCard(card);
    await refreshCard(card);
    await i.editReply(`Couldn't send the decision to the game: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const live = liveServers().some((s) => !s.studio);
  await i.editReply(
    live
      ? `Sent: **${VERB[action]}** on ${card.surname}. The card updates once a game server applies it.`
      : `Queued: **${VERB[action]}** on ${card.surname}. No game server is running, so it applies when one starts.`,
  );
}

export function registerBloodlines(c: Client) {
  client = c;
  on("bloodline_application", onApplication);
  on("bloodline_decision", onDecision);
  on("bloodline_review_result", onResult);

  client.on(Events.InteractionCreate, async (interaction) => {
    const isButton = interaction.isButton() && interaction.customId.startsWith("blapp:");
    const isModal = interaction.isModalSubmit() && interaction.customId.startsWith("blapp_reason:");
    if (!isButton && !isModal) return;
    const [, action, appId, rev] = interaction.customId.split(":");
    if (!ACTIONS.includes(action as Action) || !appId) return;
    const run = isButton
      ? onButton(interaction as ButtonInteraction, action as Action, appId, Number(rev))
      : onModal(interaction as ModalSubmitInteraction, action as Action, appId, Number(rev));
    await run.catch((err) => log.error("bloodline review failed:", err));
  });
}
