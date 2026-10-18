// Loaded only by the disposable fixture child, never by the production server.
import { promises as fs } from "node:fs";

let armed;
let release;
process.on("message", (message) => {
  if (message.storage === "arm") {
    armed = message;
    process.send({ storage: "armed" });
  } else if (message.storage === "release") {
    release?.();
  }
});
for (const operation of ["writeFile", "unlink", "rm"]) {
  const original = fs[operation];
  fs[operation] = async (...args) => {
    if (armed?.operation === operation && String(args[0]) === armed.path) {
      const fault = armed.fault;
      armed = undefined;
      await new Promise((resolve) => {
        release = resolve;
        process.send({ storage: "blocked" });
      });
      release = undefined;
      if (fault) throw Object.assign(new Error("isolated storage fault"), { code: "EIO" });
    }
    return original(...args);
  };
}
