/**
 * Karahanlı RTS — Birim Türleri, İstatistikler, Erzak/Açlık ve Garnizon Arayüzleri
 *
 * Köylü (villager), gelecekteki Savaşçı (warrior) ve Komutan (commander) birimlerinin
 * ortak veri modellerini tanımlar. Henüz oyun mekaniği aktif olmayan sistemler
 * (savaş/hasar alışverişi ve yiyecek üretimi) dürüstçe durum bayraklarıyla işaretlenir;
 * sahte kaynak üretilmez.
 */

import { GridCoord } from './pathfinding';

export type UnitCategory = 'villager' | 'warrior' | 'commander';

export type CarriedResourceType = 'wood' | 'food' | 'stone' | 'gold' | null;

export interface CarriedResourceSummary {
  resourceType: CarriedResourceType;
  resourceLabel: string;
  amount: number;
  maxCapacity: number;
}

export interface UnitNutritionState {
  /** Mevcut tokluk puanı (0..maxSatiety) */
  satiety: number;
  maxSatiety: number;
  /** Yiyecek ekonomisi (tarla/av/erzak deposu) aktifleştiğinde true olur */
  foodEconomyActive: boolean;
  /** Arayüzde gösterilecek dürüst durum açıklaması */
  statusText: string;
}

/**
 * Yerleşim erzak/yiyecek cüzdanı soyutlaması.
 * İleride yiyecek ekonomisi eklendiğinde gerçek erzak deposu bu arayüzü uygular;
 * böylece bina içindeki birimler geçici/sahte kaynak üretilmeden beslenebilir.
 */
export interface SettlementFoodProvisionWallet {
  isFoodEconomyActive(): boolean;
  getStoredFood(): number;
  consumeFood(amount: number): number;
}

/**
 * Yiyecek ekonomisi henüz eklenmemişken kullanılan dürüst varsayılan cüzdan.
 * Sahte yiyecek üretmez (storedFood = 0, isFoodEconomyActive = false).
 */
export class InactiveFoodProvisionWallet
  implements SettlementFoodProvisionWallet
{
  public isFoodEconomyActive(): boolean {
    return false;
  }

  public getStoredFood(): number {
    return 0;
  }

  public consumeFood(_amount: number): number {
    return 0;
  }
}

/**
 * Town Hall, Kışla, Kale veya Savunma Kulesi gibi garnizon destekli yapılara
 * girebilen tüm birimlerin (köylü, savaşçı, komutan) ortak sözleşmesi.
 */
export interface GarrisonableUnit {
  readonly id: string;
  readonly displayName: string;
  readonly unitCategory: UnitCategory;
  readonly unitTypeLabel: string;

  // Can, saldırı ve savunma değerleri
  getHp(): number;
  getMaxHp(): number;
  heal(amount: number): number;
  takeDamage(amount: number): number;
  getAttackDamage(): number;
  getDefenseArmor(): number;
  isCombatSystemActive(): boolean;

  // Açlık / tokluk altyapısı
  getNutritionState(): UnitNutritionState;
  restoreSatiety(amount: number): number;

  // Kaynak taşıma ve görev bilgisi
  getCarriedResourceSummary(): CarriedResourceSummary;
  getTaskDescription(
    resolveTreeLabel?: (treeId: string) => string | null
  ): string;

  // Komutan - bağlı asker (squad/retinue) altyapısı
  getCommanderId(): string | null;
  setCommanderId(commanderId: string | null): void;
  getAttachedUnitIds(): readonly string[];
  attachSubordinateUnit(unitId: string): void;
  detachSubordinateUnit(unitId: string): void;

  // Garnizon giriş / çıkış yaşam döngüsü
  isGarrisoned(): boolean;
  getGarrisonBuildingId(): string | null;
  onEnterGarrison(buildingId: string, buildingName: string): void;
  onExitGarrison(exitSpot: GridCoord): void;
}
