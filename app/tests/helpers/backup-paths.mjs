import path from "node:path";

// Fixture owners carry both identities; the current backup layout uses username.
export const backupPaths = (root, owners) => {
  const relative = (owner, name) => {
    const account = typeof owner === "string" ? owners[owner] : owner;
    return name === undefined ? account.username
      : path.join(account.username, `${name}.excalidraw.json`);
  };
  return {
    relative,
    directory: (owner) => path.join(root, relative(owner)),
    file: (owner, name) => path.join(root, relative(owner, name)),
  };
};
