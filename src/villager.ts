/**
 * Karahanlı RTS — Köylü Birim Sınıfı (Villager)
 *
 * Tarihî Karahanlı dönemine uygun erkek köylü biriminin konum, hareket hızı,
 * seçim durumu, hedef koordinatı, yönlü yürüyüş animasyonu ve izometrik
 * derinlik sıralamasını yönetir. İleride çoklu birim ve görev sistemlerine
 * (kaynak toplama, inşaat vb.) genişletilebilecek şekilde tasarlanmıştır.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';

export const VILLAGER_TEXTURE_KEY = 'villager_karahanli';
export const VILLAGER_ASSET_PATH = 'assets/sprites/villager_karahanli.png';
export const VILLAGER_FRAME_WIDTH = 96;
export const VILLAGER_FRAME_HEIGHT = 128;

const ANIM_WALK_FRONT = 'karahanli_villager_walk_front';
const ANIM_WALK_BACK = 'karahanli_villager_walk_back';

const ORIGIN_X = 48 / VILLAGER_FRAME_WIDTH;
const ORIGIN_Y = 110 / VILLAGER_FRAME_HEIGHT;
const DEFAULT_SCALE = 0.46;

/** Saniyede katedilen ızgara karosu birimi cinsinden doğal yürüyüş hızı */
const DEFAULT_MOVE_SPEED = 2.35;

export type VillagerState = 'idle' | 'walking';

export interface VillagerConfig {
  id: string;
  col: number;
  row: number;
  moveSpeed?: number;
  scale?: number;
}

export class Villager {
  public readonly id: string;
  private readonly isoGrid: IsoGrid;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly selectionRing: Phaser.GameObjects.Graphics;

  private gridPos: GridCoord;
  private worldPos: { x: number; y: number };
  private moveSpeed: number;
  private selected = false;
  private state: VillagerState = 'idle';
  private targetGridPos: GridCoord | null = null;
  private pathQueue: GridCoord[] = [];
  private facingBack = false;
  private facingLeft = false;

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid, config: VillagerConfig) {
    this.id = config.id;
    this.isoGrid = isoGrid;
    this.gridPos = { col: config.col, row: config.row };
    this.worldPos = isoGrid.tileToWorld(config.col, config.row);
    this.moveSpeed = config.moveSpeed ?? DEFAULT_MOVE_SPEED;

    const unitScale = config.scale ?? DEFAULT_SCALE;

    // Seçildiğinde ayaklarının altında beliren ince yeşil izometrik seçim halkası
    this.selectionRing = scene.add.graphics();
    this.drawSelectionRing();
    this.selectionRing.setVisible(false);

    // Tarihî Karahanlı köylü sprite'ı
    this.sprite = scene.add.sprite(this.worldPos.x, this.worldPos.y, VILLAGER_TEXTURE_KEY, 0);
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(unitScale);

    this.syncVisualTransform();
  }

  /**
   * Köylü spritesheet görselini Phaser önbelleğine yükler.
   */
  public static preload(scene: Phaser.Scene): void {
    scene.load.spritesheet(VILLAGER_TEXTURE_KEY, VILLAGER_ASSET_PATH, {
      frameWidth: VILLAGER_FRAME_WIDTH,
      frameHeight: VILLAGER_FRAME_HEIGHT,
    });
  }

  /**
   * Ön-çapraz ve arka-çapraz 4 karelik yürüyüş animasyonlarını kaydeder.
   */
  public static ensureAnimations(scene: Phaser.Scene): void {
    if (!scene.anims.exists(ANIM_WALK_FRONT)) {
      scene.anims.create({
        key: ANIM_WALK_FRONT,
        frames: scene.anims.generateFrameNumbers(VILLAGER_TEXTURE_KEY, {
          frames: [1, 2, 3, 0],
        }),
        frameRate: 8,
        repeat: -1,
      });
    }

    if (!scene.anims.exists(ANIM_WALK_BACK)) {
      scene.anims.create({
        key: ANIM_WALK_BACK,
        frames: scene.anims.generateFrameNumbers(VILLAGER_TEXTURE_KEY, {
          frames: [5, 6, 7, 4],
        }),
        frameRate: 8,
        repeat: -1,
      });
    }
  }

  /** Seçim durumunu günceller ve yeşil seçim halkasını açar/kapatır. */
  public setSelected(value: boolean): void {
    if (this.selected === value) {
      return;
    }
    this.selected = value;
    this.selectionRing.setVisible(value);
  }

  /** Köylünün seçili olup olmadığını döndürür. */
  public isSelected(): boolean {
    return this.selected;
  }

  /** Mevcut ızgara koordinatının kopyasını döndürür. */
  public getGridPosition(): GridCoord {
    return { col: this.gridPos.col, row: this.gridPos.row };
  }

  /** Mevcut dünya piksel koordinatını döndürür. */
  public getWorldPosition(): { x: number; y: number } {
    return { x: this.worldPos.x, y: this.worldPos.y };
  }

  /** Aktif hedef ızgara koordinatını (yoksa null) döndürür. */
  public getTargetPosition(): GridCoord | null {
    return this.targetGridPos
      ? { col: this.targetGridPos.col, row: this.targetGridPos.row }
      : null;
  }

  /** Köylünün hareket hızını (karo/sn) döndürür. */
  public getMoveSpeed(): number {
    return this.moveSpeed;
  }

  /** Köylünün hareket hızını (karo/sn) günceller. */
  public setMoveSpeed(speedTilesPerSec: number): void {
    this.moveSpeed = Math.max(0.2, speedTilesPerSec);
  }

  /** Mevcut durumunu ('idle' | 'walking') döndürür. */
  public getState(): VillagerState {
    return this.state;
  }

  /**
   * Köylüye yeni bir yürüyüş rotası atar.
   * Önceki hareket devam ediyorsa anında kesilip yeni rotaya yönelir.
   */
  public setMovePath(waypoints: GridCoord[]): void {
    if (waypoints.length === 0) {
      this.stopMovement();
      return;
    }

    this.pathQueue = waypoints.map((pt) => ({ col: pt.col, row: pt.row }));
    this.targetGridPos = {
      col: waypoints[waypoints.length - 1].col,
      row: waypoints[waypoints.length - 1].row,
    };
    this.state = 'walking';
    this.updateFacingAndAnimation(waypoints[0]);
  }

  /** Mevcut yürüyüşü durdurur ve duruş (idle) karesine geçer. */
  public stopMovement(): void {
    this.pathQueue = [];
    this.targetGridPos = null;
    this.state = 'idle';
    this.sprite.anims.stop();
    this.sprite.setFrame(this.facingBack ? 4 : 0);
    this.sprite.setFlipX(this.facingLeft);
  }

  /**
   * Her karede köylüyü sıradaki rota noktasına doğru akıcı biçimde ilerletir.
   */
  public update(deltaMs: number): void {
    if (this.state !== 'walking' || this.pathQueue.length === 0) {
      return;
    }

    let remainingStep = this.moveSpeed * (deltaMs / 1000);

    while (remainingStep > 0 && this.pathQueue.length > 0) {
      const nextWaypoint = this.pathQueue[0];
      const dc = nextWaypoint.col - this.gridPos.col;
      const dr = nextWaypoint.row - this.gridPos.row;
      const dist = Math.hypot(dc, dr);

      if (dist <= 0.0005) {
        this.gridPos.col = nextWaypoint.col;
        this.gridPos.row = nextWaypoint.row;
        this.pathQueue.shift();
        if (this.pathQueue.length > 0) {
          this.updateFacingAndAnimation(this.pathQueue[0]);
        }
        continue;
      }

      this.updateFacingAndAnimation(nextWaypoint);

      if (remainingStep >= dist) {
        this.gridPos.col = nextWaypoint.col;
        this.gridPos.row = nextWaypoint.row;
        remainingStep -= dist;
        this.pathQueue.shift();
        if (this.pathQueue.length > 0) {
          this.updateFacingAndAnimation(this.pathQueue[0]);
        }
      } else {
        const ratio = remainingStep / dist;
        this.gridPos.col += dc * ratio;
        this.gridPos.row += dr * ratio;
        remainingStep = 0;
      }
    }

    this.syncVisualTransform();

    if (this.pathQueue.length === 0) {
      this.stopMovement();
    }
  }

  /**
   * Dünya koordinatındaki (worldX, worldY) bir tıklama/dokunmanın bu köylünün
   * gövdesi üzerine denk gelip gelmediğini kontrol eder.
   */
  public containsWorldPoint(
    worldX: number,
    worldY: number,
    isTouch = false
  ): boolean {
    const pad = isTouch ? 11 : 4;
    const halfWidth = 13 + pad;
    const headHeight = 42 + pad;
    const footDepth = 8 + pad;

    return (
      worldX >= this.worldPos.x - halfWidth &&
      worldX <= this.worldPos.x + halfWidth &&
      worldY >= this.worldPos.y - headHeight &&
      worldY <= this.worldPos.y + footDepth
    );
  }

  /**
   * Sabit arayüz (HUD) kamerasının köylü görsellerini çizmemesini sağlar.
   */
  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore([this.selectionRing, this.sprite]);
  }

  /** Harita konumu değişirse köylünün dünya konumunu ve derinliğini günceller. */
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

  /**
   * Hareket vektörünün ekrandaki izometrik yönüne göre uygun yönü (ön/arka + sağ/sol)
   * ve yürüyüş animasyonunu seçer.
   */
  private updateFacingAndAnimation(nextTarget: GridCoord): void {
    const nextWorld = this.isoGrid.tileToWorld(nextTarget.col, nextTarget.row);
    const vx = nextWorld.x - this.worldPos.x;
    const vy = nextWorld.y - this.worldPos.y;

    if (Math.abs(vx) > 0.25) {
      this.facingLeft = vx < 0;
    }
    if (Math.abs(vy) > 0.25) {
      this.facingBack = vy < -0.15;
    }

    this.sprite.setFlipX(this.facingLeft);

    const desiredAnim = this.facingBack ? ANIM_WALK_BACK : ANIM_WALK_FRONT;
    if (this.sprite.anims.currentAnim?.key !== desiredAnim || !this.sprite.anims.isPlaying) {
      this.sprite.play(desiredAnim, true);
    }
  }

  private drawSelectionRing(): void {
    this.selectionRing.clear();
    // İnce yeşil izometrik seçim halkası (2:1 elips oranı)
    this.selectionRing.fillStyle(0x22c55e, 0.14);
    this.selectionRing.fillEllipse(0, 0, 28, 14);
    this.selectionRing.lineStyle(1.6, 0x4ade80, 0.95);
    this.selectionRing.strokeEllipse(0, 0, 28, 14);
  }
}
