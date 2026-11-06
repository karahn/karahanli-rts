/**
 * Karahanlı RTS — Ana Başlangıç Dosyası
 * Bu proje, Karahanlı RTS (Gerçek Zamanlı Strateji) oyunu için
 * Phaser 3 ve TypeScript kullanılarak hazırlanmış temel oyun altyapısıdır.
 */

import Phaser from 'phaser';

class MainScene extends Phaser.Scene {
  private titleText?: Phaser.GameObjects.Text;
  private subtitleText?: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'MainScene' });
  }

  preload(): void {
    // Varlık (asset) yüklemeleri buraya eklenecek
  }

  create(): void {
    const { width, height } = this.scale;

    this.titleText = this.add
      .text(width / 2, height / 2 - 14, 'KARAHANLI RTS', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '32px',
        fontStyle: 'bold',
        color: '#f59e0b'
      })
      .setOrigin(0.5);

    this.subtitleText = this.add
      .text(width / 2, height / 2 + 24, 'Phaser 3 + TypeScript Temel Proje Hazır', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '15px',
        color: '#94a3b8'
      })
      .setOrigin(0.5);

    this.scale.on('resize', this.handleResize, this);
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    this.titleText?.setPosition(width / 2, height / 2 - 14);
    this.subtitleText?.setPosition(width / 2, height / 2 + 24);
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
