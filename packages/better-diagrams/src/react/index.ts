/**
 * react/ — the rendering half.
 *
 * Everything that needs React or @xyflow/react: the editor component, its
 * custom nodes and edges, the registry that makes it extensible, and the
 * exporters (which need a DOM canvas for the raster formats).
 */

export { ArchitectureStudio } from "./ArchitectureStudio";
export type { ArchitectureStudioProps, StudioSlotContext } from "./ArchitectureStudio";
export { DiffCanvas } from "./DiffCanvas";
export { TimelineCanvas } from "./TimelineCanvas";

export { SequenceStudio } from "./sequence/SequenceStudio";
export type { SequenceStudioProps } from "./sequence/SequenceStudio";
export { SequenceTimelineCanvas } from "./sequence/SequenceTimelineCanvas";
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
export type { ExportPalette, DrawCmd, Emitted } from "./draw";
export { silhouettePath } from "./shapes";
export type { Silhouette } from "./shapes";

export { themeToStyle, paletteFromTheme, DARK_THEME, LIGHT_THEME } from "./theme";
export type { Theme } from "./theme";

export { DateChip, TimelineScrubber } from "./chrome";
export type { StudioFile } from "./chrome";
