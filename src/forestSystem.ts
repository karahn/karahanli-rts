/**
 * Karahanlı RTS — Orman ve Odun Kaynağı Yönetim Sistemi
 *
 * Kayın ('kayin') ve çam ('cam') ağaçlarını 8×8 izometrik harita üzerinde
 * derinlik sıralamalı (depth-sorted) olarak yöneten ve ileride eklenecek
 * odun toplama mekaniği için kaynak verilerini (id, tür, odun miktarı, koordinat)
 * tutan sade, genişletilebilir altyapı.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';

export type TreeType = 'kayin' | 'cam';

export interface TileCoord {
  col: number;
  row: number;
}

/**
 * Odun toplanabilir ağaç kaynak nesnesi veri modeli.
 */
export interface TreeResourceNode {
  /** Kaynak nesnesi benzersiz kimliği */
  id: string;
  /** Ağaç türü: kayın veya çam */
  treeType: TreeType;
  /** Mevcut odun miktarı (başlangıçta 100) */
  woodAmount: number;
  /** Başlangıç / maksimum odun kapasitesi */
  maxWoodAmount: number;
  /** İzometrik harita karo koordinatı (col, row) */
  tile: TileCoord;
}

export interface AddTreeOptions {
  id?: string;
  treeType: TreeType;
  col: number;
  row: number;
  woodAmount?: number;
  scale?: number;
}

interface TreeVisualSpec {
  textureKey: string;
  assetPath: string;
  originX: number;
  originY: number;
  defaultScale: number;
}

interface ManagedTreeEntry {
  node: TreeResourceNode;
  sprite: Phaser.GameObjects.Image;
}

export const INITIAL_WOOD_AMOUNT = 100;

/**
 * Ağaç türlerine göre kalibre edilmiş kök tabanı origin ve doku tanımları.
 */
const TREE_VISUAL_SPECS: Record<TreeType, TreeVisualSpec> = {
  kayin: {
    textureKey: 'tree-kayin',
    assetPath: 'assets/sprites/steppe_tree.png',
    // 230×202 piksel kayın sprite'ı 3B kök taban merkezi: (111, 182)
    originX: 111 / 230,
    originY: 182 / 202,
    defaultScale: 0.48
  },
  cam: {
    textureKey: 'tree-cam',
    assetPath: 'assets/sprites/pine_tree.png',
    // 129×228 piksel çam sprite'ı 3B kök taban merkezi: (65, 207)
    originX: 65 / 129,
    originY: 207 / 228,
    defaultScale: 0.48
  }
};

/**
 * Başlangıçtaki 4 ağaçlık doğal küçük orman yerleşimi (2 kayın + 2 çam).
 * Haritanın orta, doğu ve güney çayır alanlarını açık bırakacak ve
 * ağaçlar birbirinin üstüne binmeyecek şekilde konumlandırılmıştır.
 */
export const INITIAL_FOREST_LAYOUT: ReadonlyArray<AddTreeOptions> = [
  {
    id: 'wood_cam_1',
    treeType: 'cam',
    col: 2,
    row: 1,
    woodAmount: INITIAL_WOOD_AMOUNT,
    scale: 0.48
  },
  {
    id: 'wood_kayin_1',
    treeType: 'kayin',
    col: 1,
    row: 3,
    woodAmount: INITIAL_WOOD_AMOUNT,
    scale: 0.48
  },
  {
    id: 'wood_kayin_2',
    treeType: 'kayin',
    col: 4,
    row: 1,
    woodAmount: INITIAL_WOOD_AMOUNT,
    scale: 0.46
  },
  {
    id: 'wood_cam_2',
    treeType: 'cam',
    col: 1,
    row: 5,
    woodAmount: INITIAL_WOOD_AMOUNT,
    scale: 0.45
  }
];

export class ForestSystem {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly treesById = new Map<string, ManagedTreeEntry>();
  private readonly idByTileKey = new Map<string, string>();
  private nextAutoId = 1;

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid) {
    this.scene = scene;
    this.isoGrid = isoGrid;
  }

  /**
   * Orman sisteminde kullanılan ağaç görsellerini Phaser sahnesine yükler.
   */
  public static preload(scene: Phaser.Scene): void {
    for (const spec of Object.values(TREE_VISUAL_SPECS)) {
      scene.load.image(spec.textureKey, spec.assetPath);
    }
  }

  /**
   * Verilen ağaç listesini tek seferde sahneye ekler.
   */
  public populate(definitions: ReadonlyArray<AddTreeOptions>): TreeResourceNode[] {
    const created: TreeResourceNode[] = [];
    for (const def of definitions) {
      const node = this.addTree(def);
      if (node) {
        created.push(node);
      }
    }
    return created;
  }

  /**
   * Haritaya yeni bir ağaç kaynak nesnesi ekler.
   * Aynı kimlik veya dolu bir karo verilirse mevcut ağacı bozmamak için null döndürür.
   */
  public addTree(options: AddTreeOptions): TreeResourceNode | null {
    const tileKey = this.toTileKey(options.col, options.row);
    if (this.idByTileKey.has(tileKey)) {
      return null;
    }

    const id = options.id ?? this.generateUniqueId(options.treeType);
    if (this.treesById.has(id)) {
      return null;
    }

    const spec = TREE_VISUAL_SPECS[options.treeType];
    const initialWood = options.woodAmount ?? INITIAL_WOOD_AMOUNT;

    const node: TreeResourceNode = {
      id,
      treeType: options.treeType,
      woodAmount: initialWood,
      maxWoodAmount: initialWood,
      tile: {
        col: options.col,
        row: options.row
      }
    };

    const worldPos = this.isoGrid.tileToWorld(options.col, options.row);
    const sprite = this.scene.add
      .image(worldPos.x, worldPos.y, spec.textureKey)
      .setOrigin(spec.originX, spec.originY)
      .setScale(options.scale ?? spec.defaultScale)
      .setDepth(this.isoGrid.getTileDepth(options.col, options.row));

    sprite.setData('resourceId', node.id);
    sprite.setData('resourceType', 'wood');

    this.treesById.set(node.id, { node, sprite });
    this.idByTileKey.set(tileKey, node.id);

    return node;
  }

  /**
   * Kaynak nesnesi kimliğine (id) göre ağacı haritadan ve veri yapısından kaldırır.
   */
  public removeTree(id: string): boolean {
    const entry = this.treesById.get(id);
    if (!entry) {
      return false;
    }

    const tileKey = this.toTileKey(entry.node.tile.col, entry.node.tile.row);
    this.idByTileKey.delete(tileKey);
    this.treesById.delete(id);
    entry.sprite.destroy();
    return true;
  }

  /**
   * Verilen karo koordinatındaki ağacı kaldırır.
   */
  public removeTreeAt(col: number, row: number): boolean {
    const id = this.idByTileKey.get(this.toTileKey(col, row));
    return id ? this.removeTree(id) : false;
  }

  /**
   * Kimliğe göre tek bir ağaç kaynak verisini döndürür.
   */
  public getTree(id: string): TreeResourceNode | undefined {
    return this.treesById.get(id)?.node;
  }

  /**
   * Karo koordinatına göre ağaç kaynak verisini döndürür.
   */
  public getTreeAt(col: number, row: number): TreeResourceNode | undefined {
    const id = this.idByTileKey.get(this.toTileKey(col, row));
    return id ? this.treesById.get(id)?.node : undefined;
  }

  /**
   * Haritadaki tüm aktif ağaç kaynak nesnelerinin listesini döndürür.
   */
  public getAllTrees(): TreeResourceNode[] {
    return Array.from(this.treesById.values(), (entry) => entry.node);
  }

  /**
   * Ekran yeniden boyutlandırıldığında tüm ağaçların dünya koordinatlarını ve derinliklerini günceller.
   */
  public syncPositions(): void {
    for (const { node, sprite } of this.treesById.values()) {
      const worldPos = this.isoGrid.tileToWorld(node.tile.col, node.tile.row);
      sprite.setPosition(worldPos.x, worldPos.y);
      sprite.setDepth(this.isoGrid.getTileDepth(node.tile.col, node.tile.row));
    }
  }

  private toTileKey(col: number, row: number): string {
    return `${col},${row}`;
  }

  private generateUniqueId(treeType: TreeType): string {
    let candidate = `wood_${treeType}_${this.nextAutoId++}`;
    while (this.treesById.has(candidate)) {
      candidate = `wood_${treeType}_${this.nextAutoId++}`;
    }
    return candidate;
  }
}
