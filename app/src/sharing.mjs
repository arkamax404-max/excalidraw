// Sharing is owner-only, so these decisions never invent authority: they expose
// an id path only for a diagram the user owns by file name, and they reject a
// username the server would reject anyway.
const USERNAME = /^[A-Za-z0-9._-]{3,50}$/;

export const validUsername = (value) =>
  typeof value === "string" && USERNAME.test(value.trim());

export const sharePath = (identity) =>
  identity?.kind === "file" && identity?.id ? `/api/diagrams/${identity.id}/members` : null;

export const memberPath = (identity, username) =>
  sharePath(identity) ? `${sharePath(identity)}/${encodeURIComponent(username)}` : null;

export const memberNames = (payload) => (payload?.members ?? [])
  .map((member) => (member && typeof member === "object" ? member.username : null))
  .filter((name) => typeof name === "string" && name.trim() !== "")
  .sort();
