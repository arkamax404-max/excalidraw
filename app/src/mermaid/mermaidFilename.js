const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_BASE_NAME_LENGTH = 120;

export function toMermaidDownloadFilename(diagramName) {
  const withoutExtension = String(diagramName ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/(?:\.mmd)+$/i, "")
    .trim();
  const withoutControlCharacters = Array.from(withoutExtension, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127 ? "-" : character;
  }).join("");
  const sanitizedName = withoutControlCharacters
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .trim();
  const boundedName = Array.from(sanitizedName)
    .slice(0, MAX_BASE_NAME_LENGTH)
    .join("")
    .replace(/[\s.]+$/g, "");

  if (!boundedName || WINDOWS_RESERVED_NAME.test(boundedName)) {
    return "diagram.mmd";
  }

  return `${boundedName}.mmd`;
}
