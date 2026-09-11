import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertAndInsertMermaidCore } from "./mermaidSceneCore.js";

export async function convertAndInsertMermaid({
  mermaid,
  excalidrawAPI,
}) {
  return convertAndInsertMermaidCore({
    mermaid,
    excalidrawAPI,
    parse: parseMermaidToExcalidraw,
    convert: convertToExcalidrawElements,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}
