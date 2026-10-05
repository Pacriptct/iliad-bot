import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder, SlashCommandBuilder } from "discord.js";

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  /** Staff-only: the command name is looked up in config.commandPermissions. */
  staff?: boolean;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
