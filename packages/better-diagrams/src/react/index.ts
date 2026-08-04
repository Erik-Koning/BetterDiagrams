/**
 * react/ — the rendering half.
 *
 * Everything that needs React or @xyflow/react: the editor component, its
 * custom nodes and edges, the registry that makes it extensible, and the
 * exporters (which need a DOM canvas for the raster formats).
 */

export { ArchitectureStudio } from "./ArchitectureStudio";
export type { ArchitectureStudioProps, StudioSelection, StudioSlotContext } from "./ArchitectureStudio";
export { DiffCanvas } from "./DiffCanvas";

export { SequenceStudio } from "./sequence/SequenceStudio";
export type { SequenceSelection, SequenceStudioProps } from "./sequence/SequenceStudio";
export {
  BUILTIN_SEQUENCE_EXPORTERS,
  renderSequenceToCanvas,
  renderSequenceToSvg,
  renderSequenceToMermaid,
  renderSequenceToPlantUml,
} from "./sequence-exporters";
export { emitSequence } from "./sequence-draw";

export { createRegistry } from "./create-registry";
export {
  resolveRegistry,
  BUILTIN_NODE_KINDS,
  BUILTIN_PROVIDERS,
  kindDef,
  iconPaths,
  providerDef,
  zoneInk,
  zoneFill,
  FALLBACK_KIND,
  FALLBACK_PROVIDER,
} from "./registry";
export type {
  RegistryExtensions,
  ResolvedRegistry,
  NodeKindDef,
  NodeShape,
  ProviderDef,
  ExporterDef,
  ExportContext,
  ExportResult,
} from "./registry";

export { BUILTIN_ICON_PATHS, SvgIcon } from "./icons";
export type { IconPaths } from "./icons";

export {
  BUILTIN_EXPORTERS,
  renderTemplateToCanvas,
  renderTemplateToSvg,
  renderTemplateToMermaid,
  renderTemplateToC4Puml,
  emitTemplate,
  DARK_EXPORT_PALETTE,
  LIGHT_EXPORT_PALETTE,
} from "./exporters";
export type { ExportPalette, DrawCmd, DrawTag, Emitted } from "./draw";
export { buildTimelineHtml } from "./html-export";
export type { TimelineHtmlOptions } from "./html-export";
export { silhouettePath } from "./shapes";
export type { Silhouette } from "./shapes";

export { themeToStyle, paletteFromTheme, DARK_THEME, LIGHT_THEME } from "./theme";
export type { Theme } from "./theme";

export { BrandMark, DateChip, TimelineScrubber } from "./chrome";
export { WelcomeModal } from "./WelcomeModal";
export type { WelcomeModalProps } from "./WelcomeModal";
export type { StudioFile, StudioFileInit } from "./chrome";
