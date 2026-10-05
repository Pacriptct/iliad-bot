import { PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import { config, TIERS, type Tier } from "../config.js";

/** Highest staff tier the member holds (Discord Administrators count as owner). */
export function tierOf(member: GuildMember | null): Tier | undefined {
  if (!member) return undefined;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return "owner";
  let best: Tier | undefined;
  for (const tier of TIERS) {
    if (config.staffRoles[tier]?.some((id) => member.roles.cache.has(id))) best = tier;
  }
  return best;
}

export function allowed(interaction: ChatInputCommandInteraction): boolean {
  const required = config.commandPermissions[interaction.commandName] ?? "owner";
  const member = interaction.inCachedGuild() ? interaction.member : null;
  const tier = tierOf(member);
  return tier !== undefined && TIERS.indexOf(tier) >= TIERS.indexOf(required);
}
