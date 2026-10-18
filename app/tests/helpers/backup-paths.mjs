import path from "node:path";

// Keep test path expectations independent from production's derivation.
export const backupPaths = (root, owners) => {
  const relative = (owner, name) => {
    const account = typeof owner === "string" ? owners[owner] : owner;
    const directory = path.join(".owners-v1", account.id);
    return name === undefined ? directory
      : path.join(directory, `${name}.excalidraw.json`);
  };
  return {
    relative,
    directory: (owner) => path.join(root, relative(owner)),
    file: (owner, name) => path.join(root, relative(owner, name)),
  };
};
