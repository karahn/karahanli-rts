/**
 * Karahanlı RTS — Birim Seçim, Grup Hareketi, Odun Toplama ve Garnizon Koordinasyon Sistemi
 *
 * Sahnedeki tüm birimleri tekli/çoklu seçimle yönetir ve modüler garnizon binalarıyla
 * (Town Hall ve ileride Kışla, Kale, Savunma Kulesi) tam entegre çalışır:
 * - Seçili birim(ler) varken Town Hall'a sağ tıklanınca (mobilde dokunulunca veya
 *   paneldeki "Binaya Gir" butonuyla) birimler girişe yürür ve içeri girer
 * - İçerideki birimler haritada görünmez, kaynak toplamaz; verileri korunur ve can yeniler
 * - 50+ kişilik ordular dahil tek tek veya topluca dışarı çıkarılabilir
 * - Alt bilgi paneli için tekli birim, çoklu birim ve yerleşim özet verilerini üretir
 */

import Phaser from 'phaser';
import { MapCameraController } from './cameraController';
import {
  ForestSystem,
  TreeResourceNode,
  WoodHarvestResult,
} from './forestSystem';
import {
  BuildingGarrisonController,
  GarrisonableBuilding,
} from './garrisonSystem';
import { IsoGrid } from './isoGrid';
import {
  findSmoothGridPath,
  GridCoord,
  GridObstacleQuery,
} from './pathfinding';
import { TRAIN_VILLAGER_TASK_ID, TownHall } from './townHall';
import {
  CarriedResourceSummary,
  UnitCategory,
  UnitNutritionState,
} from './unitTypes';
import {
  Villager,
  VillagerConfig,
  VillagerState,
  VillagerWorldContext,
} from './villager';
import { Warrior, WarriorConfig, WarriorWorldContext } from './warrior';
import { Barracks, BARRACKS_TRAIN_WARRIOR_TASK_ID } from './barracks';
import { WoodDepot } from './woodDepot';

/** Town Hall (9..11, 5..7) ve Odun Deposu (6, 5) önündeki meydanda başlangıçtaki 3 Karahanlı köylüsü */
export const INITIAL_VILLAGER_SPAWNS: readonly VillagerConfig[] = [
  {
    id: 'villager_1',
    displayName: 'Köylü 1',
    col: 8,
    row: 7,
    initialFacingBack: false,
    initialFacingLeft: true,
  },
  {
    id: 'villager_2',
    displayName: 'Köylü 2',
    col: 10,
    row: 8.8,
    initialFacingBack: true,
    initialFacingLeft: true,
  },
  {
    id: 'villager_3',
    displayName: 'Köylü 3',
    col: 7,
    row: 8.2,
    initialFacingBack: false,
    initialFacingLeft: false,
  },
];

const INTERACT_STAND_RADIUS = 0.86;
const MIN_VILLAGER_SEPARATION = 0.62;
const DYNAMIC_SEPARATION_RADIUS = 0.64;
const FORMATION_SPACING = 0.86;
const MARQUEE_DRAG_THRESHOLD_PX = 7;
const DOUBLE_TAP_WINDOW_MS = 350;

export interface SingleUnitPanelInfo {
  id: string;
  displayName: string;
  unitTypeLabel: string;
  category: UnitCategory;
  hp: number;
  maxHp: number;
  attackDamage: number;
  defenseArmor: number;
  combatSystemActive: boolean;
  nutrition: UnitNutritionState;
  carriedResource: CarriedResourceSummary;
  taskDescription: string;
  state: VillagerState;
}

export interface MultiSelectedUnitIconItem {
  id: string;
  displayName: string;
  shortTag: string;
  category: UnitCategory;
  hp: number;
  maxHp: number;
  carriedWood: number;
  state: VillagerState;
}

export interface MultiSelectedHudInfo {
  count: number;
  totalCarriedWood: number;
  totalCapacity: number;
  choppingCount: number;
  movingCount: number;
  units: MultiSelectedUnitIconItem[];
}

export interface VillagerHudStatus {
  totalStoredWood: number;
  totalVillagersCount: number;
  fieldVillagersCount: number;
  garrisonedVillagersCount: number;
  // Warrior counts (new)
  totalWarriorsCount: number;
  fieldWarriorsCount: number;
  garrisonedWarriorsCount: number;
  // Unified totals
  totalUnitsCount: number;
  fieldUnitsCount: number;
  workingVillagersCount: number;
  remainingTreesCount: number;
  selectedCount: number;
  touchBoxSelectMode: boolean;
  selectedUnit: SingleUnitPanelInfo | null;
  multiSelected: MultiSelectedHudInfo | null;
}

export class VillagerSystem {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly forestSystem: ForestSystem;
  private readonly woodDepot: WoodDepot;
  private readonly townHall: TownHall;
  private readonly cameraController: MapCameraController;
  private readonly worldContext: VillagerWorldContext;

  private readonly villagers = new Map<string, Villager>();
  private readonly warriors = new Map<string, Warrior>();
  private readonly garrisonBuildings = new Map<string, GarrisonableBuilding>();
  private readonly selectedVillagerIds = new Set<string>();
  private readonly selectedWarriorIds = new Set<string>();
  private readonly ignoredWorldCameras = new Set<Phaser.Cameras.Scene2D.Camera>();
  private nextVillagerNumber = 1;
  private nextWarriorNumber = 1;
  private barracks: Barracks | null = null;

  private isScreenUiBlocked?: (screenX: number, screenY: number) => boolean;

  private readonly marqueeGraphics: Phaser.GameObjects.Graphics;
  private isMarqueeCandidate = false;
  private isMarqueeDragging = false;
  private marqueePointerId = -1;
  private marqueeStartX = 0;
  private marqueeStartY = 0;
  private marqueeAdditive = false;
  private marqueeBaseSelection = new Set<string>();

  private touchBoxSelectMode = false;
  private lastVillagerTapTime = 0;
  private lastTappedVillagerId: string | null = null;

  private readonly moveMarker: Phaser.GameObjects.Graphics;
  private moveMarkerTween?: Phaser.Tweens.Tween;

  constructor(
    scene: Phaser.Scene,
    isoGrid: IsoGrid,
    forestSystem: ForestSystem,
    woodDepot: WoodDepot,
    townHall: TownHall,
    cameraController: MapCameraController,
    barracks: Barracks | null = null
  ) {
    this.scene = scene;
    this.isoGrid = isoGrid;
    this.forestSystem = forestSystem;
    this.woodDepot = woodDepot;
    this.townHall = townHall;
    this.cameraController = cameraController;

    this.registerGarrisonableBuilding(townHall);
    if (barracks) {
      this.barracks = barracks;
      this.registerGarrisonableBuilding(barracks);
      barracks.onTaskCompleted((task) => {
        if (task.id === BARRACKS_TRAIN_WARRIOR_TASK_ID) {
          this.spawnWarriorFromBarracks();
        }
      });
    }
    Villager.ensureAnimations(scene);
    Warrior.ensureAnimations(scene);

    this.worldContext = {
      forestSystem: this.forestSystem,
      woodDepot: this.woodDepot,
      planPathToTree: (villager, tree) =>
        this.buildPathToTileAdjacent(villager, tree.tile),
      planPathToDepot: (villager) =>
        this.buildPathToTileAdjacent(villager, this.woodDepot.getTile()),
      canEnterBuildingNow: (villager, buildingId) => {
        const b = this.garrisonBuildings.get(buildingId);
        if (!b || !b.garrison.canAcceptUnit(villager)) {
          return false;
        }
        return b.isNearEntranceForEntry(villager.getGridPosition());
      },
      completeEnterBuilding: (villager, buildingId) =>
        this.finalizeUnitEnterBuilding(villager, buildingId),
      isFoodEconomyActive: () => false,
      onWoodHarvested: (villager, result) => {
        this.spawnWoodHarvestPop(villager, result);
      },
      onWoodDeposited: (_villager, depositedAmount) => {
        this.spawnWoodDepositPop(depositedAmount);
      },
    };

    this.townHall.onTaskCompleted((task) => {
      if (task.id === TRAIN_VILLAGER_TASK_ID) {
        this.spawnVillagerFromTownHall();
      }
    });

    this.moveMarker = scene.add.graphics();
    this.moveMarker.setDepth(5);
    this.moveMarker.setVisible(false);

    this.marqueeGraphics = scene.add.graphics();
    this.marqueeGraphics.setDepth(4990);
    this.marqueeGraphics.setVisible(false);

    this.cameraController.setPointerDragSuppression((pointer) => {
      if (this.isScreenUiBlocked?.(pointer.x, pointer.y)) {
        return true;
      }
      if (pointer.wasTouch && this.touchBoxSelectMode) {
        return true;
      }
      return false;
    });

    this.bindInputEvents();
  }

  public static preload(scene: Phaser.Scene): void {
    Villager.preload(scene);
    Warrior.preload(scene);
  }

  /**
   * İleride eklenecek Kışla, Kale veya Savunma Kulesi binalarını garnizon sistemine kaydeder.
   */
  public registerGarrisonableBuilding(building: GarrisonableBuilding): void {
    this.garrisonBuildings.set(building.id, building);
  }

  public setUiHitBlocker(
    predicate: (screenX: number, screenY: number) => boolean
  ): void {
    this.isScreenUiBlocked = predicate;
  }

  public getScreenOverlayObjects(): Phaser.GameObjects.GameObject[] {
    return [this.marqueeGraphics];
  }

  public setTouchBoxSelectMode(enabled: boolean): void {
    this.touchBoxSelectMode = enabled;
    if (enabled) {
      this.townHall.setSelected(false);
    }
    if (!enabled && this.isMarqueeDragging) {
      this.cancelMarqueeDrag();
    }
  }

  public toggleTouchBoxSelectMode(): boolean {
    this.setTouchBoxSelectMode(!this.touchBoxSelectMode);
    return this.touchBoxSelectMode;
  }

  public isTouchBoxSelectMode(): boolean {
    return this.touchBoxSelectMode;
  }

  public spawnInitialVillagers(
    configs: readonly VillagerConfig[] = INITIAL_VILLAGER_SPAWNS
  ): Villager[] {
    return configs.map((cfg) => this.addVillager(cfg));
  }

  public addVillager(config: VillagerConfig): Villager {
    if (this.villagers.has(config.id)) {
      throw new Error(`Köylü kimliği zaten kullanımda: ${config.id}`);
    }

    this.nextVillagerNumber = Math.max(
      this.nextVillagerNumber,
      this.villagers.size + 2
    );

    const villager = new Villager(this.scene, this.isoGrid, config);
    for (const cam of this.ignoredWorldCameras) {
      villager.ignoreOnCamera(cam);
    }

    this.villagers.set(villager.id, villager);
    return villager;
  }

  // ---- Warrior (Kılıçlı Asker) üretim ve yönetimi ----

  public setBarracks(barracks: Barracks): void {
    this.barracks = barracks;
    this.registerGarrisonableBuilding(barracks);
    barracks.onTaskCompleted((task) => {
      if (task.id === BARRACKS_TRAIN_WARRIOR_TASK_ID) {
        this.spawnWarriorFromBarracks();
      }
    });
  }

  public addWarrior(config: WarriorConfig): Warrior {
    if (this.warriors.has(config.id) || this.villagers.has(config.id)) {
      throw new Error(`Birim kimliği zaten kullanımda: ${config.id}`);
    }
    this.nextWarriorNumber = Math.max(this.nextWarriorNumber, this.warriors.size + 2);
    const warrior = new Warrior(this.scene, this.isoGrid, config);
    for (const cam of this.ignoredWorldCameras) {
      warrior.ignoreOnCamera(cam);
    }
    this.warriors.set(warrior.id, warrior);
    return warrior;
  }

  public spawnWarriorFromBarracks(): Warrior {
    let serial = this.nextWarriorNumber;
    while (this.warriors.has(`warrior_${serial}`) || this.villagers.has(`warrior_${serial}`)) {
      serial += 1;
    }
    this.nextWarriorNumber = serial + 1;
    const building = this.barracks ?? this.townHall;
    const spawnSpots = this.findOpenSpawnSpotsForBatch(building, 1);
    const spawnSpot = spawnSpots[0];
    const newWarrior = this.addWarrior({
      id: `warrior_${serial}`,
      displayName: `Asker ${serial}`,
      col: spawnSpot.col,
      row: spawnSpot.row,
      initialFacingBack: false,
      initialFacingLeft: true,
    });
    const rally = (building as any).getRallyPoint ? (building as any).getRallyPoint() : null;
    if (rally) {
      const obstacleQuery = this.createObstacleQuery();
      const goal = this.findNearestValidGroundSpot(rally, obstacleQuery, new Set([newWarrior.id]), []);
      const path = findSmoothGridPath(spawnSpot, goal, obstacleQuery);
      if (path.length > 0) newWarrior.setMovePath(path);
    }
    this.spawnFloatingText(newWarrior.getWorldPosition().x, newWarrior.getWorldPosition().y - 38, `+1 ${newWarrior.displayName}`, '#38bdf8');
    return newWarrior;
  }

  public spawnWarriorFromTownHall(): Warrior {
    // legacy alias
    return this.spawnWarriorFromBarracks();
  }

  public spawnVillagerFromTownHall(): Villager {
    let serial = this.nextVillagerNumber;
    while (this.villagers.has(`villager_${serial}`)) {
      serial += 1;
    }
    this.nextVillagerNumber = serial + 1;

    const spawnSpots = this.findOpenSpawnSpotsForBatch(this.townHall, 1);
    const spawnSpot = spawnSpots[0];
    const newVillager = this.addVillager({
      id: `villager_${serial}`,
      displayName: `Köylü ${serial}`,
      col: spawnSpot.col,
      row: spawnSpot.row,
      initialFacingBack: false,
      initialFacingLeft: true,
    });

    const rally = this.townHall.getRallyPoint();
    if (rally) {
      const obstacleQuery = this.createObstacleQuery();
      const goal = this.findNearestValidGroundSpot(
        rally,
        obstacleQuery,
        new Set([newVillager.id]),
        []
      );
      const path = findSmoothGridPath(spawnSpot, goal, obstacleQuery);
      if (path.length > 0) {
        newVillager.setMovePath(path);
      }
    }

    this.spawnFloatingText(
      newVillager.getWorldPosition().x,
      newVillager.getWorldPosition().y - 38,
      `+1 ${newVillager.displayName}`,
      '#86efac'
    );
    return newVillager;
  }

  // --- Garnizon Giriş ve Çıkış Komutları ---

  /**
   * Seçili tüm birimlere (ve komutan varsa ona bağlı askerlere) belirtilen binaya
   * yürüyüp içeri girme emri verir.
   */
  public commandEnterSelectedIntoBuilding(
    buildingId: string = this.townHall.id
  ): boolean {
    const building = this.garrisonBuildings.get(buildingId);
    if (!building) {
      return false;
    }

    const rawSelected = this.getSelectedUnits() as any[];
    if (rawSelected.length === 0) {
      return false;
    }

    const marchingUnits = BuildingGarrisonController.expandWithCommanderRetinue(
      rawSelected as any,
      (id) => (this.villagers.get(id) ?? this.warriors.get(id)) as any
    );

    if (marchingUnits.length === 0) {
      return false;
    }

    const entranceSpots = building.getEntranceApproachSpots();
    const obstacleQuery = this.createObstacleQuery();
    let anyOrdered = false;

    for (let i = 0; i < marchingUnits.length; i += 1) {
      const unit = marchingUnits[i];
      if (!building.garrison.canAcceptUnit(unit)) {
        continue;
      }

      const startPos = unit.getGridPosition();
      if (building.isNearEntranceForEntry(startPos)) {
        this.finalizeUnitEnterBuilding(unit, building.id);
        anyOrdered = true;
        continue;
      }

      const targetEntrance = entranceSpots[i % entranceSpots.length];
      const waypoints = findSmoothGridPath(
        startPos,
        targetEntrance,
        obstacleQuery
      );
      unit.setEnterBuildingOrder(
        building.id,
        building.buildingName,
        waypoints,
        this.worldContext
      );
      anyOrdered = true;
    }

    if (anyOrdered && building.id === this.townHall.id) {
      const thPos = this.townHall.getWorldPosition();
      this.playOrderFeedback(thPos.x - 24, thPos.y + 18, 0xf59e0b);
    }

    return anyOrdered;
  }

  /**
   * Town Hall içinden belirli kimlikteki birimi veya sıradaki ilk birimi dışarı çıkarır.
   */
  public ejectOneFromTownHall(unitId?: string): Villager | null {
    if (this.townHall.garrison.getCount() === 0) {
      return null;
    }

    const spots = this.findOpenSpawnSpotsForBatch(this.townHall, 1);
    const ejected = unitId
      ? this.townHall.garrison.ejectUnit(unitId, spots[0])
      : this.townHall.garrison.ejectFirstUnit(spots[0]);

    if (!ejected) {
      return null;
    }

    this.townHall.playGarrisonPulse();
    const unit = this.villagers.get(ejected.id) ?? null;
    if (unit) {
      const pos = unit.getWorldPosition();
      this.spawnFloatingText(
        pos.x,
        pos.y - 36,
        `${unit.displayName} Çıktı`,
        '#fde68a'
      );
    }
    return unit;
  }

  /**
   * Town Hall içindeki tüm birimleri (50+ kişilik ordular dahil) bina önündeki
   * açık meydan noktalarına topluca dışarı çıkarır.
   */
  public ejectAllFromTownHall(): Villager[] {
    const count = this.townHall.garrison.getCount();
    if (count === 0) {
      return [];
    }

    const ejectedList = this.townHall.garrison.ejectAllUnits((n) =>
      this.findOpenSpawnSpotsForBatch(this.townHall, n)
    );

    if (ejectedList.length > 0) {
      this.townHall.playGarrisonPulse();
      const thPos = this.townHall.getWorldPosition();
      this.spawnFloatingText(
        thPos.x,
        thPos.y - 44,
        `${ejectedList.length} Birim Çıktı`,
        '#fde68a'
      );
    }

    const units: Villager[] = [];
    for (const item of ejectedList) {
      const v = this.villagers.get(item.id);
      if (v) {
        units.push(v);
      }
    }
    return units;
  }

  private finalizeUnitEnterBuilding(
    villager: Villager,
    buildingId: string
  ): boolean {
    const building = this.garrisonBuildings.get(buildingId);
    if (!building) {
      return false;
    }

    const entered = building.garrison.enterUnit(villager);
    if (!entered) {
      return false;
    }

    this.selectedVillagerIds.delete(villager.id);
    this.syncSelectionRings();

    if (building.id === this.townHall.id) {
      this.townHall.playGarrisonPulse();
      const thPos = this.townHall.getWorldPosition();
      this.spawnFloatingText(
        thPos.x - 18,
        thPos.y - 26,
        `${villager.displayName} Girdi`,
        '#93c5fd'
      );
    }

    return true;
  }

  // --- Seçim Metotları ---

  public selectSingleVillager(id: string): void {
    const unitV = this.villagers.get(id);
    const unitW = this.warriors.get(id);
    const unit = unitV ?? unitW;
    if (!unit || (unit as any).isGarrisoned()) {
      return;
    }
    if (this.barracks) this.barracks.setSelected(false);
    this.townHall.setSelected(false);
    this.selectedVillagerIds.clear();
    this.selectedWarriorIds.clear();
    if (unitV) this.selectedVillagerIds.add(id);
    else this.selectedWarriorIds.add(id);
    this.syncSelectionRings();
  }
  public selectSingleWarrior(id: string): void {
    this.selectSingleVillager(id);
  }
  public selectSingleUnit(id: string): void {
    this.selectSingleVillager(id);
  }

  public selectVillagers(ids: Iterable<string>, additive = false): void {
    if (!additive) {
      this.selectedVillagerIds.clear();
    }
    for (const id of ids) {
      const unit = this.villagers.get(id);
      if (unit && !unit.isGarrisoned()) {
        this.selectedVillagerIds.add(id);
      }
    }
    if (this.selectedVillagerIds.size > 0) {
      this.townHall.setSelected(false);
    }
    this.syncSelectionRings();
  }

  public toggleVillagerSelection(id: string): void {
    const unitV = this.villagers.get(id);
    const unitW = this.warriors.get(id);
    const unit = unitV ?? unitW;
    if (!unit || (unit as any).isGarrisoned()) return;
    const isVillager = !!unitV;
    const selectedSet = isVillager ? this.selectedVillagerIds : this.selectedWarriorIds;
    if (selectedSet.has(id)) {
      selectedSet.delete(id);
    } else {
      this.townHall.setSelected(false);
      if (this.barracks) this.barracks.setSelected(false);
      selectedSet.add(id);
    }
    this.syncSelectionRings();
  }
  public toggleUnitSelection(id: string): void {
    this.toggleVillagerSelection(id);
  }

  /**
   * Haritada dışarıda bulunan tüm köylüleri seçer (bina içindekiler hariç).
   */
  public selectAllVillagers(): void {
    if (this.barracks) this.barracks.setSelected(false);
    this.townHall.setSelected(false);
    this.selectedVillagerIds.clear();
    this.selectedWarriorIds.clear();
    for (const [id, unit] of this.villagers.entries()) {
      if (!unit.isGarrisoned()) {
        this.selectedVillagerIds.add(id);
      }
    }
    for (const [id, unit] of this.warriors.entries()) {
      if (!unit.isGarrisoned()) {
        this.selectedWarriorIds.add(id);
      }
    }
    this.syncSelectionRings();
  }
  public selectAllUnits(): void {
    this.selectAllVillagers();
  }

  public selectTownHall(): void {
    this.touchBoxSelectMode = false;
    this.selectedVillagerIds.clear();
    this.selectedWarriorIds.clear();
    this.syncSelectionRings();
    if (this.barracks) this.barracks.setSelected(false);
    this.townHall.setSelected(true);
  }
  public selectBarracks(): void {
    this.touchBoxSelectMode = false;
    this.selectedVillagerIds.clear();
    this.selectedWarriorIds.clear();
    this.syncSelectionRings();
    this.townHall.setSelected(false);
    if (this.barracks) this.barracks.setSelected(true);
  }
  public clearSelection(): void {
    this.selectedVillagerIds.clear();
    this.selectedWarriorIds.clear();
    this.townHall.setSelected(false);
    if (this.barracks) this.barracks.setSelected(false);
    this.syncSelectionRings();
  }



  public getSelectedVillagers(): Villager[] {
    const result: Villager[] = [];
    for (const id of this.selectedVillagerIds) {
      const unit = this.villagers.get(id);
      if (unit && !unit.isGarrisoned()) {
        result.push(unit);
      }
    }
    return result;
  }

  public getSelectedWarriors(): Warrior[] {
    const result: Warrior[] = [];
    for (const id of this.selectedWarriorIds) {
      const unit = this.warriors.get(id);
      if (unit && !unit.isGarrisoned()) {
        result.push(unit);
      }
    }
    return result;
  }

  public getSelectedUnits(): Array<Villager | Warrior> {
    return [...this.getSelectedVillagers(), ...this.getSelectedWarriors()];
  }

  public getSelectedCount(): number {
    return this.getSelectedVillagers().length + this.getSelectedWarriors().length;
  }

  public getAllVillagers(): Villager[] {
    return Array.from(this.villagers.values());
  }
  public getAllWarriors(): Warrior[] {
    return Array.from(this.warriors.values());
  }
  public getAllUnits(): Array<Villager | Warrior> {
    return [...this.getAllVillagers(), ...this.getAllWarriors()];
  }

  public getHudStatus(): VillagerHudStatus {
    let fieldCount = 0;
    let garrisonCount = 0;
    let workingCount = 0;
    let fieldWarriorCount = 0;
    let garrisonWarriorCount = 0;
    let totalWarriorCount = 0;

    for (const unit of this.villagers.values()) {
      if (unit.isGarrisoned()) {
        garrisonCount += 1;
      } else {
        fieldCount += 1;
        if (unit.getState() !== 'idle') {
          workingCount += 1;
        }
      }
    }
    for (const unit of this.warriors.values()) {
      totalWarriorCount += 1;
      if (unit.isGarrisoned()) {
        garrisonWarriorCount += 1;
      } else {
        fieldWarriorCount += 1;
        if (unit.getState() !== 'idle') {
          workingCount += 1;
        }
      }
    }

    const resolveTreeLabel = (treeId: string): string | null => {
      const tree = this.forestSystem.getTree(treeId);
      if (!tree) {
        return null;
      }
      const name = tree.treeType === 'cam' ? 'Çam' : 'Kayın';
      return `${name}: ${tree.woodAmount}/${tree.maxWoodAmount}`;
    };

    const selectedUnits = this.getSelectedUnits() as any[];
    let singleInfo: SingleUnitPanelInfo | null = null;
    let multiInfo: MultiSelectedHudInfo | null = null;

    if (selectedUnits.length === 1) {
      const u = selectedUnits[0];
      singleInfo = {
        id: u.id,
        displayName: u.displayName,
        unitTypeLabel: u.unitTypeLabel,
        category: u.unitCategory,
        hp: u.getHp(),
        maxHp: u.getMaxHp(),
        attackDamage: u.getAttackDamage(),
        defenseArmor: u.getDefenseArmor(),
        combatSystemActive: u.isCombatSystemActive(),
        nutrition: u.getNutritionState(),
        carriedResource: u.getCarriedResourceSummary(),
        taskDescription: u.getTaskDescription(resolveTreeLabel),
        state: u.getState(),
      };
    } else if (selectedUnits.length > 1) {
      let totalCarried = 0;
      let totalCap = 0;
      let chopping = 0;
      let moving = 0;
      const items: MultiSelectedUnitIconItem[] = [];

      for (const u of selectedUnits) {
        totalCarried += u.getCarriedWood();
        totalCap += u.getMaxWoodCapacity();
        if (u.getState() === 'chopping') {
          chopping += 1;
        } else if (u.isMoving()) {
          moving += 1;
        }

        const numMatch = /\d+$/.exec(u.id);
        items.push({
          id: u.id,
          displayName: u.displayName,
          shortTag: numMatch ? `#${numMatch[0]}` : u.displayName,
          category: u.unitCategory,
          hp: u.getHp(),
          maxHp: u.getMaxHp(),
          carriedWood: u.getCarriedWood(),
          state: u.getState(),
        });
      }

      multiInfo = {
        count: selectedUnits.length,
        totalCarriedWood: totalCarried,
        totalCapacity: totalCap,
        choppingCount: chopping,
        movingCount: moving,
        units: items,
      };
    }

    return {
      totalStoredWood: this.woodDepot.getStoredWood(),
      totalVillagersCount: this.villagers.size,
      fieldVillagersCount: fieldCount,
      garrisonedVillagersCount: garrisonCount,
      totalWarriorsCount: totalWarriorCount,
      fieldWarriorsCount: fieldWarriorCount,
      garrisonedWarriorsCount: garrisonWarriorCount,
      totalUnitsCount: this.villagers.size + this.warriors.size,
      fieldUnitsCount: fieldCount + fieldWarriorCount,
      workingVillagersCount: workingCount,
      remainingTreesCount: this.forestSystem.getAllTrees().length,
      selectedCount: selectedUnits.length,
      touchBoxSelectMode: this.touchBoxSelectMode,
      selectedUnit: singleInfo,
      multiSelected: multiInfo,
    };
  }

  // --- Kaynak Toplama, Teslim ve Yürüyüş Komutları ---

  public commandHarvestSelectedTree(tree: TreeResourceNode): boolean {
    const selected = this.getSelectedVillagers();
    if (selected.length === 0) {
      return false;
    }

    const obstacleQuery = this.createObstacleQuery();
    const sorted = [...selected].sort((a, b) => {
      const pa = a.getGridPosition();
      const pb = b.getGridPosition();
      return (
        Math.hypot(pa.col - tree.tile.col, pa.row - tree.tile.row) -
        Math.hypot(pb.col - tree.tile.col, pb.row - tree.tile.row)
      );
    });

    const selectedSet = new Set(sorted.map((u) => u.id));
    const reservedSpots: GridCoord[] = [];

    for (const unit of sorted) {
      const startPos = unit.getGridPosition();
      const distToTree = Math.hypot(
        startPos.col - tree.tile.col,
        startPos.row - tree.tile.row
      );

      if (
        distToTree >= 0.74 &&
        distToTree <= 1.1 &&
        !this.isSpotCrowded(unit.id, startPos, selectedSet, reservedSpots)
      ) {
        reservedSpots.push({ col: startPos.col, row: startPos.row });
        unit.setHarvestTreeOrder(tree.id, [], this.worldContext);
        continue;
      }

      const standSpot = this.computeBestStandSpot(
        unit.id,
        startPos,
        tree.tile,
        obstacleQuery,
        selectedSet,
        reservedSpots
      );

      if (standSpot) {
        reservedSpots.push(standSpot);
        const waypoints = findSmoothGridPath(startPos, standSpot, obstacleQuery);
        unit.setHarvestTreeOrder(tree.id, waypoints, this.worldContext);
      } else {
        unit.setHarvestTreeOrder(tree.id, [], this.worldContext);
      }
    }

    const treeWorld = this.isoGrid.tileToWorld(tree.tile.col, tree.tile.row);
    this.playOrderFeedback(treeWorld.x, treeWorld.y, 0xf59e0b);
    return true;
  }

  public commandDeliverSelectedToDepot(): boolean {
    const selected = this.getSelectedVillagers();
    if (selected.length === 0) {
      return false;
    }

    const depotTile = this.woodDepot.getTile();
    const obstacleQuery = this.createObstacleQuery();
    const sorted = [...selected].sort((a, b) => {
      const pa = a.getGridPosition();
      const pb = b.getGridPosition();
      return (
        Math.hypot(pa.col - depotTile.col, pa.row - depotTile.row) -
        Math.hypot(pb.col - depotTile.col, pb.row - depotTile.row)
      );
    });

    const selectedSet = new Set(sorted.map((u) => u.id));
    const reservedSpots: GridCoord[] = [];

    for (const unit of sorted) {
      const startPos = unit.getGridPosition();
      const standSpot = this.computeBestStandSpot(
        unit.id,
        startPos,
        depotTile,
        obstacleQuery,
        selectedSet,
        reservedSpots
      );
      if (standSpot) {
        reservedSpots.push(standSpot);
        const waypoints = findSmoothGridPath(startPos, standSpot, obstacleQuery);
        unit.setDeliverToDepotOrder(this.worldContext, waypoints);
      } else {
        unit.setDeliverToDepotOrder(this.worldContext);
      }
    }

    const depotWorld = this.woodDepot.getWorldPosition();
    this.playOrderFeedback(depotWorld.x, depotWorld.y, 0x38bdf8);
    return true;
  }

  public commandMoveSelectedToWorld(worldX: number, worldY: number): boolean {
    const selected = this.getSelectedUnits() as any[];
    if (selected.length === 0) {
      return false;
    }

    if (!this.isoGrid.isWorldPointOnMap(worldX, worldY)) {
      return false;
    }

    const rawTile = this.isoGrid.worldToTile(worldX, worldY);
    const obstacleQuery = this.createObstacleQuery();
    const selectedSet = new Set(selected.map((u) => u.id));

    const assignments = this.computeGroupFormationAssignments(
      selected,
      rawTile,
      obstacleQuery,
      selectedSet
    );

    let anyMoved = false;
    let feedbackGoal: GridCoord | null = null;
    for (const { unit, goal } of assignments) {
      const startPos = unit.getGridPosition();
      const waypoints = findSmoothGridPath(startPos, goal, obstacleQuery);
      if (waypoints.length > 0) {
        unit.setMovePath(waypoints);
        if (!feedbackGoal) {
          feedbackGoal = waypoints[waypoints.length - 1];
        }
        anyMoved = true;
      } else {
        unit.stopMovement();
      }
    }

    if (anyMoved && feedbackGoal) {
      const feedbackWorld = this.isoGrid.tileToWorld(
        feedbackGoal.col,
        feedbackGoal.row
      );
      this.playOrderFeedback(feedbackWorld.x, feedbackWorld.y, 0x4ade80);
    }

    return anyMoved;
  }

  private getWarriorWorldContext(): WarriorWorldContext {
    return {
      canEnterBuildingNow: (warrior, buildingId) => {
        const b = this.garrisonBuildings.get(buildingId);
        if (!b || !b.garrison.canAcceptUnit(warrior as any)) return false;
        return b.isNearEntranceForEntry(warrior.getGridPosition());
      },
      completeEnterBuilding: (warrior, buildingId) => this.finalizeWarriorEnterBuilding(warrior, buildingId),
      isFoodEconomyActive: () => false,
    };
  }

  private finalizeWarriorEnterBuilding(warrior: Warrior, buildingId: string): boolean {
    const building = this.garrisonBuildings.get(buildingId);
    if (!building) return false;
    const entered = building.garrison.enterUnit(warrior as any);
    if (!entered) return false;
    this.selectedWarriorIds.delete(warrior.id);
    this.syncSelectionRings();
    if (building.id === this.townHall.id) this.townHall.playGarrisonPulse();
    if (this.barracks && building.id === this.barracks.id) this.barracks.playGarrisonPulse();
    const pos = (building as any).getWorldPosition();
    this.spawnFloatingText(pos.x - 18, pos.y - 26, `${warrior.displayName} Girdi`, '#93c5fd');
    return true;
  }

  public update(deltaMs: number): void {
    for (const unit of this.villagers.values()) {
      unit.update(deltaMs, this.worldContext);
    }
    const wCtx = this.getWarriorWorldContext();
    for (const unit of this.warriors.values()) {
      unit.update(deltaMs, wCtx);
    }
    this.applyDynamicUnitSeparation(deltaMs);
  }

  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    this.ignoredWorldCameras.add(camera);
    camera.ignore(this.moveMarker);
    for (const unit of this.villagers.values()) {
      unit.ignoreOnCamera(camera);
    }
  }

  public destroy(): void {
    this.scene.input.off('pointerdown', this.handlePointerDown, this);
    this.scene.input.off('pointermove', this.handlePointerMove, this);
    this.scene.input.off('pointerup', this.handlePointerUp, this);
    this.scene.input.off('pointerupoutside', this.handlePointerUpOutside, this);
    this.scene.input.setDefaultCursor('default');
    this.moveMarkerTween?.stop();
    this.moveMarker.destroy();
    this.marqueeGraphics.destroy();
    for (const unit of this.villagers.values()) {
      unit.destroy();
    }
    this.villagers.clear();
    this.garrisonBuildings.clear();
    this.selectedVillagerIds.clear();
    this.ignoredWorldCameras.clear();
  }

  /**
   * 1'den 50+ birime kadar toplu çıkış veya üretim için çakışmayan açık noktalar üretir.
   */
  private findOpenSpawnSpotsForBatch(
    building: GarrisonableBuilding,
    count: number
  ): GridCoord[] {
    const reserved: GridCoord[] = [];
    const emptyIgnored = new Set<string>();
    const candidates = building.getSpawnCandidateSpots();

    for (const spot of candidates) {
      if (reserved.length >= count) {
        return reserved;
      }
      if (
        this.isContinuousPositionWalkable(spot.col, spot.row) &&
        !this.isSpotCrowded('', spot, emptyIgnored, reserved)
      ) {
        reserved.push({ col: spot.col, row: spot.row });
      }
    }

    // 50+ kişilik ordular çıktığında meydan halkalarını dışa doğru genişlet
    const plazaCenter = candidates[0] ?? { col: 10, row: 8.2 };
    for (let ring = 1; reserved.length < count && ring <= 14; ring += 1) {
      const radius = 0.72 * ring;
      const samples = Math.max(8, ring * 8);
      for (let s = 0; s < samples && reserved.length < count; s += 1) {
        const angle = (s / samples) * Math.PI * 2;
        const candidate = this.isoGrid.clampContinuousTile(
          plazaCenter.col + Math.cos(angle) * radius,
          plazaCenter.row + Math.sin(angle) * radius,
          0.3
        );
        if (
          this.isContinuousPositionWalkable(candidate.col, candidate.row) &&
          !this.isSpotCrowded('', candidate, emptyIgnored, reserved)
        ) {
          reserved.push(candidate);
        }
      }
    }

    while (reserved.length < count) {
      reserved.push({
        col: plazaCenter.col + ((reserved.length % 5) - 2) * 0.45,
        row: plazaCenter.row + Math.floor(reserved.length / 5) * 0.45,
      });
    }

    return reserved;
  }

  private syncSelectionRings(): void {
    for (const [vid, unit] of this.villagers.entries()) {
      unit.setSelected(this.selectedVillagerIds.has(vid) && !unit.isGarrisoned());
    }
    for (const [wid, unit] of this.warriors.entries()) {
      unit.setSelected(this.selectedWarriorIds.has(wid) && !unit.isGarrisoned());
    }
  }

  private applyDynamicUnitSeparation(deltaMs: number): void {
    const units = Array.from(this.villagers.values()).filter(
      (u) => !u.isGarrisoned()
    );
    if (units.length < 2) {
      return;
    }

    const dt = Math.min(deltaMs, 50) / 1000;
    const isWalkablePos = (col: number, row: number): boolean =>
      this.isContinuousPositionWalkable(col, row);

    const offsets = new Map<string, { dc: number; dr: number }>();
    for (const u of units) {
      offsets.set(u.id, { dc: 0, dr: 0 });
    }

    for (let i = 0; i < units.length; i += 1) {
      for (let j = i + 1; j < units.length; j += 1) {
        const a = units[i];
        const b = units[j];
        const posA = a.getGridPosition();
        const posB = b.getGridPosition();

        let dc = posA.col - posB.col;
        let dr = posA.row - posB.row;
        let dist = Math.hypot(dc, dr);

        if (dist >= DYNAMIC_SEPARATION_RADIUS) {
          continue;
        }

        if (dist < 0.001) {
          const fallbackAngle = (i * 2.1 + j * 1.3) % (Math.PI * 2);
          dc = Math.cos(fallbackAngle);
          dr = Math.sin(fallbackAngle);
          dist = 1;
        } else {
          dc /= dist;
          dr /= dist;
        }

        const overlap = DYNAMIC_SEPARATION_RADIUS - dist;
        const overlapRatio = overlap / DYNAMIC_SEPARATION_RADIUS;
        const pushMagnitude = Math.min(
          overlap * 0.48,
          2.4 * (0.35 + overlapRatio) * dt
        );

        const aMoving = a.isMoving();
        const bMoving = b.isMoving();
        const aChopping = a.getState() === 'chopping';
        const bChopping = b.getState() === 'chopping';

        let weightA = 0.5;
        let weightB = 0.5;

        if (aMoving && !bMoving) {
          weightA = 1.0;
          weightB = 0.0;
        } else if (!aMoving && bMoving) {
          weightA = 0.0;
          weightB = 1.0;
        } else if (aChopping && bChopping) {
          weightA = 0.15;
          weightB = 0.15;
        } else if (aChopping && !bMoving) {
          weightA = 0.0;
          weightB = 1.0;
        } else if (bChopping && !aMoving) {
          weightA = 1.0;
          weightB = 0.0;
        }

        const offA = offsets.get(a.id)!;
        const offB = offsets.get(b.id)!;

        offA.dc += dc * pushMagnitude * weightA;
        offA.dr += dr * pushMagnitude * weightA;
        offB.dc -= dc * pushMagnitude * weightB;
        offB.dr -= dr * pushMagnitude * weightB;
      }
    }

    for (const u of units) {
      const off = offsets.get(u.id)!;
      u.applySeparationOffset(off.dc, off.dr, isWalkablePos);
    }
  }

  private isContinuousPositionWalkable(col: number, row: number): boolean {
    const cols = this.isoGrid.getCols();
    const rows = this.isoGrid.getRows();
    if (col < 0.25 || col > cols - 1.25 || row < 0.25 || row > rows - 1.25) {
      return false;
    }

    const minC = Math.max(0, Math.floor(col) - 1);
    const maxC = Math.min(cols - 1, Math.ceil(col) + 1);
    const minR = Math.max(0, Math.floor(row) - 1);
    const maxR = Math.min(rows - 1, Math.ceil(row) + 1);

    for (let r = minR; r <= maxR; r += 1) {
      for (let c = minC; c <= maxC; c += 1) {
        const blocked =
          this.forestSystem.getTreeAt(c, r) !== undefined ||
          this.woodDepot.occupiesTile(c, r) ||
          this.townHall.occupiesTile(c, r);
        if (blocked && Math.hypot(col - c, row - r) < 0.76) {
          return false;
        }
      }
    }

    return true;
  }

  private computeGroupFormationAssignments(
    units: Array<any>,
    rawCenter: GridCoord,
    grid: GridObstacleQuery,
    movingIds: ReadonlySet<string>
  ): Array<{ unit: Villager; goal: GridCoord }> {
    const center = this.isoGrid.clampContinuousTile(
      rawCenter.col,
      rawCenter.row,
      0.28
    );

    if (units.length === 1) {
      const singleGoal = this.findNearestValidGroundSpot(
        center,
        grid,
        movingIds,
        []
      );
      return [{ unit: units[0], goal: singleGoal }];
    }

    let avgCol = 0;
    let avgRow = 0;
    for (const u of units) {
      const p = u.getGridPosition();
      avgCol += p.col;
      avgRow += p.row;
    }
    avgCol /= units.length;
    avgRow /= units.length;

    let fwdC = center.col - avgCol;
    let fwdR = center.row - avgRow;
    const fwdLen = Math.hypot(fwdC, fwdR);
    if (fwdLen > 0.05) {
      fwdC /= fwdLen;
      fwdR /= fwdLen;
    } else {
      fwdC = 0.7071;
      fwdR = 0.7071;
    }

    const rightC = -fwdR;
    const rightR = fwdC;

    const count = units.length;
    const colsPerRow = Math.min(4, Math.max(3, Math.ceil(Math.sqrt(count))));
    const totalRows = Math.ceil(count / colsPerRow);

    const slots: GridCoord[] = [];
    for (let idx = 0; idx < count; idx += 1) {
      const rIdx = Math.floor(idx / colsPerRow);
      const itemsInThisRow =
        rIdx === totalRows - 1 ? count - rIdx * colsPerRow : colsPerRow;
      const cIdx = idx - rIdx * colsPerRow;

      const lateralOffset =
        (cIdx - (itemsInThisRow - 1) * 0.5) * FORMATION_SPACING;
      const depthOffset =
        (rIdx - (totalRows - 1) * 0.5) * (FORMATION_SPACING * 0.92);

      const desiredSlot: GridCoord = {
        col: center.col + rightC * lateralOffset - fwdC * depthOffset,
        row: center.row + rightR * lateralOffset - fwdR * depthOffset,
      };

      const validSlot = this.findNearestValidGroundSpot(
        desiredSlot,
        grid,
        movingIds,
        slots
      );
      slots.push(validSlot);
    }

    const sortedUnits = [...units].sort((a, b) => {
      const pa = a.getGridPosition();
      const pb = b.getGridPosition();
      return (
        pa.col * rightC + pa.row * rightR - (pb.col * rightC + pb.row * rightR)
      );
    });

    const sortedSlots = [...slots].sort(
      (a, b) =>
        a.col * rightC + a.row * rightR - (b.col * rightC + b.row * rightR)
    );

    return sortedUnits.map((unit, index) => ({
      unit,
      goal: sortedSlots[index],
    }));
  }

  private findNearestValidGroundSpot(
    desired: GridCoord,
    grid: GridObstacleQuery,
    ignoredVillagerIds: ReadonlySet<string>,
    reservedSpots: readonly GridCoord[]
  ): GridCoord {
    const base = this.isoGrid.clampContinuousTile(
      desired.col,
      desired.row,
      0.28
    );

    const isAcceptable = (pt: GridCoord): boolean => {
      const tc = Math.round(pt.col);
      const tr = Math.round(pt.row);
      if (grid.isTileBlocked(tc, tr)) {
        return false;
      }
      if (!this.isContinuousPositionWalkable(pt.col, pt.row)) {
        return false;
      }
      return !this.isSpotCrowded('', pt, ignoredVillagerIds, reservedSpots);
    };

    if (isAcceptable(base)) {
      return base;
    }

    const radii = [0.68, 1.15, 1.65, 2.2, 2.8, 3.5];
    const angles = [0, 45, -45, 90, -90, 135, -135, 180];
    for (const radius of radii) {
      for (const deg of angles) {
        const rad = Phaser.Math.DegToRad(deg);
        const candidate = this.isoGrid.clampContinuousTile(
          base.col + Math.cos(rad) * radius,
          base.row + Math.sin(rad) * radius,
          0.28
        );
        if (isAcceptable(candidate)) {
          return candidate;
        }
      }
    }

    return base;
  }

  private createObstacleQuery(): GridObstacleQuery {
    return {
      cols: this.isoGrid.getCols(),
      rows: this.isoGrid.getRows(),
      isTileBlocked: (col: number, row: number) =>
        !this.isoGrid.isInBounds(col, row) ||
        this.forestSystem.getTreeAt(col, row) !== undefined ||
        this.woodDepot.occupiesTile(col, row) ||
        this.townHall.occupiesTile(col, row),
    };
  }

  private buildPathToTileAdjacent(
    requester: Villager,
    targetTile: GridCoord
  ): GridCoord[] {
    const obstacleQuery = this.createObstacleQuery();
    const fromPos = requester.getGridPosition();
    const standSpot = this.computeBestStandSpot(
      requester.id,
      fromPos,
      targetTile,
      obstacleQuery,
      new Set([requester.id]),
      []
    );
    if (!standSpot) {
      return [];
    }
    return findSmoothGridPath(fromPos, standSpot, obstacleQuery);
  }

  private computeBestStandSpot(
    requesterId: string,
    fromPos: GridCoord,
    targetTile: GridCoord,
    grid: GridObstacleQuery,
    ignoredIds: ReadonlySet<string>,
    reservedSpots: readonly GridCoord[]
  ): GridCoord | null {
    const tc = targetTile.col;
    const tr = targetTile.row;

    const candidateDirs: ReadonlyArray<{
      dc: number;
      dr: number;
      bias: number;
    }> = [
      { dc: -1, dr: 0, bias: 0 },
      { dc: 0, dr: 1, bias: 0 },
      { dc: 1, dr: 0, bias: 0 },
      { dc: 0, dr: -1, bias: 0 },
      { dc: -1, dr: 1, bias: 0.32 },
      { dc: 1, dr: -1, bias: 0.32 },
      { dc: 1, dr: 1, bias: 0.42 },
      { dc: -1, dr: -1, bias: 0.42 },
    ];

    let bestSpot: GridCoord | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const { dc, dr, bias } of candidateDirs) {
      const neighborCol = tc + dc;
      const neighborRow = tr + dr;
      if (grid.isTileBlocked(neighborCol, neighborRow)) {
        continue;
      }

      const len = Math.hypot(dc, dr);
      const standRadius = this.woodDepot.occupiesTile(tc, tr)
        ? 1.02
        : INTERACT_STAND_RADIUS;
      const spotCol = tc + (dc / len) * standRadius;
      const spotRow = tr + (dr / len) * standRadius;

      const dist = Math.hypot(spotCol - fromPos.col, spotRow - fromPos.row);
      const crowded = this.isSpotCrowded(
        requesterId,
        { col: spotCol, row: spotRow },
        ignoredIds,
        reservedSpots
      );
      const crowdPenalty = crowded ? 6.0 : 0;

      const score = dist + bias + crowdPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestSpot = { col: spotCol, row: spotRow };
      }
    }

    return bestSpot;
  }

  private isSpotCrowded(
    requesterId: string,
    spot: GridCoord,
    ignoredIds: ReadonlySet<string>,
    reservedSpots: readonly GridCoord[]
  ): boolean {
    for (const rSpot of reservedSpots) {
      if (
        Math.hypot(rSpot.col - spot.col, rSpot.row - spot.row) <
          MIN_VILLAGER_SEPARATION
      ) {
        return true;
      }
    }

    for (const [vid, other] of this.villagers.entries()) {
      if (vid === requesterId || ignoredIds.has(vid) || other.isGarrisoned()) {
        continue;
      }
      const pos = other.getGridPosition();
      if (!other.isMoving() && Math.hypot(pos.col - spot.col, pos.row - spot.row) < MIN_VILLAGER_SEPARATION) {
        return true;
      }
      const target = (other as any).getTargetPosition ? (other as any).getTargetPosition() : null;
      if (target && Math.hypot(target.col - spot.col, target.row - spot.row) < MIN_VILLAGER_SEPARATION) {
        return true;
      }
    }
    for (const [wid, other] of this.warriors.entries()) {
      if (wid === requesterId || ignoredIds.has(wid) || other.isGarrisoned()) continue;
      const pos = other.getGridPosition();
      if (!other.isMoving() && Math.hypot(pos.col - spot.col, pos.row - spot.row) < MIN_VILLAGER_SEPARATION) return true;
      const target = (other as any).getTargetPosition ? (other as any).getTargetPosition() : null;
      if (target && Math.hypot(target.col - spot.col, target.row - spot.row) < MIN_VILLAGER_SEPARATION) return true;
    }
    return false;
  }

  private bindInputEvents(): void {
    this.scene.input.mouse?.disableContextMenu();
    this.scene.input.on('pointerdown', this.handlePointerDown, this);
    this.scene.input.on('pointermove', this.handlePointerMove, this);
    this.scene.input.on('pointerup', this.handlePointerUp, this);
    this.scene.input.on('pointerupoutside', this.handlePointerUpOutside, this);
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.isScreenUiBlocked?.(pointer.x, pointer.y)) {
      this.cancelMarqueeDrag();
      return;
    }

    if (this.scene.input.pointer1?.isDown && this.scene.input.pointer2?.isDown) {
      this.cancelMarqueeDrag();
      return;
    }

    const isTouch = pointer.wasTouch;
    const canStartDesktopMarquee =
      !isTouch &&
      pointer.button === 0 &&
      !this.cameraController.isSpacePanHeld();
    const canStartTouchMarquee = isTouch && this.touchBoxSelectMode;

    if (canStartDesktopMarquee || canStartTouchMarquee) {
      this.isMarqueeCandidate = true;
      this.isMarqueeDragging = false;
      this.marqueePointerId = pointer.id;
      this.marqueeStartX = pointer.x;
      this.marqueeStartY = pointer.y;
      const shiftHeld = Boolean(
        (pointer.event as MouseEvent | undefined)?.shiftKey
      );
      this.marqueeAdditive = shiftHeld;
      this.marqueeBaseSelection = new Set(
        shiftHeld ? [...this.selectedVillagerIds, ...this.selectedWarriorIds] : []
      );
    }
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.scene.input.pointer1?.isDown && this.scene.input.pointer2?.isDown) {
      if (this.isMarqueeCandidate || this.isMarqueeDragging) {
        this.cancelMarqueeDrag();
      }
      return;
    }

    if (
      this.isMarqueeCandidate &&
      pointer.isDown &&
      pointer.id === this.marqueePointerId
    ) {
      const dist = Phaser.Math.Distance.Between(
        this.marqueeStartX,
        this.marqueeStartY,
        pointer.x,
        pointer.y
      );

      if (!this.isMarqueeDragging && dist >= MARQUEE_DRAG_THRESHOLD_PX) {
        this.isMarqueeDragging = true;
      }

      if (this.isMarqueeDragging) {
        this.drawAndApplyMarquee(
          this.marqueeStartX,
          this.marqueeStartY,
          pointer.x,
          pointer.y
        );
        return;
      }
    }

    if (!pointer.wasTouch && !pointer.isDown) {
      this.updateHoverCursor(pointer);
    }
  }

  private handlePointerUpOutside(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.marqueePointerId) {
      this.finishMarqueeIfActive(pointer.wasTouch);
    }
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.marqueePointerId && this.isMarqueeDragging) {
      this.drawAndApplyMarquee(
        this.marqueeStartX,
        this.marqueeStartY,
        pointer.x,
        pointer.y
      );
      this.finishMarqueeIfActive(pointer.wasTouch);
      return;
    }

    this.cancelMarqueeDrag();

    if (this.isScreenUiBlocked?.(pointer.x, pointer.y)) {
      return;
    }

    if (this.cameraController.wasPointerGestureDragged()) {
      return;
    }

    const worldPt = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const isTouch = pointer.wasTouch;
    const hitUnit = this.pickBestVillagerAt(worldPt.x, worldPt.y, isTouch) as any;
    const hitVillager = hitUnit;
    const hitTownHall = this.townHall.containsWorldPoint(worldPt.x, worldPt.y, isTouch);
    const hitBarracks = this.barracks ? this.barracks.containsWorldPoint(worldPt.x, worldPt.y, isTouch) : false;
    void hitBarracks;
    const now = this.scene.time.now;
    const activeSelectedCount = this.getSelectedCount();

    if (isTouch) {
      // MOBİL DOKUNMATİK KONTROLLER:
      if (this.touchBoxSelectMode) {
        if (hitVillager) {
          this.toggleVillagerSelection(hitVillager.id);
        }
        return;
      }

      if (hitVillager) {
        if (
          this.lastTappedVillagerId === hitVillager.id &&
          now - this.lastVillagerTapTime <= DOUBLE_TAP_WINDOW_MS
        ) {
          this.selectAllVillagers();
          this.lastTappedVillagerId = null;
        } else {
          this.selectSingleVillager(hitVillager.id);
          this.lastTappedVillagerId = hitVillager.id;
          this.lastVillagerTapTime = now;
        }
        return;
      }

      if (hitTownHall || hitBarracks) {
        const targetBuilding = hitBarracks && this.barracks ? this.barracks : this.townHall;
        if (activeSelectedCount > 0) {
          this.commandEnterSelectedIntoBuilding(targetBuilding.id);
        } else {
          if (hitBarracks && this.barracks) this.selectBarracks();
          else this.selectTownHall();
        }
        return;
      }

      if (activeSelectedCount > 0) {
        const hitTree = this.forestSystem.pickTreeAtWorld(
          worldPt.x,
          worldPt.y,
          true
        );
        if (hitTree) {
          this.commandHarvestSelectedTree(hitTree);
          return;
        }

        if (this.woodDepot.containsWorldPoint(worldPt.x, worldPt.y, true)) {
          this.commandDeliverSelectedToDepot();
          return;
        }

        if (this.isoGrid.isWorldPointOnMap(worldPt.x, worldPt.y)) {
          this.commandMoveSelectedToWorld(worldPt.x, worldPt.y);
        } else {
          this.clearSelection();
        }
      } else if (this.townHall.isSelected()) {
        this.townHall.setSelected(false);
      }
      return;
    }

    // MASAÜSTÜ FARE KONTROLLERİ:
    const isRightClick = pointer.button === 2 || pointer.rightButtonReleased();
    const isLeftClick =
      pointer.button === 0 &&
      !isRightClick &&
      !this.cameraController.isSpacePanHeld();

    if (isLeftClick) {
      const shiftHeld = Boolean(
        (pointer.event as MouseEvent | undefined)?.shiftKey
      );

      if (hitVillager) {
        if (shiftHeld) {
          this.toggleVillagerSelection(hitVillager.id);
        } else if (
          this.lastTappedVillagerId === hitVillager.id &&
          now - this.lastVillagerTapTime <= DOUBLE_TAP_WINDOW_MS
        ) {
          this.selectAllVillagers();
          this.lastTappedVillagerId = null;
        } else {
          this.selectSingleVillager(hitVillager.id);
          this.lastTappedVillagerId = hitVillager.id;
          this.lastVillagerTapTime = now;
        }
      } else if (hitBarracks && !shiftHeld && this.barracks) {
        this.selectBarracks();
      } else if (hitTownHall && !shiftHeld) {
        this.selectTownHall();
      } else if (!shiftHeld) {
        this.clearSelection();
      }
      return;
    }

    if (isRightClick && activeSelectedCount > 0) {
      if (hitBarracks && this.barracks) {
        this.commandEnterSelectedIntoBuilding(this.barracks.id);
        return;
      }
      if (hitTownHall) {
        this.commandEnterSelectedIntoBuilding(this.townHall.id);
        return;
      }

      const hitTree = this.forestSystem.pickTreeAtWorld(
        worldPt.x,
        worldPt.y,
        false
      );
      if (hitTree) {
        this.commandHarvestSelectedTree(hitTree);
        return;
      }

      if (this.woodDepot.containsWorldPoint(worldPt.x, worldPt.y, false)) {
        this.commandDeliverSelectedToDepot();
        return;
      }

      this.commandMoveSelectedToWorld(worldPt.x, worldPt.y);
    }
  }

  private drawAndApplyMarquee(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): void {
    const minScreenX = Math.min(x1, x2);
    const minScreenY = Math.min(y1, y2);
    const maxScreenX = Math.max(x1, x2);
    const maxScreenY = Math.max(y1, y2);
    const rectW = Math.max(1, maxScreenX - minScreenX);
    const rectH = Math.max(1, maxScreenY - minScreenY);

    this.marqueeGraphics.clear();
    this.marqueeGraphics.fillStyle(0x22c55e, 0.16);
    this.marqueeGraphics.fillRect(minScreenX, minScreenY, rectW, rectH);
    this.marqueeGraphics.lineStyle(1.5, 0x4ade80, 0.95);
    this.marqueeGraphics.strokeRect(minScreenX, minScreenY, rectW, rectH);
    this.marqueeGraphics.setVisible(true);

    const cam = this.scene.cameras.main;
    const worldTopLeft = cam.getWorldPoint(minScreenX, minScreenY);
    const worldBottomRight = cam.getWorldPoint(maxScreenX, maxScreenY);

    const wMinX = Math.min(worldTopLeft.x, worldBottomRight.x);
    const wMaxX = Math.max(worldTopLeft.x, worldBottomRight.x);
    const wMinY = Math.min(worldTopLeft.y, worldBottomRight.y);
    const wMaxY = Math.max(worldTopLeft.y, worldBottomRight.y);

    const nextSelection = new Set<string>(
      this.marqueeAdditive ? this.marqueeBaseSelection : []
    );

    for (const [id, unit] of this.villagers.entries()) {
      if (!unit.isGarrisoned() && unit.intersectsWorldRect(wMinX, wMinY, wMaxX, wMaxY)) {
        nextSelection.add(id);
      }
    }
    for (const [id, unit] of this.warriors.entries()) {
      if (!unit.isGarrisoned() && (unit as any).intersectsWorldRect(wMinX, wMinY, wMaxX, wMaxY)) {
        nextSelection.add(id);
      }
    }
    this.selectedVillagerIds.clear();
    this.selectedWarriorIds.clear();
    for (const id of nextSelection) {
      if (this.villagers.has(id)) this.selectedVillagerIds.add(id);
      else if (this.warriors.has(id)) this.selectedWarriorIds.add(id);
    }
    if (this.selectedVillagerIds.size > 0 || this.selectedWarriorIds.size > 0) {
      this.townHall.setSelected(false);
      if (this.barracks) this.barracks.setSelected(false);
    }
    this.syncSelectionRings();
  }

  private finishMarqueeIfActive(wasTouch: boolean): void {
    const hadBoxSelection =
      this.isMarqueeDragging && this.selectedVillagerIds.size > 0;
    this.cancelMarqueeDrag();

    if (wasTouch && this.touchBoxSelectMode && hadBoxSelection) {
      this.touchBoxSelectMode = false;
    }
  }

  private cancelMarqueeDrag(): void {
    this.isMarqueeCandidate = false;
    this.isMarqueeDragging = false;
    this.marqueePointerId = -1;
    this.marqueeAdditive = false;
    this.marqueeBaseSelection.clear();
    this.marqueeGraphics.clear();
    this.marqueeGraphics.setVisible(false);
  }

  private updateHoverCursor(pointer: Phaser.Input.Pointer): void {
    if (this.isScreenUiBlocked?.(pointer.x, pointer.y)) {
      this.scene.input.setDefaultCursor('pointer');
      return;
    }

    const worldPt = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const hoveredVillager = this.pickBestVillagerAt(
      worldPt.x,
      worldPt.y,
      false
    );
    if (
      hoveredVillager ||
      this.townHall.containsWorldPoint(worldPt.x, worldPt.y, false)
    ) {
      this.scene.input.setDefaultCursor('pointer');
      return;
    }

    if (this.getSelectedCount() > 0) {
      const hoveredTree = this.forestSystem.pickTreeAtWorld(
        worldPt.x,
        worldPt.y,
        false
      );
      if (
        hoveredTree ||
        this.woodDepot.containsWorldPoint(worldPt.x, worldPt.y, false)
      ) {
        this.scene.input.setDefaultCursor('pointer');
        return;
      }
    }

    this.scene.input.setDefaultCursor('default');
  }

  private pickBestVillagerAt(
    worldX: number,
    worldY: number,
    isTouch: boolean
  ): Villager | Warrior | undefined {
    let best: Villager | Warrior | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    let bestY = Number.NEGATIVE_INFINITY;
    const allUnits: Array<Villager | Warrior> = [...this.villagers.values(), ...this.warriors.values()] as any;
    for (const unit of allUnits) {
      if ((unit as any).isGarrisoned() || !(unit as any).containsWorldPoint(worldX, worldY, isTouch)) {
        continue;
      }
      const dist = (unit as any).distanceToBodyCenter(worldX, worldY);
      const posY = (unit as any).getWorldPosition().y;
      if (!best || dist < bestDist - 3.5 || (Math.abs(dist - bestDist) <= 3.5 && posY >= bestY)) {
        best = unit as any;
        bestDist = dist;
        bestY = posY;
      }
    }
    return best as any;
  }
  // @ts-ignore - helper for future use
  private pickBestUnitAt(worldX: number, worldY: number, isTouch: boolean): Villager | Warrior | undefined {
    return this.pickBestVillagerAt(worldX, worldY, isTouch);
  }

  private playOrderFeedback(
    worldX: number,
    worldY: number,
    strokeColor: number
  ): void {
    this.moveMarkerTween?.stop();
    this.moveMarker.clear();
    this.moveMarker.lineStyle(1.4, strokeColor, 0.92);
    this.moveMarker.strokeEllipse(0, 0, 18, 9);

    this.moveMarker.setPosition(worldX, worldY);
    this.moveMarker.setScale(0.55);
    this.moveMarker.setAlpha(0.95);
    this.moveMarker.setVisible(true);

    this.moveMarkerTween = this.scene.tweens.add({
      targets: this.moveMarker,
      scaleX: 1.25,
      scaleY: 1.25,
      alpha: 0,
      duration: 340,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.moveMarker.setVisible(false);
      },
    });
  }

  private spawnWoodHarvestPop(
    villager: Villager,
    result: WoodHarvestResult
  ): void {
    const vPos = villager.getWorldPosition();
    this.spawnFloatingText(
      vPos.x,
      vPos.y - 36,
      `+${result.harvested}`,
      '#fcd34d',
      500
    );
  }

  private spawnWoodDepositPop(depositedAmount: number): void {
    const dPos = this.woodDepot.getWorldPosition();
    this.spawnFloatingText(
      dPos.x,
      dPos.y - 34,
      `+${depositedAmount} Depo`,
      '#4ade80',
      750
    );
  }

  private spawnFloatingText(
    worldX: number,
    worldY: number,
    message: string,
    color: string,
    duration = 800
  ): void {
    const popText = this.scene.add
      .text(worldX, worldY, message, {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '11.5px',
        fontStyle: 'bold',
        color,
        stroke: '#141e18',
        strokeThickness: 2.8,
      })
      .setOrigin(0.5, 1)
      .setDepth(worldY + 2400);

    for (const cam of this.ignoredWorldCameras) {
      cam.ignore(popText);
    }

    this.scene.tweens.add({
      targets: popText,
      y: worldY - 16,
      alpha: 0,
      duration,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        popText.destroy();
      },
    });
  }
}
