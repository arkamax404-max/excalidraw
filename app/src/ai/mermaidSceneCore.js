const GAP = 80;

export function placeGeneratedElements(existingElements, generatedElements) {
  if (generatedElements.length === 0) {
    throw new Error("The generated diagram contains no elements.");
  }

  const activeExisting = existingElements.filter((element) => !element.isDeleted);
  if (activeExisting.length === 0) {
    return generatedElements;
  }

  const existingRight = Math.max(
    ...activeExisting.map((element) => element.x + element.width),
  );
  const existingTop = Math.min(...activeExisting.map((element) => element.y));
  const generatedLeft = Math.min(...generatedElements.map((element) => element.x));
  const generatedTop = Math.min(...generatedElements.map((element) => element.y));
  const offsetX = existingRight + GAP - generatedLeft;
  const offsetY = existingTop - generatedTop;

  return generatedElements.map((element) => ({
    ...element,
    x: element.x + offsetX,
    y: element.y + offsetY,
  }));
}

export async function convertAndInsertMermaidCore({
  mermaid,
  excalidrawAPI,
  parse,
  convert,
  captureUpdate,
}) {
  const { elements: skeletonElements, files = {} } = await parse(mermaid, {
    maxEdges: 250,
    maxTextSize: 20000,
  });
  const convertedElements = convert(skeletonElements, { regenerateIds: true });
  const existingElements = excalidrawAPI.getSceneElementsIncludingDeleted();
  const generatedElements = placeGeneratedElements(existingElements, convertedElements);
  const binaryFiles = Object.values(files);

  if (binaryFiles.length > 0) {
    excalidrawAPI.addFiles(binaryFiles);
  }

  excalidrawAPI.updateScene({
    elements: [...existingElements, ...generatedElements],
    appState: {
      selectedElementIds: Object.fromEntries(
        generatedElements.map((element) => [element.id, true]),
      ),
    },
    captureUpdate,
  });

  return generatedElements;
}
