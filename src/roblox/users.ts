// Roblox user lookups (public users API, no key needed).
export interface RobloxUser {
  id: number;
  name: string;
  displayName: string;
}

export async function userByName(username: string): Promise<RobloxUser | undefined> {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { data?: RobloxUser[] };
  return body.data?.[0];
}

export async function userById(id: number): Promise<RobloxUser | undefined> {
  const res = await fetch(`https://users.roblox.com/v1/users/${id}`);
  if (!res.ok) return undefined;
  return (await res.json()) as RobloxUser;
}

export function profileUrl(id: number) {
  return `https://www.roblox.com/users/${id}/profile`;
}
