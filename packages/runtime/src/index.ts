// @evolspace/runtime — browser scene runtime for EvolSpace. See README.md.

export { NetClient } from './net/NetClient.ts';
export type { NetClientOptions, NetStatus, WebSocketLike, WebSocketCtor, TensorListener, ServerMessageOf } from './net/NetClient.ts';
export type { NetPort } from './net/types.ts';

export { SpaceRuntime } from './SpaceRuntime.ts';
export type { SpaceRuntimeOptions, GestureDefs, RuntimeEnvironment } from './SpaceRuntime.ts';
export { createFloorGrid } from './scene/FloorGrid.ts';
export type { FloorGridOptions } from './scene/FloorGrid.ts';
export { passiveNetPort, PASSIVE_ALLOWED } from './net/passive.ts';

export { ChannelHub } from './data/ChannelHub.ts';
export { SceneMirror, applyPatch, normalizeEntity, entityChanges } from './scene/SceneMirror.ts';
export type { SceneDiff, EntityChange } from './scene/SceneMirror.ts';
export { Reconciler } from './scene/Reconciler.ts';
export type { EntityNode, ReconcilerHooks } from './scene/Reconciler.ts';
export { SceneWriter } from './scene/SceneWriter.ts';
export { AnchorRig, LazyFollower } from './scene/anchors.ts';

export { WidgetHost } from './widgets/WidgetHost.ts';
export type { ModuleLoader, WidgetRecord, WidgetStatus } from './widgets/WidgetHost.ts';
export { resolveProps, coerce } from './widgets/props.ts';

export { LinkEngine } from './links/LinkEngine.ts';
export type { LinkTargets, DeliverInfo } from './links/LinkEngine.ts';
export { compileTransform } from './links/compile.ts';

export { Picker } from './interaction/Picker.ts';
export { PointerVisuals } from './interaction/PointerVisuals.ts';
export { RuntimeInteractionHost } from './interaction/RuntimeInteractionHost.ts';
export type { Hit, InteractionHost, PointerRays, GesturePhase } from './interaction/types.ts';

export { LocalCommands } from './commands/LocalCommands.ts';
export type { LocalCommandFn, CommandPhase } from './commands/LocalCommands.ts';

export { RuntimeUiKit, rampColor } from './ui/UiKit.ts';
export type { TextFactory, TextLike, RuntimeText, TextOptionsEx, PanelOptions, Ramp } from './ui/UiKit.ts';
export { stubTextFactory, estimateTextBlock } from './ui/stubText.ts';
export { FONTS, FONT_BASE, fontUrl } from './ui/fonts.ts';
export { BoundsOutline } from './ui/BoundsOutline.ts';
export { roundedRectGeometry, markShared, isShared } from './ui/geometry.ts';

export { SystemUi } from './system/SystemUi.ts';
export type { SystemUiOptions } from './system/SystemUi.ts';
export { AgentOrb } from './system/AgentOrb.ts';
export type { OrbState } from './system/AgentOrb.ts';
export { AgentPanel } from './system/AgentPanel.ts';
export { VoiceHud } from './system/VoiceHud.ts';
export { Toasts } from './system/Toasts.ts';
export type { ToastKind } from './system/Toasts.ts';
export { RecordingUi } from './system/RecordingUi.ts';
export type { RecordPhase, RecordRequest, RecordPhaseListener } from './system/RecordingUi.ts';

export { createHandVisual, HAND_BONES } from './hands/HandVisual.ts';
export type { HandVisual, HandVisualOptions } from './hands/HandVisual.ts';

export { DEFAULT_THEME, SYSTEM_STYLE, createTheme } from './theme.ts';
