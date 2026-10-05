// Fills in branch role ids in config.json by matching the Discord role names in
// each branch's server to the game's rank names.
//
//   npm run build && npm run setup-roles            (dry run: shows what it found)
//   npm run setup-roles -- --write                  (saves the matches to config.json)
//   npm run setup-roles -- --write --overwrite      (also replaces ids already filled in)
//   npm run setup-roles -- SL MP                    (only these branches)
//
// A role matches a rank if its name equals the rank's id or its in-game label,
// ignoring case, spaces and punctuation, and ignoring a bracketed / separated
// prefix or suffix: "Captain", "[SL] Captain", "Captain | SL" and
// "SL - Captain" all match Captain. Anything it can't match is listed so you
// can fill it in by hand (right-click the role -> Copy Role ID).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REST, Routes, type APIRole } from "discord.js";
import { secrets } from "./config.js";

// In-game rank labels (mirrors the game's BranchConfig) so abbreviations match.
const LABELS: Record<string, string> = {
  PFC: "Private First Class",
  LCpl: "Lance Corporal",
  SGM: "Sergeant Major",
  SectionCommander: "Section Commander",
  AssistantCommander: "Assistant Commander",
  AwaitingTesting: "Awaiting Testing",
  TraineeInstructor: "Trainee Instructor",
  EsteemedInstructor: "Esteemed Trainee Instructor",
  SeniorInstructor: "Senior Trainee Instructor",
  DeputyHeadInstructor: "Deputy Head Trainee Instructor",
  HeadInstructor: "Head Trainee Instructor",
  Official: "Government Official",
  ViceCIC: "Vice Commander in Chief",
  CIC: "Commander in Chief",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The ways a role name can be read: whole, without [prefix], and each "|"/"-"/"•" segment. */
function readings(roleName: string): string[] {
  const out = new Set<string>([norm(roleName), norm(roleName.replace(/[[(【{].*?[\])】}]/g, ""))]);
  for (const part of roleName.split(/\s[|\-–—•:]\s|[|•]/)) out.add(norm(part));
  out.delete("");
  return [...out];
}

/** `whole`: match only the full role name (so "Captain | SL" isn't taken as the SL member role). */
function findRole(roles: APIRole[], names: string[], whole = false): APIRole | undefined {
  const wanted = new Set(names.map(norm));
  return roles.find((r) => (whole ? [norm(r.name)] : readings(r.name)).some((x) => wanted.has(x)));
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const overwrite = args.includes("--overwrite");
const only = args.filter((a) => !a.startsWith("--"));

const path = resolve(process.cwd(), "config.json");
const raw = JSON.parse(readFileSync(path, "utf8"));
const rest = new REST().setToken(secrets.discordToken);
let changes = 0;

for (const [id, b] of Object.entries<any>(raw.branches)) {
  if (only.length && !only.includes(id)) continue;
  const guildId: string = b.guildId || raw.guildId;
  let roles: APIRole[];
  let guildName = guildId;
  try {
    roles = (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
    guildName = ((await rest.get(Routes.guild(guildId))) as { name: string }).name;
  } catch (err) {
    console.log(`\n${b.name} (${id}): can't read server ${guildId} — is the bot in it? (${err instanceof Error ? err.message : err})`);
    continue;
  }
  roles = roles.filter((r) => r.name !== "@everyone" && !r.managed).sort((x, y) => y.position - x.position);
  console.log(`\n${b.name} (${id}) — server "${guildName}"`);

  const set = (label: string, current: string, role: APIRole | undefined, apply: (v: string) => void) => {
    if (current && !overwrite) {
      const existing = roles.find((r) => r.id === current);
      console.log(`  ${label.padEnd(22)} ${existing ? `✓ ${existing.name}` : `⚠ ${current} (not a role in this server)`}`);
      return;
    }
    if (!role) {
      console.log(`  ${label.padEnd(22)} ✗ no matching role — fill in by hand`);
      return;
    }
    console.log(`  ${label.padEnd(22)} → ${role.name} (${role.id})`);
    if (role.id !== current) {
      apply(role.id);
      changes++;
    }
  };

  // Branch member role: named after the branch ("Scouting Legion", "SL", ...).
  set("member role", b.role, findRole(roles, [b.name, id, `${b.name} Member`, `${id} Member`, `${b.name} Members`], true), (v) => (b.role = v));
  for (const rank of Object.keys(b.ranks)) {
    set(rank, b.ranks[rank], findRole(roles, [rank, LABELS[rank] ?? rank]), (v) => (b.ranks[rank] = v));
  }
  if (!b.officerRoles?.length) {
    const guess = roles.filter((r) => /officer|command|high ?rank|hr\b|staff/i.test(r.name)).map((r) => `${r.name} (${r.id})`);
    console.log(`  officerRoles           not set${guess.length ? ` — maybe: ${guess.slice(0, 5).join(", ")}` : ""}`);
  }

  // Roles that look like ranks but matched nothing (renamed or extra ranks).
  const used = new Set([b.role, ...Object.values<string>(b.ranks)]);
  const leftovers = roles.filter((r) => !used.has(r.id) && r.position > 0).slice(0, 40).map((r) => r.name);
  if (leftovers.length) console.log(`  other roles here: ${leftovers.join(", ")}`);
}

if (write && changes) {
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  console.log(`\nSaved ${changes} role id${changes === 1 ? "" : "s"} to config.json. Restart the bot to use them.`);
} else if (changes) {
  console.log(`\nFound ${changes} role id${changes === 1 ? "" : "s"}. Run again with --write to save them.`);
} else {
  console.log("\nNothing to change.");
}
