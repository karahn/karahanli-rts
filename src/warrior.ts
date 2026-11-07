/**
 * Karahanlı RTS — Kılıçlı Asker (Warrior)
 *
 * Kışlada üretilen Karahanlı kılıçlı savaşçısı:
 * - Seçilebilir, hareket ettirilebilir ve grup emirlerine uyar
 * - Köylüler gibi kaynak TOPLAMAZ; taşıma kapasitesi yoktur
 * - Henüz düşman, saldırı, savaş ve ölüm sistemi yoktur; saldırı/savunma
 *   değerleri yalnızca bilgi panelinde dürüstçe gösterilir
 * - Yürüyüş (ön/arka) ve bekleme (ön/arka) animasyonlarına sahiptir
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';
import { ManagedUnit } from './managedUnit';
import {
  CarriedResourceSummary,
  UnitCategory,
  UnitNutritionState,
} from './unitTypes';

export const WARRIOR_TEXTURE_KEY = 'warrior_karahanli';
export const WARRIOR_ASSET_PATH = 'assets/sprites/warrior_karahanli.png';
export const WARRIOR_FRAME_WIDTH = 160;
export const WARRIOR_FRAME_HEIGHT = 152;

/** Kılıçlı askerin temel değerleri */
export const WARRIOR_DEFAULT_MAX_HP = 110;
export const WARRIOR_DEFAULT_ATTACK = 9;
export const WARRIOR_DEFAULT_DEFENSE = 3;

/**
 * Doku içindeki zemin temas noktası — sprite sheet ölçülerek hesaplandı.
 * ORIGIN_Y bilinçli olarak ayak hizasının (139) ~4.5 px üstünde tutuldu: köylü
 * sprite'ında da aynı kural geçerli (origin 132 / ayak 137), böylece iki birim
 * yan yana durduğunda ayakları aynı hizada, yere oturmuş görünür.
 */
const ORIGIN_X = 0.54531;
const ORIGIN_Y = 134.5 / WARRIOR_FRAME_HEIGHT;
/** Köylü ile aynı görünür ölçek (0.37); karakter daha uzun olduğu için ~%15 iri durur */
const DEFAULT_SCALE = 0.37;
const DEFAULT_MOVE_SPEED = 2.15;

const BASE_WALK_FPS = 8.5;
const IDLE_FPS = 2.6;

const ANIM_WALK_FRONT = 'karahanli_warrior_walk_front';
const ANIM_WALK_BACK = 'karahanli_warrior_walk_back';
const ANIM_IDLE_FRONT = 'karahanli_warrior_idle_front';
const ANIM_IDLE_BACK = 'karahanli_warrior_idle_back';

export type WarriorState = 'idle' | 'walking';

export interface WarriorConfig {
  id: string;
  displayName?: string;
  col: number;
  row: number;
  initialFacingBack?: boolean;
  initialFacingLeft?: boolean;
  scale?: number;
  moveSpeed?: number;
  maxHp?: number;
  attackDamage?: number;
  defenseArmor?: number;
}

/** Askerin hiçbir kaynak taşımadığını gösteren sabit özet */
const NO_CARRIED_RESOURCE: CarriedResourceSummary = {
  resourceType: null,
  resourceLabel: '—',
  amount: 0,
  maxCapacity: 0,
};

export class Warrior implements ManagedUnit {
  public readonly id: string;
  public readonly displayName: string;
  public readonly unitCategory: UnitCategory = 'warrior';
  public readonly unitTypeLabel = 'Kılıçlı Asker';

  private readonly isoGrid: IsoGrid;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly selectionRing: Phaser.GameObjects.Graphics;
  private readonly unitScale: number;

  private readonly maxHp: number;
  private hp: number;
  private readonly attackDamage: number;
  private readonly defenseArmor: number;

  private gridPos: GridCoord;
  private worldPos: { x: number; y: number };
  private moveSpeed: number;

  private selected = false;
  private state: WarriorState = 'idle';
  private pathQueue: GridCoord[] = [];
  private facingBack: boolean;
  private facingLeft: boolean;
  private nearGoalCrowdedMs = 0;
  private wasSeparatedLastStep = false;

  constructor(
    scene: Phaser.Scene,
    isoGrid: IsoGrid,
    config: WarriorConfig
  ) {
    this.id = config.id;
    this.displayName = config.displayName ?? config.id;
    this.isoGrid = isoGrid;
    this.gridPos = { col: config.col, row: config.row };
    this.worldPos = isoGrid.tileToWorld(config.col, config.row);
    this.moveSpeed = config.moveSpeed ?? DEFAULT_MOVE_SPEED;
    this.unitScale = config.scale ?? DEFAULT_SCALE;
    this.maxHp = config.maxHp ?? WARRIOR_DEFAULT_MAX_HP;
    this.hp = this.maxHp;
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
      this.facingBack ? 4 : 0
    );
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(this.unitScale);
    this.sprite.setFlipX(this.facingLeft);

    this.syncVisualTransform();
    this.enterIdlePose();
  }

  public static preload(scene: Phaser.Scene): void {
    scene.load.spritesheet(WARRIOR_TEXTURE_KEY, WARRIOR_ASSET_PATH, {
      frameWidth: WARRIOR_FRAME_WIDTH,
      frameHeight: WARRIOR_FRAME_HEIGHT,
    });
  }

  public static ensureAnimations(scene: Phaser.Scene): void {
    const defs: Array<{
      key: string;
      frames: number[];
      fps: number;
    }> = [
      { key: ANIM_WALK_FRONT, frames: [1, 2, 3, 0], fps: BASE_WALK_FPS },
      { key: ANIM_WALK_BACK, frames: [5, 6, 7, 4], fps: BASE_WALK_FPS },
      { key: ANIM_IDLE_FRONT, frames: [8, 9, 10, 11], fps: IDLE_FPS },
      { key: ANIM_IDLE_BACK, frames: [12, 13, 14, 15], fps: IDLE_FPS },
    ];

    for (const def of defs) {
      if (scene.anims.exists(def.key)) {
        continue;
      }
      scene.anims.create({
        key: def.key,
        frames: scene.anims.generateFrameNumbers(WARRIOR_TEXTURE_KEY, {
          frames: def.frames,
        }),
        frameRate: def.fps,
        repeat: -1,
      });
    }
  }

  // --- Değerler ---

  public getHp(): number {
    return this.hp;
  }

  public getMaxHp(): number {
    return this.maxHp;
  }

  public heal(amount: number): number {
    if (amount <= 0) {
      return this.hp;
    }
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp;
  }

  public takeDamage(amount: number): number {
    if (amount <= 0) {
      return this.hp;
    }
    this.hp = Math.max(0, this.hp - amount);
    return this.hp;
  }

  public getAttackDamage(): number {
    return this.attackDamage;
  }

  public getDefenseArmor(): number {
    return this.defenseArmor;
  }

  /** Savaş sistemi henüz aktif değil — panel dürüstçe bunu gösterir. */
  public isCombatSystemActive(): boolean {
    return false;
  }

  public getNutritionState(): UnitNutritionState {
    return {
      satiety: 100,
      maxSatiety: 100,
      foodEconomyActive: false,
      statusText: 'Erzak ekonomisi geliştirme aşamasında',
    };
  }

  public getCarriedResourceSummary(): CarriedResourceSummary {
    return NO_CARRIED_RESOURCE;
  }

  public getTaskDescription(): string {
    if (this.state === 'walking') {
      return 'Yürüyor';
    }
    return 'Nöbette';
  }

  // --- Seçim ve durum ---

  public setSelected(value: boolean): void {
    if (this.selected === value) {
      return;
    }
    this.selected = value;
    this.selectionRing.setVisible(value);
  }

  public isSelected(): boolean {
    return this.selected;
  }

  public getState(): WarriorState {
    return this.state;
  }

  public isMoving(): boolean {
    return this.state === 'walking';
  }

  public isGarrisoned(): boolean {
    return false;
  }

  // --- Konum ve hareket ---

  public getGridPosition(): GridCoord {
    return { col: this.gridPos.col, row: this.gridPos.row };
  }

  public getWorldPosition(): { x: number; y: number } {
    return { x: this.worldPos.x, y: this.worldPos.y };
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

  public setMovePath(waypoints: GridCoord[]): void {
    if (waypoints.length === 0) {
      this.stopMovement();
      return;
    }

    this.pathQueue = waypoints.map((pt) => ({ col: pt.col, row: pt.row }));
    this.nearGoalCrowdedMs = 0;
    this.state = 'walking';
    this.updateWalkingFacing(waypoints[0]);
  }

  public stopMovement(): void {
    this.pathQueue = [];
    this.nearGoalCrowdedMs = 0;
    this.enterIdlePose();
  }

  public update(deltaMs: number): void {
    if (this.state !== 'walking') {
      this.wasSeparatedLastStep = false;
      return;
    }

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
          if (this.pathQueue.length > 0) {
            this.updateWalkingFacing(this.pathQueue[0]);
          }
          continue;
        }

        this.updateWalkingFacing(nextWaypoint);

        if (remainingStep >= dist) {
          this.gridPos.col = nextWaypoint.col;
          this.gridPos.row = nextWaypoint.row;
          remainingStep -= dist;
          this.pathQueue.shift();
          if (this.pathQueue.length > 0) {
            this.updateWalkingFacing(this.pathQueue[0]);
          }
        } else {
          const ratio = remainingStep / dist;
          this.gridPos.col += dc * ratio;
          this.gridPos.row += dr * ratio;
          remainingStep = 0;
        }
      }

      if (this.pathQueue.length === 1) {
        const finalPt = this.pathQueue[0];
        const distToFinal = Math.hypot(
          finalPt.col - this.gridPos.col,
          finalPt.row - this.gridPos.row
        );
        if (distToFinal < 0.72 && this.wasSeparatedLastStep) {
          this.nearGoalCrowdedMs += deltaMs;
          if (this.nearGoalCrowdedMs >= 260) {
            this.pathQueue = [];
          }
        } else {
          this.nearGoalCrowdedMs = Math.max(
            0,
            this.nearGoalCrowdedMs - deltaMs
          );
        }
      }

      this.syncVisualTransform();
    }

    if (this.pathQueue.length === 0) {
      this.stopMovement();
    }

    this.wasSeparatedLastStep = false;
  }

  public applySeparationOffset(
    dCol: number,
    dRow: number,
    isWalkablePos: (col: number, row: number) => boolean
  ): boolean {
    if (Math.abs(dCol) < 0.0001 && Math.abs(dRow) < 0.0001) {
      return false;
    }

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

  // --- İsabet testleri ---

  public containsWorldPoint(
    worldX: number,
    worldY: number,
    isTouch = false
  ): boolean {
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

  public intersectsWorldRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): boolean {
    const halfW = 16 * this.unitScale;
    const bodyHeight = 88 * this.unitScale;

    const unitLeft = this.worldPos.x - halfW;
    const unitRight = this.worldPos.x + halfW;
    const unitTop = this.worldPos.y - bodyHeight;
    const unitBottom = this.worldPos.y + 4;

    return (
      unitRight >= minX &&
      unitLeft <= maxX &&
      unitBottom >= minY &&
      unitTop <= maxY
    );
  }

  public distanceToBodyCenter(worldX: number, worldY: number): number {
    const bodyCenterY = this.worldPos.y - 46 * this.unitScale;
    return Math.hypot(worldX - this.worldPos.x, worldY - bodyCenterY);
  }

  // --- Sahne yaşam döngüsü ---

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

  // --- Dahili ---

  private enterIdlePose(): void {
    this.state = 'idle';
    this.sprite.anims.timeScale = 1;
    const desiredAnim = this.facingBack ? ANIM_IDLE_BACK : ANIM_IDLE_FRONT;
    if (
      this.sprite.anims.currentAnim?.key !== desiredAnim ||
      !this.sprite.anims.isPlaying
    ) {
      this.sprite.play(desiredAnim, true);
    }
    this.sprite.setFlipX(this.facingLeft);
  }

  private updateWalkingFacing(nextTarget: GridCoord): void {
    const nextWorld = this.isoGrid.tileToWorld(nextTarget.col, nextTarget.row);
    this.orientTowardWorldPoint(nextWorld.x, nextWorld.y);
    this.sprite.anims.timeScale = this.moveSpeed / DEFAULT_MOVE_SPEED;

    const desiredAnim = this.facingBack ? ANIM_WALK_BACK : ANIM_WALK_FRONT;
    if (
      this.sprite.anims.currentAnim?.key !== desiredAnim ||
      !this.sprite.anims.isPlaying
    ) {
      this.sprite.play(desiredAnim, true);
    }
  }

  private orientTowardWorldPoint(targetX: number, targetY: number): void {
    const vx = targetX - this.worldPos.x;
    const vy = targetY - this.worldPos.y;

    if (Math.abs(vx) > 0.25) {
      this.facingLeft = vx < 0;
    }
    if (Math.abs(vy) > 0.25) {
      this.facingBack = vy < -0.15;
    }

    this.sprite.setFlipX(this.facingLeft);
  }

  private drawSelectionRing(): void {
    this.selectionRing.clear();
    const ringW = Math.max(18, Math.round(60 * this.unitScale));
    const ringH = Math.max(9, Math.round(30 * this.unitScale));

    this.selectionRing.fillStyle(0x22c55e, 0.15);
    this.selectionRing.fillEllipse(0, 0, ringW, ringH);
    this.selectionRing.lineStyle(1.4, 0x4ade80, 0.95);
    this.selectionRing.strokeEllipse(0, 0, ringW, ringH);
  }
}
