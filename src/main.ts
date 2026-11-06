/**
 * Karahanlı RTS — Ana Giriş Dosyası
 *
 * Phaser 3 + TypeScript + Vite tabanlı 2D gerçek zamanlı strateji oyunu.
 * 16x16 dikişsiz izometrik çimen haritayı, doğal koruluk yerleşimindeki
 * 2 kayın + 2 çam odun kaynağını (her biri 100 odun), ortak ahşap odun deposunu
 * ve hem fareyle seçim dikdörtgeni (sol tık sürükle) hem mobil çoklu seçim araçlarıyla
 * yönetilebilen Karahanlı köylülerini (başlangıçta 3 köylü) sahnede çalıştırır.
 */

import Phaser from 'phaser';
import { MapCameraController } from './cameraController';
import { ForestSystem } from './forestSystem';
import { IsoGrid } from './isoGrid';
import { VillagerSystem } from './villagerSystem';
import { WoodDepot } from './woodDepot';

/** Arayüz (UI) öğeleri için en üst derinlik katmanı */
const UI_DEPTH = 5000;

/** Üst başlık ve ortak odun sayacı için ayrılan ekran yüksekliği (px) */
const TOP_HUD_INSET = 104;

/** Alt çoklu seçim çubuğu için ayrılan ekran yüksekliği (px) */
const BOTTOM_HUD_INSET = 54;

interface HudActionButton {
  id: 'box_mode' | 'select_all' | 'clear_sel';
  rect: Phaser.Geom.Rectangle;
  bg: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
}

class MainScene extends Phaser.Scene {
  private isoGrid?: IsoGrid;
  private forestSystem?: ForestSystem;
  private woodDepot?: WoodDepot;
  private villagerSystem?: VillagerSystem;
  private cameraController?: MapCameraController;
  private uiCamera?: Phaser.Cameras.Scene2D.Camera;

  private titleText?: Phaser.GameObjects.Text;
  private subtitleText?: Phaser.GameObjects.Text;
  private woodPanelBg?: Phaser.GameObjects.Graphics;
  private woodStatusText?: Phaser.GameObjects.Text;
  private actionButtons: HudActionButton[] = [];

  private lastWoodHudLine = '';
  private lastHighlightActive = false;
  private lastActionBarSignature = '';

  constructor() {
    super({ key: 'MainScene' });
  }

  public preload(): void {
    ForestSystem.preload(this);
    VillagerSystem.preload(this);
  }

  public create(): void {
    const { width, height } = this.scale;

    // 16x16 boyutunda, 64x32 piksel (2:1) dikişsiz izometrik çimen harita (dünya merkezinde: 0, 0)
    this.isoGrid = new IsoGrid(this, {
      cols: 16,
      rows: 16,
      tileWidth: 64,
      tileHeight: 32,
    });
    this.isoGrid.setPosition(0, 0);

    // Kuzeybatı iç çayırında doğal koruluk yerleşimi (2 kayın + 2 çam, her biri 100 odun)
    this.forestSystem = new ForestSystem(this, this.isoGrid);
    this.forestSystem.populate();

    // Tüm köylülerin ortak kullandığı sabit odun deposu (col: 7, row: 6)
    this.woodDepot = new WoodDepot(this, this.isoGrid);

    // 16x16 harita için ekran ölçekleme, sürükleme ve yakınlaştırma kontrolcüsü
    const mapSize = this.isoGrid.getWorldSize();
    this.cameraController = new MapCameraController(this, this.cameras.main, {
      mapWidth: mapSize.width,
      mapHeight: mapSize.height,
      topUiInset: TOP_HUD_INSET,
      bottomUiInset: BOTTOM_HUD_INSET,
    });

    // Çoklu Karahanlı köylü ve seçim dikdörtgeni sistemi (başlangıçta 3 köylü)
    this.villagerSystem = new VillagerSystem(
      this,
      this.isoGrid,
      this.forestSystem,
      this.woodDepot,
      this.cameraController
    );
    this.villagerSystem.spawnInitialVillagers();
    this.villagerSystem.setUiHitBlocker((sx, sy) =>
      this.isPointOnActionButtons(sx, sy)
    );

    // Sabit üst başlık, kontrol açıklaması ve ortak odun sayacı
    this.titleText = this.add
      .text(0, 0, 'KARAHANLI RTS', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '21px',
        fontStyle: 'bold',
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0)
      .setDepth(UI_DEPTH);

    this.subtitleText = this.add
      .text(
        0,
        0,
        'Sol Sürükle: Çoklu Kutu Seç  •  Sol Tık: Tekli Seç  •  Sağ Tık / Dokun: Ortak Hareket & Ağaç Kes',
        {
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: '12px',
          color: '#94a3b8',
          align: 'center',
        }
      )
      .setOrigin(0.5, 0)
      .setDepth(UI_DEPTH);

    this.woodPanelBg = this.add.graphics().setDepth(UI_DEPTH);

    this.woodStatusText = this.add
      .text(0, 0, '', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
        fontStyle: 'bold',
        color: '#e2e8f0',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(UI_DEPTH + 1);

    // Mobil ve hızlı erişim çoklu seçim alt çubuğu
    this.createBottomActionButtons();
    this.input.on('pointerdown', this.handleHudPointerDown, this);

    // Arayüz öğelerini ve seçim dikdörtgenini yakınlaştırmadan bağımsız tutan şeffaf HUD kamerası
    this.uiCamera = this.cameras.add(0, 0, width, height, false, 'HudCamera');

    const hudObjects: Phaser.GameObjects.GameObject[] = [
      this.titleText,
      this.subtitleText,
      this.woodPanelBg,
      this.woodStatusText,
      ...this.villagerSystem.getScreenOverlayObjects(),
    ];
    for (const btn of this.actionButtons) {
      hudObjects.push(btn.bg, btn.label);
    }
    this.cameras.main.ignore(hudObjects);

    const terrainImg = this.isoGrid.getTerrainImage();
    if (terrainImg) {
      this.uiCamera.ignore(terrainImg);
    }
    this.forestSystem.ignoreOnCamera(this.uiCamera);
    this.woodDepot.ignoreOnCamera(this.uiCamera);
    this.villagerSystem.ignoreOnCamera(this.uiCamera);

    this.refreshHud(true);
    this.layoutHud(width, height);
    this.scale.on('resize', this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
  }

  public update(_time: number, delta: number): void {
    this.cameraController?.update(delta);
    this.villagerSystem?.update(delta);
    this.refreshHud(false);
  }

  private createBottomActionButtons(): void {
    const defs: ReadonlyArray<HudActionButton['id']> = [
      'box_mode',
      'select_all',
      'clear_sel',
    ];

    this.actionButtons = defs.map((id) => {
      const bg = this.add.graphics().setDepth(UI_DEPTH);
      const label = this.add
        .text(0, 0, '', {
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: '12px',
          fontStyle: 'bold',
          color: '#f8fafc',
        })
        .setOrigin(0.5, 0.5)
        .setDepth(UI_DEPTH + 1);

      return {
        id,
        rect: new Phaser.Geom.Rectangle(0, 0, 100, 30),
        bg,
        label,
      };
    });
  }

  private isPointOnActionButtons(screenX: number, screenY: number): boolean {
    for (const btn of this.actionButtons) {
      if (Phaser.Geom.Rectangle.Contains(btn.rect, screenX, screenY)) {
        return true;
      }
    }
    return false;
  }

  private handleHudPointerDown(pointer: Phaser.Input.Pointer): void {
    if (!this.villagerSystem) {
      return;
    }

    for (const btn of this.actionButtons) {
      if (!Phaser.Geom.Rectangle.Contains(btn.rect, pointer.x, pointer.y)) {
        continue;
      }

      if (btn.id === 'box_mode') {
        this.villagerSystem.toggleTouchBoxSelectMode();
      } else if (btn.id === 'select_all') {
        this.villagerSystem.setTouchBoxSelectMode(false);
        this.villagerSystem.selectAllVillagers();
      } else if (btn.id === 'clear_sel') {
        this.villagerSystem.setTouchBoxSelectMode(false);
        this.villagerSystem.clearSelection();
      }

      this.refreshHud(true);
      return;
    }
  }

  private refreshHud(force: boolean): void {
    if (!this.villagerSystem || !this.woodStatusText) {
      return;
    }

    const status = this.villagerSystem.getHudStatus();
    const sel = status.selectedVillager;
    const multi = status.multiSelected;

    let line: string;
    let highlight = false;

    if (multi) {
      highlight = true;
      const taskParts: string[] = [];
      if (multi.choppingCount > 0) {
        taskParts.push(`${multi.choppingCount} Kesiyor`);
      }
      if (multi.movingCount > 0) {
        taskParts.push(`${multi.movingCount} Yürüyor`);
      }
      const taskSummary =
        taskParts.length > 0 ? taskParts.join(', ') : 'Hazır';

      line = `Toplam Odun: ${status.totalStoredWood}   •   Seçili: ${multi.count} Köylü (${multi.totalCarriedWood}/${multi.totalCapacity})   •   ${taskSummary}`;
    } else if (sel) {
      highlight = true;
      const stateLabel =
        sel.state === 'chopping'
          ? 'Kesiyor'
          : sel.state === 'returning_to_depot'
            ? 'Depoya Götürüyor'
            : sel.state === 'walking'
              ? 'Yürüyor'
              : 'Hazır';

      let detailPart = stateLabel;
      if (
        sel.targetTreeType !== null &&
        sel.targetTreeWood !== null &&
        sel.targetTreeMaxWood !== null
      ) {
        const treeName = sel.targetTreeType === 'cam' ? 'Çam' : 'Kayın';
        detailPart = `${stateLabel} (${treeName}: ${sel.targetTreeWood}/${sel.targetTreeMaxWood})`;
      }

      line = `Toplam Odun: ${status.totalStoredWood}   •   ${sel.displayName}: ${sel.carriedWood}/${sel.maxCapacity}   •   ${detailPart}`;
    } else {
      line = `Toplam Odun: ${status.totalStoredWood}   •   Köylüler: ${status.totalVillagersCount} (${status.workingVillagersCount} Aktif)   •   Orman: ${status.remainingTreesCount} Ağaç`;
    }

    if (
      force ||
      line !== this.lastWoodHudLine ||
      highlight !== this.lastHighlightActive
    ) {
      this.lastWoodHudLine = line;
      this.lastHighlightActive = highlight;
      this.woodStatusText.setText(line);
      this.woodStatusText.setColor(highlight ? '#f8fafc' : '#e2e8f0');
      this.drawWoodPillBackground(this.scale.width);
    }

    const actionSig = `${status.touchBoxSelectMode ? 1 : 0}|${status.selectedCount}|${status.totalVillagersCount}|${this.scale.width}x${this.scale.height}`;
    if (force || actionSig !== this.lastActionBarSignature) {
      this.lastActionBarSignature = actionSig;
      this.renderBottomActionBar(
        this.scale.width,
        this.scale.height,
        status.touchBoxSelectMode,
        status.selectedCount,
        status.totalVillagersCount
      );
    }
  }

  private layoutHud(width: number, height: number): void {
    const isCompact = width < 580;
    this.titleText?.setFontSize(isCompact ? 17 : 21);
    this.subtitleText?.setFontSize(isCompact ? 11 : 12);
    this.subtitleText?.setWordWrapWidth(Math.max(width - 24, 240));
    this.woodStatusText?.setFontSize(isCompact ? 11 : 13);

    this.titleText?.setPosition(width / 2, isCompact ? 10 : 14);
    this.subtitleText?.setPosition(width / 2, isCompact ? 32 : 40);
    this.woodStatusText?.setPosition(width / 2, isCompact ? 74 : 76);

    this.drawWoodPillBackground(width);

    if (this.villagerSystem) {
      const status = this.villagerSystem.getHudStatus();
      this.renderBottomActionBar(
        width,
        height,
        status.touchBoxSelectMode,
        status.selectedCount,
        status.totalVillagersCount
      );
    }
  }

  private renderBottomActionBar(
    screenWidth: number,
    screenHeight: number,
    boxModeActive: boolean,
    selectedCount: number,
    totalCount: number
  ): void {
    if (this.actionButtons.length === 0) {
      return;
    }

    const isCompact = screenWidth < 520;
    const fontSize = isCompact ? 11 : 12;
    const btnHeight = isCompact ? 30 : 32;
    const gap = isCompact ? 6 : 10;
    const padX = isCompact ? 11 : 15;
    const centerY = screenHeight - (isCompact ? 22 : 25);

    const buttonConfigs: Record<
      HudActionButton['id'],
      {
        text: string;
        fill: number;
        fillAlpha: number;
        stroke: number;
        textColor: string;
      }
    > = {
      box_mode: {
        text: boxModeActive ? '■ Kutu Seç: Açık' : '□ Kutu Seç',
        fill: boxModeActive ? 0x166534 : 0x1e293b,
        fillAlpha: 0.92,
        stroke: boxModeActive ? 0x4ade80 : 0x64748b,
        textColor: boxModeActive ? '#dcfce7' : '#e2e8f0',
      },
      select_all: {
        text: `Tümünü Seç (${totalCount})`,
        fill:
          selectedCount === totalCount && totalCount > 0 ? 0x14532d : 0x1e293b,
        fillAlpha: 0.9,
        stroke:
          selectedCount === totalCount && totalCount > 0 ? 0x4ade80 : 0x64748b,
        textColor: '#f1f5f9',
      },
      clear_sel: {
        text: selectedCount > 0 ? `Bırak (${selectedCount})` : 'Bırak',
        fill: 0x1e293b,
        fillAlpha: selectedCount > 0 ? 0.9 : 0.62,
        stroke: selectedCount > 0 ? 0x94a3b8 : 0x334155,
        textColor: selectedCount > 0 ? '#e2e8f0' : '#64748b',
      },
    };

    const widths: number[] = [];
    let totalRowW = 0;

    for (const btn of this.actionButtons) {
      const cfg = buttonConfigs[btn.id];
      btn.label.setFontSize(fontSize);
      btn.label.setText(cfg.text);
      btn.label.setColor(cfg.textColor);
      const w = Math.ceil(btn.label.width + padX * 2);
      widths.push(w);
      totalRowW += w;
    }
    totalRowW += gap * (this.actionButtons.length - 1);

    let curX = (screenWidth - totalRowW) * 0.5;
    const topY = centerY - btnHeight * 0.5;

    for (let i = 0; i < this.actionButtons.length; i += 1) {
      const btn = this.actionButtons[i];
      const cfg = buttonConfigs[btn.id];
      const w = widths[i];

      btn.rect.setTo(curX, topY, w, btnHeight);
      btn.label.setPosition(curX + w * 0.5, centerY);

      btn.bg.clear();
      btn.bg.fillStyle(cfg.fill, cfg.fillAlpha);
      btn.bg.fillRoundedRect(curX, topY, w, btnHeight, 10);
      btn.bg.lineStyle(1.2, cfg.stroke, 0.92);
      btn.bg.strokeRoundedRect(curX, topY, w, btnHeight, 10);

      curX += w + gap;
    }
  }

  private drawWoodPillBackground(screenWidth: number): void {
    if (!this.woodPanelBg || !this.woodStatusText) {
      return;
    }

    const isCompact = screenWidth < 580;
    const centerY = isCompact ? 74 : 76;
    const textW = this.woodStatusText.width;
    const pillW = Math.min(screenWidth - 16, Math.max(240, textW + 28));
    const pillH = isCompact ? 24 : 26;
    const x = (screenWidth - pillW) * 0.5;
    const y = centerY - pillH * 0.5;

    this.woodPanelBg.clear();
    this.woodPanelBg.fillStyle(0x1e293b, 0.88);
    this.woodPanelBg.fillRoundedRect(x, y, pillW, pillH, 12);
    this.woodPanelBg.lineStyle(
      1,
      this.lastHighlightActive ? 0x4ade80 : 0x475569,
      0.9
    );
    this.woodPanelBg.strokeRoundedRect(x, y, pillW, pillH, 12);
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    this.uiCamera?.setSize(width, height);
    this.layoutHud(width, height);
    this.cameraController?.handleResize(width, height);
  }

  private cleanup(): void {
    this.input.off('pointerdown', this.handleHudPointerDown, this);
    this.scale.off('resize', this.handleResize, this);
    for (const btn of this.actionButtons) {
      btn.bg.destroy();
      btn.label.destroy();
    }
    this.actionButtons = [];
    this.villagerSystem?.destroy();
    this.woodDepot?.destroy();
    this.cameraController?.destroy();
    this.forestSystem?.destroy();
    this.isoGrid?.destroy();
  }
}

const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0f172a',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  render: {
    antialias: true,
    roundPixels: false,
  },
  scene: [MainScene],
};

new Phaser.Game(gameConfig);
