/**
 * Karahanlı RTS — Küçük Orman ve Odun Kaynağı Altyapısı (ForestSystem)
 *
 * 16x16 harita üzerindeki kayın ve çam ağaçlarını odun kaynağı düğümleri
 * (TreeResourceNode) olarak yönetir. Her ağaç benzersiz kimlik, tür, ızgara
 * koordinatı ve odun miktarı (100) bilgisiyle tutulur; ileride köylülerin
 * odun toplaması ve tükenen ağaçların haritadan kaldırılması için hazırdır.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';

/** Desteklenen ağaç türleri */
export type TreeType = 'kayin' | 'cam';

/** Her ağacın başlangıç odun kaynağı miktarı */
export const INITIAL_WOOD_AMOUNT = 100;

interface TreeVisualSpec {
  textureKey: string;
  assetPath: string;
  /** Kök tabanının yatay merkez oranı (0..1) */
  originX: number;
  /** Köklerin çimene temas ettiği dikey taban oranı (0..1) */
  originY: number;
  defaultScale: number;
}

const TREE_SPECS: Record<TreeType, TreeVisualSpec> = {
  kayin: {
    textureKey: 'tree_kayin',
    assetPath: 'assets/sprites/steppe_tree.png',
    originX: 111 / 230,
    originY: 182 / 202,
    defaultScale: 0.54,
  },
  cam: {
    textureKey: 'tree_cam',
    assetPath: 'assets/sprites/pine_tree.png',
    originX: 65 / 129,
    originY: 207 / 228,
    defaultScale: 0.6,
  },
};

/** Haritaya yerleştirilecek bir ağacın başlangıç tanımı */
export interface TreeSpawnConfig {
  id: string;
  treeType: TreeType;
  col: number;
  row: number;
  woodAmount?: number;
  scale?: number;
}

/** Sahnedeki canlı bir ağaç/odun kaynağı düğümü */
export interface TreeResourceNode {
  readonly id: string;
  readonly treeType: TreeType;
  woodAmount: number;
  readonly maxWoodAmount: number;
  readonly tile: { col: number; row: number };
  readonly scale: number;
  readonly sprite: Phaser.GameObjects.Image;
}

/**
 * 16x16 haritanın kuzeybatı iç çayırında doğal bir koruluk (pocket woodland) yerleşimi:
 * - 2 kayın + 2 çam ağacı üst kenara duvar gibi dizilmeden organik üçgen/elmas küme oluşturur
 * - Ağaçların arasında köylülerin rahatça yürüyebileceği 1-2 karoluk doğal açıklıklar bulunur
 * - Haritanın geniş orta, doğu ve güney düzlükleri (col 6..15, row 3..15) tamamen açıktır
 */
export const INITIAL_FOREST_LAYOUT: readonly TreeSpawnConfig[] = [
  { id: 'wood_cam_1', treeType: 'cam', col: 4, row: 4, scale: 0.62 },
  { id: 'wood_kayin_1', treeType: 'kayin', col: 2, row: 6, scale: 0.55 },
  { id: 'wood_cam_2', treeType: 'cam', col: 5, row: 7, scale: 0.59 },
  { id: 'wood_kayin_2', treeType: 'kayin', col: 3, row: 9, scale: 0.53 },
];

export class ForestSystem {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly nodesById = new Map<string, TreeResourceNode>();
  private readonly nodesByTile = new Map<string, TreeResourceNode>();
  private readonly ignoredCameras = new Set<Phaser.Cameras.Scene2D.Camera>();

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid) {
    this.scene = scene;
    this.isoGrid = isoGrid;
  }

  /**
   * Kayın ve çam ağacı görsellerini Phaser önbelleğine yükler.
   */
  public static preload(scene: Phaser.Scene): void {
    for (const spec of Object.values(TREE_SPECS)) {
      scene.load.image(spec.textureKey, spec.assetPath);
    }
  }

  /**
   * Verilen ağaç listesini (varsayılan: 2 kayın + 2 çam koruluğu) haritaya yerleştirir.
   */
  public populate(layout: readonly TreeSpawnConfig[] = INITIAL_FOREST_LAYOUT): void {
    for (const item of layout) {
      this.addTree(item);
    }
  }

  /**
   * Tek bir ağacı izometrik karoya yerleştirir ve odun kaynağı olarak kaydeder.
   */
  public addTree(config: TreeSpawnConfig): TreeResourceNode {
    const key = this.tileKey(config.col, config.row);
    if (this.nodesById.has(config.id)) {
      throw new Error(`Ağaç kimliği zaten kullanımda: ${config.id}`);
    }
    if (this.nodesByTile.has(key)) {
      throw new Error(`(${config.col}, ${config.row}) karosunda zaten bir ağaç bulunuyor.`);
    }

    const spec = TREE_SPECS[config.treeType];
    const worldPos = this.isoGrid.tileToWorld(config.col, config.row);
    const scale = config.scale ?? spec.defaultScale;
    const initialWood = config.woodAmount ?? INITIAL_WOOD_AMOUNT;

    const sprite = this.scene.add.image(worldPos.x, worldPos.y, spec.textureKey);
    sprite.setOrigin(spec.originX, spec.originY);
    sprite.setScale(scale);
    sprite.setDepth(this.isoGrid.getTileDepth(config.col, config.row));

    for (const cam of this.ignoredCameras) {
      cam.ignore(sprite);
    }

    const node: TreeResourceNode = {
      id: config.id,
      treeType: config.treeType,
      woodAmount: initialWood,
      maxWoodAmount: initialWood,
      tile: { col: config.col, row: config.row },
      scale,
      sprite,
    };

    this.nodesById.set(node.id, node);
    this.nodesByTile.set(key, node);
    return node;
  }

  /**
   * Belirtilen kameranın (ör. sabit arayüz/HUD kamerası) ağaç sprite'larını
   * çizmemesini sağlar; sonradan eklenecek ağaçlara da otomatik uygulanır.
   */
  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    this.ignoredCameras.add(camera);
    for (const node of this.nodesById.values()) {
      camera.ignore(node.sprite);
    }
  }

  /**
   * Kimliği verilen ağacı sahneden ve veri yapısından güvenli şekilde kaldırır.
   * (İleride odun miktarı 0'a düştüğünde doğrudan çağrılabilir.)
   */
  public removeTree(id: string): boolean {
    const node = this.nodesById.get(id);
    if (!node) {
      return false;
    }

    node.sprite.destroy();
    this.nodesById.delete(id);
    this.nodesByTile.delete(this.tileKey(node.tile.col, node.tile.row));
    return true;
  }

  /**
   * Verilen karodaki ağacı kaldırır.
   */
  public removeTreeAt(col: number, row: number): boolean {
    const node = this.getTreeAt(col, row);
    return node ? this.removeTree(node.id) : false;
  }

  /** Kimliğe göre ağaç kaynağını döner. */
  public getTree(id: string): TreeResourceNode | undefined {
    return this.nodesById.get(id);
  }

  /** Karo koordinatına göre ağaç kaynağını döner. */
  public getTreeAt(col: number, row: number): TreeResourceNode | undefined {
    return this.nodesByTile.get(this.tileKey(col, row));
  }

  /** Haritadaki tüm aktif ağaç kaynaklarını döner. */
  public getAllTrees(): TreeResourceNode[] {
    return Array.from(this.nodesById.values());
  }

  /**
   * Harita merkezi (IsoGrid) taşındığında tüm ağaçların dünya konumlarını
   * ve izometrik derinliklerini yeniden senkronize eder.
   */
  public syncPositions(): void {
    for (const node of this.nodesById.values()) {
      const pos = this.isoGrid.tileToWorld(node.tile.col, node.tile.row);
      node.sprite.setPosition(pos.x, pos.y);
      node.sprite.setDepth(this.isoGrid.getTileDepth(node.tile.col, node.tile.row));
    }
  }

  /** Tüm ağaç nesnelerini temizler. */
  public destroy(): void {
    for (const node of this.nodesById.values()) {
      node.sprite.destroy();
    }
    this.nodesById.clear();
    this.nodesByTile.clear();
    this.ignoredCameras.clear();
  }

  private tileKey(col: number, row: number): string {
    return `${col},${row}`;
  }
}
