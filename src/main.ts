/**
 * Karahanlı RTS — Ana Başlangıç Dosyası
 * Bu proje, Karahanlı RTS (Gerçek Zamanlı Strateji) oyunu için
 * Phaser 3 ve TypeScript kullanılarak hazırlanmış temel oyun altyapısıdır.
 */

import Phaser from 'phaser';
import { ForestSystem, INITIAL_FOREST_LAYOUT } from './forestSystem';
import { IsoGrid } from './isoGrid';

const MAP_VERTICAL_OFFSET = 34;

class MainScene extends Phaser.Scene {
  private isoGrid?: IsoGrid;
  private forestSystem?: ForestSystem;
  private titleText?: Phaser.GameObjects.Text;
  private subtitleText?: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'MainScene' });
  }

  preload(): void {
    ForestSystem.preload(this);
  }

  create(): void {
    const { width, height } = this.scale;

    this.isoGrid = new IsoGrid(this, {
      cols: 8,
      rows: 8,
      tileWidth: 64,
      tileHeight: 32
    });
    this.isoGrid.setPosition(width / 2, height / 2 + MAP_VERTICAL_OFFSET);

    // 2 kayın + 2 çam ağacından oluşan başlangıç orman ve odun kaynağı sistemi
    this.forestSystem = new ForestSystem(this, this.isoGrid);
    this.forestSystem.populate(INITIAL_FOREST_LAYOUT);

    this.titleText = this.add
      .text(width / 2, 42, 'KARAHANLI RTS', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '32px',
        fontStyle: 'bold',
        color: '#f59e0b'
      })
      .setOrigin(0.5)
      .setDepth(5000);

    this.subtitleText = this.add
      .text(width / 2, 76, 'İzometrik Çimen Arazi & Küçük Orman (8×8 Harita)', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '15px',
        color: '#94a3b8'
      })
      .setOrigin(0.5)
      .setDepth(5000);

    this.scale.on('resize', this.handleResize, this);
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    this.isoGrid?.setPosition(width / 2, height / 2 + MAP_VERTICAL_OFFSET);
    this.forestSystem?.syncPositions();

    this.titleText?.setPosition(width / 2, 42);
    this.subtitleText?.setPosition(width / 2, 76);
  }

  update(_time: number, _delta: number): void {
    // Ana oyun döngüsü buraya eklenecek
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0f172a',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: '100%',
    height: '100%'
  },
  scene: [MainScene]
};

export default new Phaser.Game(config);
