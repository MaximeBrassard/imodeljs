/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import {
  IModelApp,
  NotifyMessageDetails,
  OutputMessagePriority,
  ScreenViewport,
  ViewState3d,
} from "@bentley/imodeljs-frontend";
import { Easing } from "@bentley/imodeljs-common";
import { Angle, CurveChainWithDistanceIndex, Point3d, Vector3d } from "@bentley/geometry-core";
import { CustomRpcInterface, CustomRpcUtilities } from "../../../common/CustomRpcInterface";
import { DriveToolConfig } from "./DriveToolConfig";
import { DistanceDecoration } from "./DistanceDecoration";
import { ShapeUtils } from './ShapeUtils';
import { DriveTool } from './DriveTool'

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

  /** Indicates if target should render */
  private _targetEnabled = false;
  /** Indicates if simulation should stop when the target is no longer visible */
  private _autoStopEnabled = false;
  /** Distance of target from current position on curve */
  private _targetDistance = DriveToolConfig.targetDistanceDefault;
  /** Id of the target */
  private _targetId?: string;
  /** World3D position of the target */
  private _targetPosition?: Point3d;

  constructor(private _distanceDecoration: DistanceDecoration,
    private _linkedDriveTool: DriveTool) {
  }

  public get targetEnabled(): boolean {
    return this._targetEnabled;
  }

  public get targetId(): string | undefined {
    return this._targetId;
  }

  public set targetId(id: string | undefined) {
    this._targetId = id;
  }

  public get distanceDecoration(): DistanceDecoration {
    return this._distanceDecoration;
  }

  public get progress(): number {
    return this._progress;
  }

  public get viewport(): ScreenViewport | undefined {
    return this._viewport;
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
        if (this._autoStopEnabled) {
          if (!this.isTargetVisible()) {
            this.stop();
            const message = new NotifyMessageDetails(OutputMessagePriority.Warning, "Target not visible");
            IModelApp.notifications.outputMessage(message);
          } else {
            this.step();
          }
        }
      }, this._intervalTime * 1000);
    }
  }

  /**
   * Check the visible depth at the target location and compares it to the actual target distance.
   * @returns a boolean of wether the target is visible by the camera or not
   */
  public isTargetVisible(): boolean {
    let hit = false;
    if (this._viewport && this._targetPosition) {
      const targetedFromView = this.viewport!.pickNearestVisibleGeometry(this._targetPosition, 1)
      if (targetedFromView) {
        if (this._viewport?.view.getCenter().distance(this._targetPosition) - (0.05 * this._viewport?.view.getCenter().distance(this._targetPosition)) < this._viewport?.view.getCenter().distance(targetedFromView)) {
          hit = true;
        }
      } else {
        hit = true;
      }
    }
    return hit;
  }

  /**
   * Calculate the position and the orientation with distance from position and of the target
   * @returns array of Point3d representing target shape
   */
  public getTargetPoints(): Point3d[] {
    if (!this._positionOnCurve)
      return [new Point3d()];

    let position = this.getPositionAtDistance(this._targetDistance);

    if (!position)
      return [new Point3d()];

    const direction = position.minus(this._positionOnCurve);
    const vectorDirection = Vector3d.createFrom(direction).normalize();
    position.z += DriveToolConfig.targetVerticalOffset;
    this._targetPosition = position;
    const targetSideStepDirection = vectorDirection?.unitPerpendicularXY();
    position = position.plus(targetSideStepDirection!.scale(- this._lateralOffset));

    if (!vectorDirection)
      return [new Point3d()];

    return ShapeUtils.getOctagonPoints(position, vectorDirection, DriveToolConfig.targetHeight);
  }

  /**
   * Toggles display of the target
   */
  public toggleTarget(): void {
    this._targetEnabled = !this._targetEnabled;
    this._autoStopEnabled = !this._autoStopEnabled;
    this.updateCamera();
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
   * Toggles the movement along the selected curve
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
   * @param pointLocation - Point of first surface encountered
   */
  public updateMouseDecorationWithPosition(mousePosition: Point3d, pointLocation: Point3d | undefined) {
    this.distanceDecoration.mousePosition.setFrom(mousePosition);
    if (this._positionOnCurve && pointLocation && this._viewport) {
      const current3DPosition = this._viewport?.view.getCenter();
      if (current3DPosition.distance(pointLocation)) {
        this.distanceDecoration.distance = current3DPosition.distance(pointLocation);
      }
    } else {
      this.distanceDecoration.distance = 0;
    }
  }

  /**
   * Updates the current progress
   * @private
   */
  private updateProgressCounter(): void {
    this._linkedDriveTool.syncProgress();
    if (this._progress >= 1) {
      this.toggleMovement();
    }
  }

  /**
   * Makes an increment of the movement along the curve
   * @private
   */
  private step(): void {
    if (this._selectedCurve) {
      this._linkedDriveTool.updateRectangleDecoration();
      const fraction = (this._speed * this._intervalTime) / this._selectedCurve.curveLength();
      this.progress += fraction;
      this.updateProgressCounter();
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
   * @public
   */
  public updateCamera(): void {
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

  /**
   * Get point on curve at distance from current position on curve
   * @param distance
   * @private
   */
  private getPositionAtDistance(distance: number): Point3d | undefined {
    if (!this._selectedCurve)
      return undefined;

    const fraction = distance / this._selectedCurve.curveLength();
    return this._selectedCurve.fractionToPoint(this._progress + fraction);
  }
}
