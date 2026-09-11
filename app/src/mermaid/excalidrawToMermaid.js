const SUPPORTED_NODE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const SUPPORTED_CONNECTOR_TYPES = new Set(["arrow", "line"]);

const compareById = (left, right) => left.id.localeCompare(right.id);

const toMermaidNodeId = (elementId) =>
  `n${Array.from(elementId, (character) =>
    `_${character.codePointAt(0).toString(16)}`).join("")}`;

const escapeLabel = (label) =>
  String(label)
    .replaceAll("&", "&amp;")
    .replaceAll("\\", "&#92;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\r\n?|\n/g, "<br/>");

const getTextLabel = (textElement) =>
  textElement ? escapeLabel(textElement.originalText ?? textElement.text ?? "") : "";

const formatNode = (element, label) => {
  const nodeId = toMermaidNodeId(element.id);

  if (element.type === "ellipse") {
    return `${nodeId}(["${label}"])`;
  }

  if (element.type === "diamond") {
    return `${nodeId}{"${label}"}`;
  }

  return `${nodeId}["${label}"]`;
};

const formatTypeCounts = (typeCounts) =>
  [...typeCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type} (${count})`)
    .join(", ");

export function excalidrawToMermaid(elements) {
  const activeElements = elements.filter((element) => !element.isDeleted);
  const elementsById = new Map();
  const nodesById = new Map();
  const connectorsById = new Map();
  const labelsByContainerId = new Map();
  const labelCountsByContainerId = new Map();
  const unsupportedTypeCounts = new Map();

  for (const element of activeElements) {
    elementsById.set(element.id, element);

    if (SUPPORTED_NODE_TYPES.has(element.type)) {
      nodesById.set(element.id, element);
    } else if (SUPPORTED_CONNECTOR_TYPES.has(element.type)) {
      connectorsById.set(element.id, element);
    } else if (element.type !== "text") {
      unsupportedTypeCounts.set(
        element.type,
        (unsupportedTypeCounts.get(element.type) ?? 0) + 1,
      );
    }
  }

  let omittedTextCount = 0;

  for (const element of activeElements) {
    if (element.type !== "text") {
      continue;
    }

    const container = element.containerId
      ? elementsById.get(element.containerId)
      : null;
    const hasSupportedContainer =
      container &&
      (SUPPORTED_NODE_TYPES.has(container.type) ||
        SUPPORTED_CONNECTOR_TYPES.has(container.type));

    if (!hasSupportedContainer) {
      omittedTextCount += 1;
      continue;
    }

    labelCountsByContainerId.set(
      element.containerId,
      (labelCountsByContainerId.get(element.containerId) ?? 0) + 1,
    );

    const currentLabel = labelsByContainerId.get(element.containerId);
    if (!currentLabel || element.id.localeCompare(currentLabel.id) < 0) {
      labelsByContainerId.set(element.containerId, element);
    }
  }

  const lines = ["flowchart TD"];

  for (const node of [...nodesById.values()].sort(compareById)) {
    const labelElement = labelsByContainerId.get(node.id);
    const label = labelElement
      ? getTextLabel(labelElement) || " "
      : escapeLabel(node.id);

    lines.push(`  ${formatNode(node, label)}`);
  }

  let unboundConnectorCount = 0;
  let danglingConnectorCount = 0;
  let omittedConnectorLabelCount = 0;

  for (const connector of [...connectorsById.values()].sort(compareById)) {
    const startId = connector.startBinding?.elementId;
    const endId = connector.endBinding?.elementId;

    if (!startId && !endId) {
      unboundConnectorCount += 1;
      omittedConnectorLabelCount += labelCountsByContainerId.get(connector.id) ?? 0;
      continue;
    }

    if (!nodesById.has(startId) || !nodesById.has(endId)) {
      danglingConnectorCount += 1;
      omittedConnectorLabelCount += labelCountsByContainerId.get(connector.id) ?? 0;
      continue;
    }

    const hasStartArrowhead = connector.startArrowhead != null;
    const hasEndArrowhead = connector.endArrowhead != null;
    const reverseDirection = hasStartArrowhead && !hasEndArrowhead;
    const sourceId = toMermaidNodeId(reverseDirection ? endId : startId);
    const targetId = toMermaidNodeId(reverseDirection ? startId : endId);
    const operator =
      hasStartArrowhead && hasEndArrowhead
        ? "<-->"
        : hasStartArrowhead || hasEndArrowhead
          ? "-->"
          : "---";
    const labelElement = labelsByContainerId.get(connector.id);
    const escapedLabel = getTextLabel(labelElement);
    const label = escapedLabel ? `|"${escapedLabel}"|` : "";

    lines.push(`  ${sourceId} ${operator}${label} ${targetId}`);
  }

  const warnings = [];
  const unsupportedCount = [...unsupportedTypeCounts.values()].reduce(
    (total, count) => total + count,
    0,
  );

  if (unsupportedCount > 0) {
    warnings.push(
      `${unsupportedCount} unsupported element(s) skipped: ${formatTypeCounts(unsupportedTypeCounts)}.`,
    );
  }

  if (omittedTextCount > 0) {
    warnings.push(`${omittedTextCount} unbound text label(s) skipped.`);
  }

  if (unboundConnectorCount > 0) {
    warnings.push(`${unboundConnectorCount} unbound connector(s) skipped.`);
  }

  if (danglingConnectorCount > 0) {
    warnings.push(`${danglingConnectorCount} dangling connector(s) skipped.`);
  }

  if (omittedConnectorLabelCount > 0) {
    warnings.push(
      `${omittedConnectorLabelCount} bound connector label(s) skipped with omitted connector(s).`,
    );
  }

  return {
    mermaid: `${lines.join("\n")}\n`,
    warnings,
    omittedCount:
      unsupportedCount +
      omittedTextCount +
      unboundConnectorCount +
      danglingConnectorCount +
      omittedConnectorLabelCount,
  };
}
