/**
 * Karahanlı RTS — Basit İzometrik Zemin (Tile) Sistemi
 * 2:1 izometrik projeksiyon ile tek renkli karolardan oluşan temel zemin ızgarası.
 */

import Phaser from 'phaser';

export interface IsoGridOptions {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  fillColor?: number;
  strokeColor?: number;
}

export class IsoGrid {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly cols: number;
  private readonly rows: number;
  private readonly tileWidth: number;
  private readonly tileHeight: number;
  private readonly fillColor: number;
  private readonly strokeColor: number;

  constructor(scene: Phaser.Scene, options: IsoGridOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.tileWidth = options.tileWidth;
    this.tileHeight = options.tileHeight;
    this.fillColor = options.fillColor ?? 0x2d6a4f;
    this.strokeColor = options.strokeColor ?? 0x74c69d;

    this.graphics = scene.add.graphics();
    this.draw();
  }

  /**
   * Izgara (col, row) koordinatını ızgara merkezine göre izometrik ekran koordinatına çevirir.
   */
  public gridToIso(col: number, row: number): { x: number; y: number } {
    const halfW = this.tileWidth / 2;
    const halfH = this.tileHeight / 2;

    const rawX = (col - row) * halfW;
    const rawY = (col + row) * halfH;

    const centerOffsetX = ((this.cols - this.rows) * this.tileWidth) / 4;
    const centerOffsetY = ((this.cols + this.rows - 2) * this.tileHeight) / 4;

    return {
      x: rawX - centerOffsetX,
      y: rawY - centerOffsetY
    };
  }

  public draw(): void {
    this.graphics.clear();

    const halfW = this.tileWidth / 2;
    const halfH = this.tileHeight / 2;

    this.graphics.fillStyle(this.fillColor, 1);
    this.graphics.lineStyle(1.5, this.strokeColor, 0.85);

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const { x, y } = this.gridToIso(col, row);

        const diamondPoints: Phaser.Types.Math.Vector2Like[] = [
          { x, y: y - halfH }, // Üst köşe
          { x: x + halfW, y }, // Sağ köşe
          { x, y: y + halfH }, // Alt köşe
          { x: x - halfW, y }  // Sol köşe
        ];

        this.graphics.fillPoints(diamondPoints, true, true);
        this.graphics.strokePoints(diamondPoints, true, true);
      }
    }
  }

  public setPosition(x: number, y: number): void {
    this.graphics.setPosition(x, y);
  }
}
