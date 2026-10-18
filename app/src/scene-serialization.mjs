// Keep the installed public serializer responsible for canonical state/metadata
// and element cleaning. Its database mode otherwise drops tombstones and files.
export function serializeScene(elements, appState, files, serializeAsJSON) {
  const deletedIds = new Set(elements.filter(element => element.isDeleted).map(element => element.id));
  // Present tombstones to canonical element cleaning without changing the canvas.
  const serializable = deletedIds.size
    ? elements.map(element => element.isDeleted ? { ...element, isDeleted: false } : element)
    : elements;
  const json = serializeAsJSON(serializable, appState, files, "database");
  const referencedFiles = Object.fromEntries(elements
    .filter(element => element.type === "image" && element.fileId && Object.hasOwn(files, element.fileId))
    .map(element => [element.fileId, files[element.fileId]]));
  const hasFiles = Object.keys(referencedFiles).length > 0;
  if (!deletedIds.size && !hasFiles) return json;

  const scene = JSON.parse(json);
  if (deletedIds.size) {
    scene.elements = scene.elements.map(element => deletedIds.has(element.id)
      ? { ...element, isDeleted: true } : element);
  }
  // getFiles() may contain other documents' cache entries. Include only this
  // scene's image references, including retained deleted images, never the cache.
  if (hasFiles) scene.files = referencedFiles;
  return JSON.stringify(scene, null, 2);
}
