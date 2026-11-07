/**
 * Karahanlı RTS — Yönetilen Birim Sözleşmesi (ManagedUnit)
 *
 * Köylü (Villager) ve Kılıçlı Asker (Warrior) gibi oyuncu birimlerinin
 * seçim, hareket, ayrışma ve arayüz katmanınca kullanılan ortak sözleşmesi.
 *
 * VillagerSystem bu arayüz üzerinden çalışır; böylece yeni birim türleri
 * (okçu, mızraklı, komutan vb.) eklendiğinde seçim/hareket/panel kodunun
 * tamamının yeniden yazılması gerekmez.
 *
 * Not: TypeScript yapısal (structural) tipe sahiptir; Villager ve Warrior
 * sınıfları bu arayüzü "implements" ile açıkça belirtmek zorunda değildir,
 * ancak Warrior sınıfı derleme zamanı doğrulaması için uygular.
 */

import Phaser from 'phaser';
import { GridCoord } from './pathfinding';
import {
  CarriedResourceSummary,
  UnitCategory,
  UnitNutritionState,
} from './unitTypes';

export interface ManagedUnit {
  readonly id: string;
  readonly displayName: string;
  readonly unitCategory: UnitCategory;
  readonly unitTypeLabel: string;

  // --- Savaş ve sağlık değerleri ---
  getHp(): number;
  getMaxHp(): number;
  getAttackDamage(): number;
  getDefenseArmor(): number;
  isCombatSystemActive(): boolean;

  // --- Erzak / tokluk ve kaynak taşıma ---
  getNutritionState(): UnitNutritionState;
  getCarriedResourceSummary(): CarriedResourceSummary;
  getTaskDescription(
    resolveTreeLabel?: (treeId: string) => string | null
  ): string;

  // --- Seçim ve durum ---
  isGarrisoned(): boolean;
  setSelected(value: boolean): void;
  getState(): string;
  isMoving(): boolean;

  // --- Konum ve hareket ---
  getGridPosition(): GridCoord;
  getWorldPosition(): { x: number; y: number };
  setMovePath(waypoints: GridCoord[]): void;
  stopMovement(): void;
  applySeparationOffset(
    dCol: number,
    dRow: number,
    isWalkablePos: (col: number, row: number) => boolean
  ): boolean;

  // --- Fare / dokunma isabet testleri ---
  containsWorldPoint(worldX: number, worldY: number, isTouch?: boolean): boolean;
  distanceToBodyCenter(worldX: number, worldY: number): number;
  intersectsWorldRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): boolean;

  // --- Sahne yaşam döngüsü ---
  ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void;
  destroy(): void;
}
