// PD announcements + the PD log. (Starting/stopping PDs stays in game only.)
import { EmbedBuilder } from "discord.js";
import { config } from "../config.js";
import { on } from "../bridge/events.js";
import { embed, line, sendNow } from "./channels.js";

const COLORS: Record<string, number> = {
  pd_start: 0xff0000,
  pd_end: 0x740091,
  pd_type: 0x00aaff,
  pd_death: 0xff4444,
  pd_mia: 0xffa500,
};

function ping(): string {
  const p = config.pdAnnouncePing;
  if (!p) return "";
  if (p === "@everyone" || p === "@here") return p;
  return `<@&${p}>`;
}

function list(text: unknown): string {
  const s = String(text ?? "").trim();
  if (!s) return "—";
  return s.length > 1000 ? `${s.slice(0, 1000)}…` : s;
}

export function registerPd() {
  on("pd", async (e, meta) => {
    if (meta.Studio) return; // never announce Studio play-tests
    const type = String(e.pdType ?? "").toUpperCase();
    switch (e.eventType) {
      case "pd_start":
        await sendNow("pdAnnouncements", {
          content: ping() || undefined,
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.pd_start)
              .setTitle(`⚔️ A ${type || ""} PD has begun`)
              .setDescription(`Deaths are **permanent** until it ends.\n${e.totalTracked ?? "?"} soldiers are in the field.`)
              .setFooter({ text: `Started by ${e.executorName}` })
              .setTimestamp(e.At * 1000),
          ],
        });
        break;
      case "pd_end":
        await sendNow("pdAnnouncements", {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.pd_end)
              .setTitle(`🕊️ The ${type || ""} PD has ended`)
              .addFields(
                { name: "Survived", value: list(e.aliveList), inline: true },
                { name: "Fallen", value: list(e.deadList), inline: true },
              )
              .setFooter({ text: `${e.totalTracked ?? "?"} tracked · ended by ${e.executorName}` })
              .setTimestamp(e.At * 1000),
          ],
        });
        break;
      case "pd_type":
        await sendNow("pdAnnouncements", {
          embeds: [new EmbedBuilder().setColor(COLORS.pd_type).setTitle(`The PD is now ${type}`).setTimestamp(e.At * 1000)],
        });
        break;
      case "pd_death":
        line("pdLog", `💀 **${e.playerName}** fell in the ${type} PD`);
        break;
      case "pd_mia":
        line("pdLog", `🚪 **${e.playerName}** left during the ${type} PD *(MIA)*`);
        break;
    }
    if (e.eventType === "pd_start" || e.eventType === "pd_end" || e.eventType === "pd_type") {
      const what = { pd_start: `🔴 ${type} PD started`, pd_end: `🟣 ${type} PD ended`, pd_type: `🔵 PD changed to ${type}` }[e.eventType as "pd_start"];
      line("pdLog", `${what}${e.executorName ? ` · by ${e.executorName}` : ""}`);
    }
  });
}
