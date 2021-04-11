/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import {
  HitDetail,
  IModelApp,
  NotifyMessageDetails,
  OutputMessagePriority,
  Pixel,
  ScreenViewport,
  ViewRect,
  ViewState3d,
} from "@bentley/imodeljs-frontend";
import { Easing } from "@bentley/imodeljs-common";
import { Angle, CurveChainWithDistanceIndex, Point2d, Point3d, Vector3d, XY } from "@bentley/geometry-core";
import { CustomRpcInterface, CustomRpcUtilities } from "../../../common/CustomRpcInterface";
import { DriveToolConfig } from "./DriveToolConfig";
import { DistanceDisplayDecoration } from "./DistanceDisplayDecoration";
import { DistanceUtils } from "./DistanceUtils";
import { DetectionZoneDecoration } from "./DetectionZoneDecoration";
import { Point } from "@svgdotjs/svg.js";

export class DriveToolManager {

  /** Viewport used by the tool */
  private _viewport?: ScreenViewport;
  /** View state used by the tool */
  public _view?: ViewState3d;

  /** Curve to follow when enabling movement */
  private _selectedCurve?: CurveChainWithDistanceIndex;

  /** Vector indicating what direction the camera should be looking at */
  private _cameraLookAt?: Vector3d;
  /** Camera field of view */
  private _fov = DriveToolConfig.fovDefault;

  /** Indicates wether movement is currently enabled */
  private _moving = false;
  /** Current movement progress along the selected curve from 0 to 1 */
  private _progress = 0;
  /** Current position on the curve */
  private _positionOnCurve?: Point3d;
  /** Camera offset on the z axis from the current position on the selected curve */
  private _height = DriveToolConfig.heightDefault;
  /** Camera offset perpendicular to the view direction from the current position on the selected curve */
  private _lateralOffset = DriveToolConfig.lateralOffsetDefault;
  /** Speed of the movement along the selected curve in unit/s */
  private _speed = DriveToolConfig.speedDefault;

  /** Time between each calculation of the next position to move to along the curve */
  private _intervalTime = DriveToolConfig.intervalTime;
  /** Id of the current movement interval */
  private _intervalId?: NodeJS.Timeout;

  /** Indicates if target should be render */
  private _target = false;
  /** Indicates if simulation should stop when the target is no longer visible */
  private _autoStop = false;
  private _targetDistance = DriveToolConfig.targetDistance;
  /** Id of the target */
  private _targetId?: string;

  constructor(private _distanceDisplayDecoration: DistanceDisplayDecoration, private _detectionZoneDecoration: DetectionZoneDecoration) {
  }

  public get target(): boolean {
    return this._target;
  }

  public get targetId(): string | undefined {
    return this._targetId;
  }

  public set targetId(id: string | undefined) {
    this._targetId = id;
  }

  public get distanceDisplayDecoration(): DistanceDisplayDecoration {
    return this._distanceDisplayDecoration;
  }

  public get detectionZoneDecoration(): DetectionZoneDecoration {
    return this._detectionZoneDecoration;
  }

  public get progress(): number {
    return this._progress;
  }

  public set progress(value: number) {
    value = value > 0 ? value : 0;
    value = value < 1 ? value : 1;
    this._progress = value;
    this.updateProgress();
  }

  public get speed(): number {
    return this._speed;
  }

  public set speed(value: number) {
    value = value <= DriveToolConfig.speedMax ? value : DriveToolConfig.speedMax;
    value = value >= DriveToolConfig.speedMin ? value : DriveToolConfig.speedMin;
    this._speed = value;
  }

  public get fov(): number {
    return this._fov;
  }

  public set fov(value: number) {
    value = value <= DriveToolConfig.fovMax ? value : DriveToolConfig.fovMax;
    value = value >= DriveToolConfig.fovMin ? value : DriveToolConfig.fovMin;
    this._fov = value;
    this.updateCamera();
  }

  public get height() {
    return this._height;
  }

  public set height(value: number) {
    value = value <= DriveToolConfig.heightMax ? value : DriveToolConfig.heightMax;
    value = value >= DriveToolConfig.heightMin ? value : DriveToolConfig.heightMin;
    this._height = value;
    this.updateCamera();
  }

  public get lateralOffset() {
    return this._lateralOffset;
  }

  public set lateralOffset(value: number) {
    value = value <= DriveToolConfig.lateralOffsetMax ? value : DriveToolConfig.lateralOffsetMax;
    value = value >= DriveToolConfig.lateralOffsetMin ? value : DriveToolConfig.lateralOffsetMin;
    this._lateralOffset = value;
    this.updateCamera();
  }

  public get targetDistance() {
    return this._targetDistance;
  }

  public set targetDistance(value: number) {
    this._targetDistance = value;
  }

  public getPointsShape(): Point3d[] {
    if (!this._selectedCurve || !this._positionOnCurve)
      return [new Point3d()];

    const fraction = this._targetDistance / this._selectedCurve?.curveLength();
    const position = this._selectedCurve?.fractionToPoint(this._progress + fraction);

    if (!position)
      return [new Point3d()];

    const direction = position.minus(this._positionOnCurve);
    const vectorDirection = Vector3d.createFrom(direction).normalize();

    if (!vectorDirection)
      return [new Point3d()];

    return this.drawOctagonPoints(vectorDirection, position);
  }

  private drawOctagonPoints(vectorDirection: Vector3d, position: Point3d) {
    const size = DriveToolConfig.targetHeight;

    const vectorUp = new Vector3d(0, 0, 1);
    const vectorLeft = vectorUp.crossProduct(vectorDirection);
    const vectorRight = vectorLeft.scale(-1);

    const pos1 = position.plus(vectorLeft.scale(size / 4));
    const pos2 = position.plus(vectorLeft.scale(size / 2)).plus(vectorUp.scale(size / 4));
    const pos3 = pos2.plus(vectorUp.scale(size / 2));
    const pos4 = pos1.plus(vectorUp.scale(size));
    const pos8 = position.plus(vectorRight.scale(size / 4));
    const pos7 = position.plus(vectorRight.scale(size / 2)).plus(vectorUp.scale(size / 4));
    const pos6 = pos7.plus(vectorUp.scale(size / 2));
    const pos5 = pos8.plus(vectorUp.scale(size));

    return [pos1, pos2, pos3, pos4, pos5, pos6, pos7, pos8];
  }

  /**
   *  Sets the current viewport and view state. If an element is selected, sets it as selected curve.
   */
  public async init(): Promise<void> {
    this._viewport = IModelApp.viewManager.selectedView;
    if (undefined === this._viewport)
      return;

    const view = this._viewport.view;
    if (!view.is3d() || !view.allow3dManipulations())
      return;

    this._view = view;

    this.setDetectZonePoints();

    if (view.iModel.selectionSet.size === 1) {
      const selectedElementId = view.iModel.selectionSet.elements.values().next().value;
      await this.setSelectedCurve(selectedElementId);
    }
  }

  /**
   * Starts the movement along the selected curve
   */
  public launch(): void {
    if (this._selectedCurve && !this._moving) {
      this._moving = true;
      this.step();
      this._intervalId = setInterval(() => {
        this.step();
        if (this._autoStop)
          this.checkIfTargetVisible();
      }, this._intervalTime * 1000);
    }
  }

  public setDetectZonePoints(): void {
    const topLeft = this.topLeftDetectionZone();
    if (topLeft) {
      this._detectionZoneDecoration.setRectangle(topLeft.x, topLeft.y, DriveToolConfig.detectionRectangleWidth, DriveToolConfig.detectionRectangleHeight)
    }
  }

  public checkIfTargetVisible(): void {
    if (this.targetId && this._viewport) {

      const topLeft = this.topLeftDetectionZone();
      const bottomRight = this.bottomRightDetectionZone();

      if (topLeft && bottomRight) {

        const rectangle = new ViewRect();
        rectangle.initFromPoints(topLeft, bottomRight);

        this._viewport?.readPixels(rectangle, Pixel.Selector.All, (pixels) => {
          let hit = false;
          for (let y = topLeft.y; y <= bottomRight.y && !hit; y++) {
            for (let x = topLeft.x; x <= bottomRight.x && !hit; x++) {
              if (pixels?.getPixel(x, y)?.elementId === this._targetId) {
                hit = true;
                console.warn("hit");
              }
            }
          }
          if (!hit) {
            console.warn("no hit");
            this.stop();
          }
        }, true);
      }
    }
  }

  private topLeftDetectionZone(): Point2d | undefined {
    if (!this._viewport)
      return undefined;

    const clientWidth = this._viewport.canvas.clientWidth;
    const clientHeight = this._viewport.canvas.clientHeight;
    const clientCenter = new Point2d(Math.floor(clientWidth / 2), Math.floor(clientHeight / 2));

    const halfSide = new Point2d(DriveToolConfig.detectionRectangleWidth / 2, DriveToolConfig.detectionRectangleHeight / 2);
    return clientCenter.minus(halfSide);
  }

  private bottomRightDetectionZone(): Point2d | undefined {
    if (!this._viewport)
      return undefined;

    const clientWidth = this._viewport.canvas.clientWidth;
    const clientHeight = this._viewport.canvas.clientHeight;
    const clientCenter = new Point2d(Math.floor(clientWidth / 2), Math.floor(clientHeight / 2));

    const halfSide = new Point2d(DriveToolConfig.detectionRectangleWidth / 2, DriveToolConfig.detectionRectangleHeight / 2);
    return clientCenter.plus(halfSide);
  }

  public toggleTarget(): void {
    this._target = !this._target;
    this._autoStop = !this._autoStop;
  }

  /**
   * Stops the movement along the selected curve
   */
  public stop(): void {
    if (this._intervalId) {
      this._moving = false;
      clearTimeout(this._intervalId);
      this._intervalId = undefined;
    }
  }

  /**
   * Toggles the movement along the seelcted curve
   */
  public toggleMovement(): void {
    this._moving ? this.stop() : this.launch();
  }

  /**
   * Tries to retrieve a curve from the given element id then sets it as the selected curve
   * @param elementId - Element from which to retrieve the curve
   */
  public async setSelectedCurve(elementId: string): Promise<void> {
    if (this._selectedCurve || !this._view)
      return;

    const pathResponse = await CustomRpcInterface.getClient().queryPath(this._view.iModel.getRpcProps(), elementId);
    const path = CustomRpcUtilities.parsePath(pathResponse);

    if (path) {
      this._selectedCurve = CurveChainWithDistanceIndex.createCapture(path);
      this.updateProgress();
    } else {
      const message = new NotifyMessageDetails(OutputMessagePriority.Warning, "Can't find path for selected element");
      IModelApp.notifications.outputMessage(message);
    }

    this._view.iModel.selectionSet.emptyAll();
  }

  /**
   * Reverse the curve to change the direction of the movement along the curve
   */
  public reverseCurve(): void {
    this._progress = 1 - this._progress;
    this._selectedCurve?.reverseInPlace();
    this.updateProgress();
  }

  /**
   * Updates distance mouse decoration
   * @param mousePosition - Current mouse position in view coordinates
   * @param hit - Current hit at mouse position
   */
  public updateMouseDecoration(mousePosition: Point3d, hit: HitDetail | undefined): void {
    this.distanceDisplayDecoration.mousePosition = mousePosition;
    if (this._positionOnCurve && hit) {
      this.distanceDisplayDecoration.distance = DistanceUtils.calculateDistance(this._positionOnCurve, hit.getPoint());
    } else {
      this.distanceDisplayDecoration.distance = 0;
    }
  }

  /**
   * Makes an increment of the movement along the curve
   * @private
   */
  private step(): void {
    if (this._selectedCurve) {
      const fraction = (this._speed * this._intervalTime) / this._selectedCurve.curveLength();
      this.progress += fraction;
    }
  }

  /**
   * Sets the current position on curve and camera direction based on current progress.
   * @private
   */
  private updateProgress(): void {
    if (this._selectedCurve) {
      this._cameraLookAt = this._selectedCurve?.fractionToPointAndUnitTangent(this._progress).getDirectionRef();
      this._positionOnCurve = this._selectedCurve?.fractionToPoint(this._progress);
      this.updateCamera();
    }
  }

  /**
   * Sets the camera position based on the position on the curve and the offsets.
   * Syncs the camera properties with the viewport.
   * @private
   */
  private updateCamera(): void {
    if (!this._viewport || !this._view)
      return;

    if (this._positionOnCurve && this._cameraLookAt) {
      const eyePoint = Point3d.createFrom(this._positionOnCurve);
      eyePoint.addInPlace(Vector3d.unitZ(this._height));
      eyePoint.addInPlace(Vector3d.unitZ().crossProduct(this._cameraLookAt).scale(-this._lateralOffset));
      this._view.lookAtUsingLensAngle(eyePoint, eyePoint.plus(this._cameraLookAt), new Vector3d(0, 0, 1), Angle.createDegrees(this._fov));
    }

    this._viewport.synchWithView({
      animateFrustumChange: true,
      animationTime: this._intervalTime * 1000,
      easingFunction: Easing.Linear.None,
    });
  }
}
