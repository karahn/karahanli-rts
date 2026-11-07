/**
 * Karahanlı RTS — Kılıçlı Asker Birim Sınıfı (Warrior)
 *
 * Tarihî Karahanlı dönemine uygun tek elli kılıç, yuvarlak kalkan ve orta ağırlıkta
 * Türk zırhı (zincir + deri lamel) taşıyan savaşçı birimi. Köylü ile aynı ölçek,
 * seçim, hareket ve garnizon sistemine entegre; odun toplamaz ve savaş sistemi
 * henüz aktif olmadığı için dürüstçe isCombatSystemActive=false döner.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';
import {
  CarriedResourceSummary,
  GarrisonableUnit,
  UnitCategory,
  UnitNutritionState,
} from './unitTypes';

export const WARRIOR_TEXTURE_KEY = 'warrior_karahanli';
export const WARRIOR_ASSET_PATH = 'assets/sprites/warrior_karahanli.png';
export const WARRIOR_FRAME_WIDTH = 160;
export const WARRIOR_FRAME_HEIGHT = 152;

export const WARRIOR_DEFAULT_MAX_HP = 80;
export const WARRIOR_DEFAULT_ATTACK = 12;
export const WARRIOR_DEFAULT_DEFENSE = 2;
export const WARRIOR_DEFAULT_MAX_SATIETY = 100;

const ANIM_WALK_FRONT = 'karahanli_warrior_walk_front';
const ANIM_WALK_BACK = 'karahanli_warrior_walk_back';
const ANIM_IDLE_FRONT = 'karahanli_warrior_idle_front';
const ANIM_IDLE_BACK = 'karahanli_warrior_idle_back';

const ORIGIN_X = 80 / WARRIOR_FRAME_WIDTH;
const ORIGIN_Y = 132 / WARRIOR_FRAME_HEIGHT;

const DEFAULT_SCALE = 0.38;
const DEFAULT_MOVE_SPEED = 2.1;

const BASE_WALK_FPS = 8.5;
const IDLE_FPS = 2.5;

export type WarriorState =
  | 'idle'
  | 'walking'
  | 'entering_building'
  | 'garrisoned';

export interface WarriorConfig {
  id: string;
  displayName?: string;
  col: number;
  row: number;
  moveSpeed?: number;
  scale?: number;
  maxHp?: number;
  initialHp?: number;
  attackDamage?: number;
  defenseArmor?: number;
  initialFacingBack?: boolean;
  initialFacingLeft?: boolean;
}

export interface WarriorWorldContext {
  canEnterBuildingNow: (warrior: Warrior, buildingId: string) => boolean;
  completeEnterBuilding: (warrior: Warrior, buildingId: string) => boolean;
  isFoodEconomyActive?: () => boolean;
}

export class Warrior implements GarrisonableUnit {
  public readonly id: string;
  public readonly displayName: string;
  public readonly unitCategory: UnitCategory = 'warrior';
  public readonly unitTypeLabel = 'Karahanlı Kılıçlı Askeri';

  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly selectionRing: Phaser.GameObjects.Graphics;
  private readonly unitScale: number;

  private readonly maxHp: number;
  private hp: number;
  private readonly attackDamage: number;
  private readonly defenseArmor: number;
  private readonly maxSatiety = WARRIOR_DEFAULT_MAX_SATIETY;
  private satiety = WARRIOR_DEFAULT_MAX_SATIETY;
  private foodEconomyActive = false;

  private gridPos: GridCoord;
  private worldPos: { x: number; y: number };
  private moveSpeed: number;
  private selected = false;
  private state: WarriorState = 'idle';
  private targetGridPos: GridCoord | null = null;
  private pathQueue: GridCoord[] = [];
  private facingBack: boolean;
  private facingLeft: boolean;

  private pendingBuildingId: string | null = null;
  private pendingBuildingName: string | null = null;
  private garrisonBuildingId: string | null = null;
  private garrisonBuildingName: string | null = null;
  private commanderId: string | null = null;
  private readonly attachedSubordinateIds = new Set<string>();

  private nearGoalCrowdedMs = 0;
  private wasSeparatedLastStep = false;

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid, config: WarriorConfig) {
    this.id = config.id;
    this.displayName = config.displayName ?? config.id;
    this.scene = scene;
    this.isoGrid = isoGrid;
    this.gridPos = { col: config.col, row: config.row };
    this.worldPos = isoGrid.tileToWorld(config.col, config.row);
    this.moveSpeed = config.moveSpeed ?? DEFAULT_MOVE_SPEED;
    this.unitScale = config.scale ?? DEFAULT_SCALE;
    this.maxHp = config.maxHp ?? WARRIOR_DEFAULT_MAX_HP;
    this.hp = Phaser.Math.Clamp(config.initialHp ?? this.maxHp, 1, this.maxHp);
    this.attackDamage = config.attackDamage ?? WARRIOR_DEFAULT_ATTACK;
    this.defenseArmor = config.defenseArmor ?? WARRIOR_DEFAULT_DEFENSE;
    this.facingBack = config.initialFacingBack ?? false;
    this.facingLeft = config.initialFacingLeft ?? false;

    this.selectionRing = scene.add.graphics();
    this.drawSelectionRing();
    this.selectionRing.setVisible(false);

    this.sprite = scene.add.sprite(
      this.worldPos.x,
      this.worldPos.y,
      WARRIOR_TEXTURE_KEY,
      this.facingBack ? 8 : 0
    );
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(this.unitScale);
    this.sprite.setFlipX(this.facingLeft);

    this.syncVisualTransform();
  }

  public static preload(scene: Phaser.Scene): void {
    scene.load.spritesheet(WARRIOR_TEXTURE_KEY, WARRIOR_ASSET_PATH, {
      frameWidth: WARRIOR_FRAME_WIDTH,
      frameHeight: WARRIOR_FRAME_HEIGHT,
    });
  }

  public static ensureAnimations(scene: Phaser.Scene): void {
    if (!scene.anims.exists(ANIM_WALK_FRONT)) {
      scene.anims.create({
        key: ANIM_WALK_FRONT,
        frames: scene.anims.generateFrameNumbers(WARRIOR_TEXTURE_KEY, {
          frames: [0, 1, 2, 3],
        }),
        frameRate: BASE_WALK_FPS,
        repeat: -1,
      });
    }
    if (!scene.anims.exists(ANIM_WALK_BACK)) {
      scene.anims.create({
        key: ANIM_WALK_BACK,
        frames: scene.anims.generateFrameNumbers(WARRIOR_TEXTURE_KEY, {
          frames: [8, 9, 10, 11],
        }),
        frameRate: BASE_WALK_FPS,
        repeat: -1,
      });
    }
    if (!scene.anims.exists(ANIM_IDLE_FRONT)) {
      scene.anims.create({
        key: ANIM_IDLE_FRONT,
        frames: scene.anims.generateFrameNumbers(WARRIOR_TEXTURE_KEY, {
          frames: [4, 5, 6, 7],
        }),
        frameRate: IDLE_FPS,
        repeat: -1,
      });
    }
    if (!scene.anims.exists(ANIM_IDLE_BACK)) {
      scene.anims.create({
        key: ANIM_IDLE_BACK,
        frames: scene.anims.generateFrameNumbers(WARRIOR_TEXTURE_KEY, {
          frames: [12, 13, 14, 15],
        }),
        frameRate: IDLE_FPS,
        repeat: -1,
      });
    }
  }

  // --- GarrisonableUnit: Can / Savaş / Açlık ---

  public getHp(): number {
    return this.hp;
  }
  public getMaxHp(): number {
    return this.maxHp;
  }
  public heal(amount: number): number {
    if (amount <= 0 || this.hp >= this.maxHp) return 0;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - before;
  }
  public takeDamage(amount: number): number {
    if (amount <= 0) return 0;
    const reduced = Math.max(1, amount - this.defenseArmor);
    const before = this.hp;
    this.hp = Math.max(0, this.hp - reduced);
    return before - this.hp;
  }
  public getAttackDamage(): number {
    return this.attackDamage;
  }
  public getDefenseArmor(): number {
    return this.defenseArmor;
  }
  public isCombatSystemActive(): boolean {
    return false;
  }
  public getNutritionState(): UnitNutritionState {
    return {
      satiety: this.satiety,
      maxSatiety: this.maxSatiety,
      foodEconomyActive: this.foodEconomyActive,
      statusText: this.foodEconomyActive
        ? `Tok (%${Math.round((this.satiety / this.maxSatiety) * 100)})`
        : `Doygun ${this.satiety}/${this.maxSatiety} (Erzak sistemi yakında)`,
    };
  }
  public restoreSatiety(amount: number): number {
    if (amount <= 0 || this.satiety >= this.maxSatiety) return 0;
    const before = this.satiety;
    this.satiety = Math.min(this.maxSatiety, this.satiety + amount);
    return this.satiety - before;
  }
  public getCarriedResourceSummary(): CarriedResourceSummary {
    return {
      resourceType: null,
      resourceLabel: 'Odun',
      amount: 0,
      maxCapacity: 0,
    };
  }
  public getTaskDescription(
    _resolveTreeLabel?: (treeId: string) => string | null
  ): string {
    if (this.state === 'garrisoned') {
      return `Binada (${this.garrisonBuildingName ?? 'Bina'})`;
    }
    if (this.state === 'entering_building') {
      return `Binaya Giriyor (${this.pendingBuildingName ?? 'Bina'})`;
    }
    if (this.state === 'walking') {
      return 'Hareket Ediyor';
    }
    return 'Bekliyor';
  }
  public getCommanderId(): string | null {
    return this.commanderId;
  }
  public setCommanderId(commanderId: string | null): void {
    this.commanderId = commanderId;
  }
  public getAttachedUnitIds(): readonly string[] {
    return Array.from(this.attachedSubordinateIds);
  }
  public attachSubordinateUnit(unitId: string): void {
    this.attachedSubordinateIds.add(unitId);
  }
  public detachSubordinateUnit(unitId: string): void {
    this.attachedSubordinateIds.delete(unitId);
  }
  public isGarrisoned(): boolean {
    return this.state === 'garrisoned';
  }
  public getGarrisonBuildingId(): string | null {
    return this.garrisonBuildingId;
  }
  public onEnterGarrison(buildingId: string, buildingName: string): void {
    this.garrisonBuildingId = buildingId;
    this.garrisonBuildingName = buildingName;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.pathQueue = [];
    this.targetGridPos = null;
    this.state = 'garrisoned';
    this.sprite.setVisible(false);
    this.selectionRing.setVisible(false);
    this.sprite.anims.stop();
  }
  public onExitGarrison(exitSpot: GridCoord): void {
    this.garrisonBuildingId = null;
    this.garrisonBuildingName = null;
    this.gridPos = { col: exitSpot.col, row: exitSpot.row };
    this.state = 'idle';
    this.sprite.setVisible(true);
    this.syncVisualTransform();
    this.enterIdlePose();
  }

  // --- Konum / Seçim / Hareket ---

  public getGridPosition(): GridCoord {
    return { col: this.gridPos.col, row: this.gridPos.row };
  }
  public getTargetPosition(): GridCoord | null {
    return this.targetGridPos ? { col: this.targetGridPos.col, row: this.targetGridPos.row } : null;
  }
  public getWorldPosition(): { x: number; y: number } {
    return { x: this.worldPos.x, y: this.worldPos.y };
  }
  public getCarriedWood(): number {
    return 0;
  }
  public getMaxWoodCapacity(): number {
    return 0;
  }
  public isCarryFull(): boolean {
    return false;
  }
  public getMoveSpeed(): number {
    return this.moveSpeed;
  }
  public setMoveSpeed(speedTilesPerSec: number): void {
    this.moveSpeed = Math.max(0.2, speedTilesPerSec);
    if (this.isMoving()) {
      this.sprite.anims.timeScale = this.moveSpeed / DEFAULT_MOVE_SPEED;
    }
  }
  public getState(): WarriorState {
    return this.state;
  }
  public isMoving(): boolean {
    return this.pathQueue.length > 0;
  }
  public isSelected(): boolean {
    return this.selected;
  }
  public setSelected(value: boolean): void {
    this.selected = value;
    if (this.isGarrisoned()) {
      this.selectionRing.setVisible(false);
      return;
    }
    this.selectionRing.setVisible(value);
  }

  public setMovePath(waypoints: GridCoord[]): void {
    if (this.isGarrisoned()) return;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.nearGoalCrowdedMs = 0;
    if (waypoints.length === 0) {
      this.stopMovement();
      return;
    }
    this.assignPathQueue(waypoints, 'walking');
  }

  public setEnterBuildingOrder(
    buildingId: string,
    buildingName: string,
    waypoints: GridCoord[],
    context: WarriorWorldContext
  ): void {
    if (this.isGarrisoned()) return;
    this.pendingBuildingId = buildingId;
    this.pendingBuildingName = buildingName;
    if (waypoints.length === 0) {
      if (context.canEnterBuildingNow(this, buildingId)) {
        context.completeEnterBuilding(this, buildingId);
      } else {
        this.stopMovement();
      }
      return;
    }
    this.assignPathQueue(waypoints, 'entering_building');
  }

  public stopMovement(): void {
    this.pathQueue = [];
    this.targetGridPos = null;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.nearGoalCrowdedMs = 0;
    this.enterIdlePose();
  }

  public update(deltaMs: number, context: WarriorWorldContext): void {
    if (this.state === 'garrisoned') return;
    if (this.state === 'walking' || this.state === 'entering_building') {
      this.updatePathMovement(deltaMs, context);
    }
    this.wasSeparatedLastStep = false;
  }

  public applySeparationOffset(
    dCol: number,
    dRow: number,
    isWalkablePos: (col: number, row: number) => boolean
  ): boolean {
    if (this.isGarrisoned()) return false;
    if (Math.abs(dCol) < 0.0001 && Math.abs(dRow) < 0.0001) return false;
    const fullCol = this.gridPos.col + dCol;
    const fullRow = this.gridPos.row + dRow;
    if (isWalkablePos(fullCol, fullRow)) {
      this.gridPos.col = fullCol;
      this.gridPos.row = fullRow;
      this.wasSeparatedLastStep = true;
      this.syncVisualTransform();
      return true;
    }
    if (Math.abs(dCol) > 0.0001 && isWalkablePos(fullCol, this.gridPos.row)) {
      this.gridPos.col = fullCol;
      this.wasSeparatedLastStep = true;
      this.syncVisualTransform();
      return true;
    }
    if (Math.abs(dRow) > 0.0001 && isWalkablePos(this.gridPos.col, fullRow)) {
      this.gridPos.row = fullRow;
      this.wasSeparatedLastStep = true;
      this.syncVisualTransform();
      return true;
    }
    return false;
  }

  public containsWorldPoint(worldX: number, worldY: number, isTouch = false): boolean {
    if (this.isGarrisoned()) return false;
    const visualHalfW = Math.round(18 * this.unitScale);
    const visualHeight = Math.round(92 * this.unitScale);
    const padX = isTouch ? 14 : 7;
    const padTop = isTouch ? 12 : 6;
    const padBottom = isTouch ? 10 : 6;
    return (
      worldX >= this.worldPos.x - (visualHalfW + padX) &&
      worldX <= this.worldPos.x + (visualHalfW + padX) &&
      worldY >= this.worldPos.y - (visualHeight + padTop) &&
      worldY <= this.worldPos.y + padBottom
    );
  }

  public intersectsWorldRect(minX: number, minY: number, maxX: number, maxY: number): boolean {
    if (this.isGarrisoned()) return false;
    const halfW = 16 * this.unitScale;
    const bodyHeight = 88 * this.unitScale;
    const unitLeft = this.worldPos.x - halfW;
    const unitRight = this.worldPos.x + halfW;
    const unitTop = this.worldPos.y - bodyHeight;
    const unitBottom = this.worldPos.y + 4;
    return unitRight >= minX && unitLeft <= maxX && unitBottom >= minY && unitTop <= maxY;
  }

  public distanceToBodyCenter(worldX: number, worldY: number): number {
    const bodyCenterY = this.worldPos.y - 46 * this.unitScale;
    return Math.hypot(worldX - this.worldPos.x, worldY - bodyCenterY);
  }

  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore([this.selectionRing, this.sprite]);
  }

  public syncVisualTransform(): void {
    this.worldPos = this.isoGrid.tileToWorld(this.gridPos.col, this.gridPos.row);
    const depth = this.isoGrid.getTileDepth(this.gridPos.col, this.gridPos.row);
    this.sprite.setPosition(this.worldPos.x, this.worldPos.y);
    this.sprite.setDepth(depth);
    this.selectionRing.setPosition(this.worldPos.x, this.worldPos.y);
    this.selectionRing.setDepth(depth - 0.05);
  }

  public destroy(): void {
    this.selectionRing.destroy();
    this.sprite.destroy();
  }

  private assignPathQueue(waypoints: GridCoord[], moveState: 'walking' | 'entering_building'): void {
    this.pathQueue = waypoints.map((pt) => ({ col: pt.col, row: pt.row }));
    this.targetGridPos = { col: waypoints[waypoints.length - 1].col, row: waypoints[waypoints.length - 1].row };
    this.nearGoalCrowdedMs = 0;
    this.state = moveState;
    this.updateWalkingFacing(waypoints[0]);
  }

  private enterIdlePose(): void {
    this.state = 'idle';
    this.sprite.anims.stop();
    this.sprite.anims.timeScale = 1;
    const idleKey = this.facingBack ? ANIM_IDLE_BACK : ANIM_IDLE_FRONT;
    // Use first idle frame as static pose if anim not playing
    if (this.scene.anims.exists(idleKey)) {
      this.sprite.play(idleKey, true);
      // stop after one frame to keep static? Keep playing slow idle
    } else {
      this.sprite.setFrame(this.facingBack ? 12 : 4);
    }
    this.sprite.setFlipX(this.facingLeft);
  }

  private updatePathMovement(deltaMs: number, context: WarriorWorldContext): void {
    const arrivingState = this.state;
    if (this.pathQueue.length > 0) {
      let remainingStep = this.moveSpeed * (deltaMs / 1000);
      while (remainingStep > 0 && this.pathQueue.length > 0) {
        const nextWaypoint = this.pathQueue[0];
        const dc = nextWaypoint.col - this.gridPos.col;
        const dr = nextWaypoint.row - this.gridPos.row;
        const dist = Math.hypot(dc, dr);
        if (dist <= 0.002) {
          this.gridPos.col = nextWaypoint.col;
          this.gridPos.row = nextWaypoint.row;
          this.pathQueue.shift();
          if (this.pathQueue.length > 0) this.updateWalkingFacing(this.pathQueue[0]);
          continue;
        }
        this.updateWalkingFacing(nextWaypoint);
        if (remainingStep >= dist) {
          this.gridPos.col = nextWaypoint.col;
          this.gridPos.row = nextWaypoint.row;
          remainingStep -= dist;
          this.pathQueue.shift();
          if (this.pathQueue.length > 0) this.updateWalkingFacing(this.pathQueue[0]);
        } else {
          const ratio = remainingStep / dist;
          this.gridPos.col += dc * ratio;
          this.gridPos.row += dr * ratio;
          remainingStep = 0;
        }
      }
      if (
        arrivingState === 'entering_building' &&
        this.pendingBuildingId &&
        this.pathQueue.length <= 1 &&
        context.canEnterBuildingNow(this, this.pendingBuildingId)
      ) {
        this.syncVisualTransform();
        context.completeEnterBuilding(this, this.pendingBuildingId);
        return;
      }
      if (this.pathQueue.length === 1) {
        const finalPt = this.pathQueue[0];
        const distToFinal = Math.hypot(finalPt.col - this.gridPos.col, finalPt.row - this.gridPos.row);
        if (distToFinal < 0.72 && this.wasSeparatedLastStep) {
          this.nearGoalCrowdedMs += deltaMs;
          if (this.nearGoalCrowdedMs >= 260) this.pathQueue = [];
        } else {
          this.nearGoalCrowdedMs = Math.max(0, this.nearGoalCrowdedMs - deltaMs);
        }
      }
      this.syncVisualTransform();
    }
    if (this.pathQueue.length === 0) {
      this.targetGridPos = null;
      this.nearGoalCrowdedMs = 0;
      if (arrivingState === 'entering_building' && this.pendingBuildingId) {
        const bid = this.pendingBuildingId;
        if (!context.completeEnterBuilding(this, bid)) {
          this.stopMovement();
        }
      } else {
        this.stopMovement();
      }
    }
  }

  private orientTowardWorldPoint(targetX: number, targetY: number): void {
    const vx = targetX - this.worldPos.x;
    const vy = targetY - this.worldPos.y;
    if (Math.abs(vx) > 0.25) this.facingLeft = vx < 0;
    if (Math.abs(vy) > 0.25) this.facingBack = vy < -0.15;
    this.sprite.setFlipX(this.facingLeft);
  }

  private updateWalkingFacing(nextTarget: GridCoord): void {
    const nextWorld = this.isoGrid.tileToWorld(nextTarget.col, nextTarget.row);
    this.orientTowardWorldPoint(nextWorld.x, nextWorld.y);
    this.sprite.anims.timeScale = this.moveSpeed / DEFAULT_MOVE_SPEED;
    const desiredAnim = this.facingBack ? ANIM_WALK_BACK : ANIM_WALK_FRONT;
    if (this.sprite.anims.currentAnim?.key !== desiredAnim || !this.sprite.anims.isPlaying) {
      this.sprite.play(desiredAnim, true);
    }
  }

  private drawSelectionRing(): void {
    this.selectionRing.clear();
    this.selectionRing.lineStyle(1.6, 0x38bdf8, 0.95);
    this.selectionRing.strokeEllipse(0, 4, 28, 14);
    this.selectionRing.lineStyle(1, 0x38bdf8, 0.32);
    this.selectionRing.strokeEllipse(0, 4, 38, 20);
  }
}
