/**
 * Karahanlı RTS — Modüler Bina Garnizon Sistemi (BuildingGarrisonController)
 *
 * Celtic Kings tarzı bina içine birim yerleştirme mekaniğini yönetir.
 * Town Hall başta olmak üzere ileride eklenecek Kışla (Barracks), Kale (Castle)
 * ve Savunma Kulesi (Defense Tower) binalarında doğrudan kullanılacak biçimde
 * modüler tasarlanmıştır:
 * - Köylü, savaşçı ve komutan birimlerini kabul eder
 * - Varsayılan olarak katı kapasite sınırı yoktur (50+ kişilik orduların tamamı sığar)
 * - Komutan + bağlı asker grubunun (squad/retinue) birlikte binaya girmesini destekler
 * - İçerideki birimler haritada gizlenir, kaynak toplamaz ve dışarıya saldırmaz
 * - İçerideki birimler zamanla can yeniler; erzak ekonomisi aktifleştiğinde beslenir
 */

import { GridCoord } from './pathfinding';
import {
  GarrisonableUnit,
  InactiveFoodProvisionWallet,
  SettlementFoodProvisionWallet,
  UnitCategory,
} from './unitTypes';

export interface BuildingGarrisonConfig {
  buildingId: string;
  buildingName: string;
  /** Kabul edilen birim sınıfları (varsayılan: köylü, savaşçı, komutan) */
  allowedCategories?: readonly UnitCategory[];
  /** Katı kapasite sınırı; null ise sınırsızdır (50+ kişilik orduları tam alır) */
  maxCapacity?: number | null;
  /** İçerideki birimlerin saniyede yenilediği can miktarı */
  healHpPerSecond?: number;
  /** Erzak ekonomisi aktifken 1 birim yiyeceğin kazandırdığı tokluk */
  satietyPerFoodUnit?: number;
}

export interface GarrisonedUnitSummary {
  id: string;
  displayName: string;
  category: UnitCategory;
  typeLabel: string;
  hp: number;
  maxHp: number;
  commanderId: string | null;
}

export interface BuildingGarrisonSnapshot {
  buildingId: string;
  buildingName: string;
  totalCount: number;
  /** null = sınırsız kapasite */
  maxCapacity: number | null;
  countsByCategory: Record<UnitCategory, number>;
  units: GarrisonedUnitSummary[];
}

/** Garnizon barındırabilen tüm binaların ortak arayüzü */
export interface GarrisonableBuilding {
  readonly id: string;
  readonly buildingName: string;
  readonly garrison: BuildingGarrisonController;
  getEntranceApproachSpots(): GridCoord[];
  getSpawnCandidateSpots(): GridCoord[];
  isNearEntranceForEntry(pos: GridCoord): boolean;
}

const DEFAULT_ALLOWED_CATEGORIES: readonly UnitCategory[] = [
  'villager',
  'warrior',
  'commander',
];

export class BuildingGarrisonController {
  public readonly buildingId: string;
  public readonly buildingName: string;
  private readonly allowedCategories: Set<UnitCategory>;
  private maxCapacity: number | null;
  private readonly healHpPerSecond: number;
  private readonly satietyPerFoodUnit: number;

  private readonly units = new Map<string, GarrisonableUnit>();
  private readonly healRemainders = new Map<string, number>();
  private readonly fallbackWallet = new InactiveFoodProvisionWallet();

  constructor(config: BuildingGarrisonConfig) {
    this.buildingId = config.buildingId;
    this.buildingName = config.buildingName;
    this.allowedCategories = new Set(
      config.allowedCategories ?? DEFAULT_ALLOWED_CATEGORIES
    );
    this.maxCapacity =
      config.maxCapacity === undefined ? null : config.maxCapacity;
    this.healHpPerSecond = config.healHpPerSecond ?? 2.5;
    this.satietyPerFoodUnit = config.satietyPerFoodUnit ?? 25;
  }

  public getCount(): number {
    return this.units.size;
  }

  public getMaxCapacity(): number | null {
    return this.maxCapacity;
  }

  public setMaxCapacity(limit: number | null): void {
    this.maxCapacity = limit;
  }

  public hasUnit(unitId: string): boolean {
    return this.units.has(unitId);
  }

  public canAcceptUnit(unit: GarrisonableUnit): boolean {
    if (unit.isGarrisoned()) {
      return false;
    }
    if (!this.allowedCategories.has(unit.unitCategory)) {
      return false;
    }
    if (this.maxCapacity !== null && this.units.size >= this.maxCapacity) {
      return false;
    }
    return true;
  }

  /**
   * Komutan ve ona bağlı askerlerin (retinue/squad) birlikte binaya yönelmesi için
   * seçili birim listesini bağlı ast birimlerle genişletir.
   */
  public static expandWithCommanderRetinue<T extends GarrisonableUnit>(
    orderedUnits: readonly T[],
    resolveUnitById: (id: string) => T | undefined
  ): T[] {
    const expanded: T[] = [];
    const seen = new Set<string>();

    const pushUnique = (u: T | undefined): void => {
      if (!u || seen.has(u.id) || u.isGarrisoned()) {
        return;
      }
      seen.add(u.id);
      expanded.push(u);
    };

    for (const u of orderedUnits) {
      pushUnique(u);
      // Birim bir komutansa bağlı tüm askerlerini de gruba ekle
      for (const subId of u.getAttachedUnitIds()) {
        pushUnique(resolveUnitById(subId));
      }
    }

    return expanded;
  }

  /**
   * Girişe ulaşan birimi binanın içine alır; haritada gizler ve verilerini korur.
   */
  public enterUnit(unit: GarrisonableUnit): boolean {
    if (!this.canAcceptUnit(unit)) {
      return false;
    }

    this.units.set(unit.id, unit);
    this.healRemainders.set(unit.id, 0);
    unit.onEnterGarrison(this.buildingId, this.buildingName);
    return true;
  }

  /**
   * Belirli kimlikteki tek bir birimi verilen çıkış noktasında dışarı çıkarır.
   */
  public ejectUnit(
    unitId: string,
    exitSpot: GridCoord
  ): GarrisonableUnit | null {
    const unit = this.units.get(unitId);
    if (!unit) {
      return null;
    }

    this.units.delete(unitId);
    this.healRemainders.delete(unitId);
    unit.onExitGarrison(exitSpot);
    return unit;
  }

  /**
   * İçerideki ilk birimi dışarı çıkarır ("Tek Çıkar" butonu için).
   */
  public ejectFirstUnit(exitSpot: GridCoord): GarrisonableUnit | null {
    const firstKey = this.units.keys().next();
    if (firstKey.done) {
      return null;
    }
    return this.ejectUnit(firstKey.value, exitSpot);
  }

  /**
   * İçerideki tüm birimleri (50+ kişilik ordular dahil) hesaplanan açık meydan
   * noktalarına topluca dışarı çıkarır.
   */
  public ejectAllUnits(
    resolveExitSpots: (count: number) => GridCoord[]
  ): GarrisonableUnit[] {
    const count = this.units.size;
    if (count === 0) {
      return [];
    }

    const allUnits = Array.from(this.units.values());
    this.units.clear();
    this.healRemainders.clear();

    const exitSpots = resolveExitSpots(count);
    for (let i = 0; i < allUnits.length; i += 1) {
      const spot = exitSpots[i] ?? exitSpots[exitSpots.length - 1];
      allUnits[i].onExitGarrison(spot);
    }

    return allUnits;
  }

  /**
   * İçerideki birimlerin zamanla can yenilemesini ve (erzak ekonomisi aktif olduğunda)
   * yerleşim yiyecek stoğundan beslenmesini yürütür.
   */
  public update(
    deltaMs: number,
    foodWallet: SettlementFoodProvisionWallet = this.fallbackWallet
  ): void {
    if (this.units.size === 0 || deltaMs <= 0) {
      return;
    }

    const dtSec = deltaMs / 1000;

    for (const [id, unit] of this.units.entries()) {
      // 1) Zamanla can yenileme
      if (this.healHpPerSecond > 0 && unit.getHp() < unit.getMaxHp()) {
        const prevRem = this.healRemainders.get(id) ?? 0;
        const totalHeal = prevRem + this.healHpPerSecond * dtSec;
        const wholePoints = Math.floor(totalHeal);
        if (wholePoints >= 1) {
          unit.heal(wholePoints);
          this.healRemainders.set(id, totalHeal - wholePoints);
        } else {
          this.healRemainders.set(id, totalHeal);
        }
      } else {
        this.healRemainders.set(id, 0);
      }

      // 2) Açlık / erzak beslenme altyapısı (yalnızca gerçek yiyecek ekonomisi aktifken çalışır)
      if (foodWallet.isFoodEconomyActive() && foodWallet.getStoredFood() > 0) {
        const nutrition = unit.getNutritionState();
        const missingSatiety = nutrition.maxSatiety - nutrition.satiety;
        if (missingSatiety >= this.satietyPerFoodUnit) {
          const consumed = foodWallet.consumeFood(1);
          if (consumed > 0) {
            unit.restoreSatiety(consumed * this.satietyPerFoodUnit);
          }
        }
      }
    }
  }

  public getSnapshot(): BuildingGarrisonSnapshot {
    const countsByCategory: Record<UnitCategory, number> = {
      villager: 0,
      warrior: 0,
      commander: 0,
    };

    const summaries: GarrisonedUnitSummary[] = [];
    for (const unit of this.units.values()) {
      countsByCategory[unit.unitCategory] += 1;
      summaries.push({
        id: unit.id,
        displayName: unit.displayName,
        category: unit.unitCategory,
        typeLabel: unit.unitTypeLabel,
        hp: unit.getHp(),
        maxHp: unit.getMaxHp(),
        commanderId: unit.getCommanderId(),
      });
    }

    return {
      buildingId: this.buildingId,
      buildingName: this.buildingName,
      totalCount: this.units.size,
      maxCapacity: this.maxCapacity,
      countsByCategory,
      units: summaries,
    };
  }

  public clearAllWithoutEject(): void {
    this.units.clear();
    this.healRemainders.clear();
  }
}
