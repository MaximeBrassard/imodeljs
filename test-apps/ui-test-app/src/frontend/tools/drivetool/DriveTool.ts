/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import {
  BeButtonEvent,
  BeWheelEvent,
  DecorateContext,
  EventHandled,
  GraphicType,
  IModelApp,
  LocateResponse,
  PrimitiveTool,
  ToolAssistance,
  ToolAssistanceImage,
} from "@bentley/imodeljs-frontend";
import { DriveToolManager } from "./DriveToolManager";
import { DialogItem, DialogPropertySyncItem } from "@bentley/ui-abstract";
import { ToolItemDef } from "@bentley/ui-framework";
import { DriveToolProperties } from "./DriveToolProperties";
import { ColorDef } from "@bentley/imodeljs-common";
import { DistanceDecoration } from "./DistanceDecoration";
import { DriveToolInputManager } from "./DriveToolInputManager";

export class DriveTool extends PrimitiveTool {

  public static toolId = "DriveTool";
  public static iconSpec = "icon-airplane";

  private _manager = new DriveToolManager(new DistanceDecoration(), this);
  private _inputManager = new DriveToolInputManager(this._manager);
  private _lastLoggedEvent?: BeButtonEvent;

  public static get driveToolItemDef() {
    return new ToolItemDef({
      toolId: DriveTool.toolId,
      iconSpec: DriveTool.iconSpec,
      label: () => "Drive Tool",
      description: () => "Drive Tool Desc",
      execute: () => {
        IModelApp.tools.run(DriveTool.toolId);
      },
    });
  }

  public get manager() {
    return this._manager;
  }

  public get lastLoggedEvent(): BeButtonEvent | undefined {
    return this._lastLoggedEvent;
  }

  /**
   * Initializes tool
   */
  public onPostInstall() {
    super.onPostInstall();
    IModelApp.accuSnap.enableSnap(true);
    void this._manager.init().then();
    this.setupAndPromptForNextAction();
  }

  protected setupAndPromptForNextAction(): void {
    this.provideToolAssistance();
  }

  public onUnsuspend(): void {
    this.provideToolAssistance();
  }

  /**
   * Provides the tool instructions.
   * @protected
   */
  protected provideToolAssistance(): void {
    const mainInstruction = ToolAssistance.createInstruction(ToolAssistanceImage.CursorClick, "Select an object");

    const toggleMovementInstruction = ToolAssistance.createKeyboardInstruction(ToolAssistance.createKeyboardInfo(["T"]), "Toggle movement");
    const reverseInstruction = ToolAssistance.createKeyboardInstruction(ToolAssistance.createKeyboardInfo(["R"]), "Reverse direction");
    const speedInstruction = ToolAssistance.createKeyboardInstruction(ToolAssistance.createKeyboardInfo(["W", "S"]), "Adjust speed");
    const heightInstruction = ToolAssistance.createKeyboardInstruction(ToolAssistance.createKeyboardInfo(["Q", "E"]), "Adjust height");
    const lateralOffsetInstruction = ToolAssistance.createKeyboardInstruction(ToolAssistance.createKeyboardInfo(["A", "D"]), "Adjust lateral offset");
    const toggleTargetInstruction = ToolAssistance.createKeyboardInstruction(ToolAssistance.createKeyboardInfo(["L"]), "Toggle target");
    const fovInstruction = ToolAssistance.createInstruction(ToolAssistanceImage.MouseWheel, "Adjust Fov");

    const section1 = ToolAssistance.createSection([toggleMovementInstruction, reverseInstruction, speedInstruction, lateralOffsetInstruction, heightInstruction, fovInstruction, toggleTargetInstruction]);
    const instructions = ToolAssistance.createInstructions(mainInstruction, [section1]);
    IModelApp.notifications.setToolAssistance(instructions);
  }

  /**
   * Specifies that the tool does not require a non-read only model
   */
  public requireWriteableTarget(): boolean {
    return false;
  }

  /**
   * Supplies properties to the UI
   */
  public supplyToolSettingsProperties(): DialogItem[] | undefined {
    const toolSettings = new Array<DialogItem>();
    toolSettings.push({ value: { value: this._manager.height }, property: DriveToolProperties.height, editorPosition: { rowPriority: 1, columnIndex: 1 } });
    toolSettings.push({ value: { value: this._manager.lateralOffset }, property: DriveToolProperties.lateralOffset, editorPosition: { rowPriority: 2, columnIndex: 1 } });
    toolSettings.push({ value: { value: this._manager.speed * 3.6 }, property: DriveToolProperties.speed, editorPosition: { rowPriority: 3, columnIndex: 1 } });
    toolSettings.push({ value: { value: this._manager.fov }, property: DriveToolProperties.fov, editorPosition: { rowPriority: 4, columnIndex: 1 } });
    toolSettings.push({ value: { value: this._manager.progress }, property: DriveToolProperties.progress, editorPosition: { rowPriority: 5, columnIndex: 1 } });
    toolSettings.push({ value: { value: this._manager.targetDistance }, property: DriveToolProperties.targetDistance, editorPosition: { rowPriority: 6, columnIndex: 1 } });
    return toolSettings;
  }

  /**
   * Handles properties values changed from the UI
   * @param updatedValue
   */
  public applyToolSettingPropertyChange(updatedValue: DialogPropertySyncItem): boolean {
    const value = updatedValue.value.value as number;
    switch (updatedValue.propertyName) {
      case DriveToolProperties.height.name: this._manager.height = value; break;
      case DriveToolProperties.lateralOffset.name: this._manager.lateralOffset = value; break;
      case DriveToolProperties.speed.name: this._manager.speed = value / 3.6; break;
      case DriveToolProperties.fov.name: this._manager.fov = value; break;
      case DriveToolProperties.progress.name: this._manager.progress = value / 100; break;
      case DriveToolProperties.targetDistance.name: this._manager.targetDistance = value; break;
    }
    this.syncAllSettings();
    this._manager.updateCamera();
    return true;
  }

  /**
   * Syncs Progress with the UI when values have changed
   * @public
   */
  public syncProgress() {
    this.syncToolSettingsProperties([
      { value: { value: (this._manager.progress * 100) }, propertyName: DriveToolProperties.progress.name },
    ]);
  }

  /**
   * Syncs properties with the UI when values have changed
   * @private
   */
  private syncAllSettings() {
    this.syncToolSettingsProperties([
      { value: { value: this._manager.height }, propertyName: DriveToolProperties.height.name },
      { value: { value: this._manager.lateralOffset }, propertyName: DriveToolProperties.lateralOffset.name },
      { value: { value: this._manager.speed * 3.6 }, propertyName: DriveToolProperties.speed.name },
      { value: { value: this._manager.fov }, propertyName: DriveToolProperties.fov.name },
      { value: { value: (this._manager.progress * 100) }, propertyName: DriveToolProperties.progress.name },
      { value: { value: this._manager.targetDistance }, propertyName: DriveToolProperties.targetDistance.name },
    ]);
  }

  /**
   * Setups tool decorations
   * @param context decorate context
   */
  public decorate(context: DecorateContext): void {
    context.addCanvasDecoration(this._manager.distanceDecoration);

    if (undefined === this._manager.targetId)
      this._manager.targetId = context.viewport.iModel.transientIds.next;

    if (this._manager.targetEnabled) {
      const builder = context.createGraphicBuilder(GraphicType.WorldDecoration, undefined, this.manager.targetId);
      builder.setSymbology(context.viewport.getContrastToBackgroundColor(), ColorDef.red.withTransparency(128), 5);
      builder.addShape(this._manager.getTargetPoints());

      context.addDecorationFromBuilder(builder);

    }
  }

  /**
   * Tries to set the clicked element as the selected curve
   * @param ev mouse button down event
   */
  public async onDataButtonDown(ev: BeButtonEvent): Promise<EventHandled> {
    const hit = await IModelApp.locateManager.doLocate(new LocateResponse(), true, ev.point, ev.viewport, ev.inputSource);
    if (hit?.sourceId) {
      await this._manager.setSelectedCurve(hit.sourceId);
    }
    IModelApp.accuSnap.enableSnap(false);
    return EventHandled.Yes;
  }


  /**
   * Delegates the event to the input manager
   * @param wentDown
   * @param keyEvent
   */
  public async onKeyTransition(wentDown: boolean, keyEvent: KeyboardEvent): Promise<EventHandled> {
    this._inputManager.handleKeyTransition(wentDown, keyEvent.key, () => { this.syncAllSettings(); });
    return EventHandled.Yes;
  }

  /**
   * Delegates the event to the input manager
   * @param ev mouse wheel scroll event
   */
  public async onMouseWheel(ev: BeWheelEvent): Promise<EventHandled> {
    this._inputManager.handleMouseWheel(ev, () => { this.syncAllSettings(); });
    return EventHandled.Yes;
  }

  /**
   * Locates the element under the mouse then updates the mouse decoration.
   * @param ev mouse motion event
   */
  public async onMouseMotion(ev: BeButtonEvent): Promise<void> {
    this._manager.updateMouseDecorationWithPosition(ev.viewPoint, ev.viewport?.pickNearestVisibleGeometry(ev.point, 1))
    ev.viewport?.invalidateDecorations();
    this._lastLoggedEvent = ev.clone();
  }

  /**
   * Locates the element under the mouse using the last called event then updates the mouse decoration.
   */
  public async updateRectangleDecoration(): Promise<void> {
    if (this.lastLoggedEvent) {
      this.manager.updateMouseDecorationWithPosition(this.lastLoggedEvent.viewPoint, this._manager.viewport!.pickNearestVisibleGeometry(this._manager.viewport!.viewToWorld(this.lastLoggedEvent.viewPoint), 1))
      this.lastLoggedEvent.viewport?.invalidateDecorations();
    }
  }

  /**
   * Reinitializes the tool
   * @param _ev
   */
  public async onResetButtonUp(_ev: BeButtonEvent): Promise<EventHandled> {
    this.onReinitialize();
    return EventHandled.No;
  }

  /**
   * Stops tool movement when exiting the tool
   */
  public onCleanup(): void {
    this._manager.stop();
  }

  /**
   * Handles tool restart
   */
  public onRestartTool(): void {
    const tool = new DriveTool();
    if (!tool.run())
      this.exitTool();
  }
}
