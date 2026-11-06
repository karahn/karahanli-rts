/**
 * Karahanlı RTS — Birleşik Alt Bilgi ve Yönetim Paneli (BottomInfoPanel)
 *
 * Age of Empires ve Celtic Kings tarzında ekranın alt bölümünde yer alan,
 * kamera yakınlaştırmasından bağımsız (HudCamera) bilgi ve komut paneli:
 * - Tekli birim seçildiğinde: Karahanlı dönemi kıyafetlerine uygun yakın plan
 *   karakter portresi, ad, tür, can/maksimum can, saldırı, savunma, açlık/tokluk
 *   durumu, taşınan kaynak ve mevcut görev
 * - Çoklu birim seçildiğinde: Seçili birim sayısı, grup özeti ve tıklanabilir
 *   yakın plan karakter portre kartları
 * - Town Hall seçildiğinde: Aynı arayüz düzeninde bina portresi, köylü üretimi
 *   (20 Odun, 5 sn) ve yalnızca bu panelde görünen garnizon birim sayıları,
 *   türleri, yakın plan portre kartları, "Tek Çıkar" ve "Tümünü Çıkar" butonları
 */

import Phaser from 'phaser';
import { TownHallHudSnapshot } from './townHall';
import { UnitCategory } from './unitTypes';
import { VillagerHudStatus } from './villagerSystem';

const PANEL_DEPTH = 5010;

export const BOTTOM_DOCK_TOTAL_HEIGHT = 158;

const VILLAGER_PORTRAIT_KEYS = [
  'portrait_villager_1',
  'portrait_villager_2',
  'portrait_villager_3',
] as const;

const TOWN_HALL_PORTRAIT_KEY = 'portrait_town_hall';

export interface BottomPanelCallbacks {
  onToggleTouchBoxMode: () => void;
  onSelectAllUnits: () => void;
  onSelectTownHall: () => void;
  onClearSelection: () => void;
  onSelectSingleUnit: (unitId: string) => void;
  onCommandSelectedEnterTownHall: () => void;
  onTrainVillager: () => boolean;
  onEjectSingleUnit: (unitId?: string) => void;
  onEjectAllUnits: () => void;
}

interface ClickableZone {
  rect: Phaser.Geom.Rectangle;
  onClick: () => void;
}

const MAX_ICON_SLOTS = 12;

export class BottomInfoPanel {
  private readonly scene: Phaser.Scene;
  private readonly callbacks: BottomPanelCallbacks;

  private readonly quickBarBg: Phaser.GameObjects.Graphics;
  private readonly rootBg: Phaser.GameObjects.Graphics;
  private readonly mainPortraitImage: Phaser.GameObjects.Image;
  private readonly slotPortraitImages: Phaser.GameObjects.Image[] = [];
  private readonly iconOverlayGraphics: Phaser.GameObjects.Graphics;

  private readonly quickLabels: Phaser.GameObjects.Text[] = [];
  private readonly headerTitle: Phaser.GameObjects.Text;
  private readonly headerSubtitle: Phaser.GameObjects.Text;
  private readonly col1Text: Phaser.GameObjects.Text;
  private readonly col2Text: Phaser.GameObjects.Text;
  private readonly col3TitleText: Phaser.GameObjects.Text;

  private readonly primaryBtnText: Phaser.GameObjects.Text;
  private readonly secondaryBtnText: Phaser.GameObjects.Text;
  private readonly tertiaryBtnText: Phaser.GameObjects.Text;
  private readonly pageInfoText: Phaser.GameObjects.Text;

  private readonly slotTexts: Phaser.GameObjects.Text[] = [];

  private readonly panelHitRect = new Phaser.Geom.Rectangle(0, 0, 0, 0);
  private readonly quickButtonRects: Phaser.Geom.Rectangle[] = [];
  private clickableZones: ClickableZone[] = [];

  private multiPage = 0;
  private garrisonPage = 0;
  private warnFlashUntil = 0;
  private lastRenderSignature = '';

  constructor(scene: Phaser.Scene, callbacks: BottomPanelCallbacks) {
    this.scene = scene;
    this.callbacks = callbacks;

    this.quickBarBg = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.rootBg = scene.add.graphics().setDepth(PANEL_DEPTH + 1);

    this.mainPortraitImage = scene.add
      .image(0, 0, VILLAGER_PORTRAIT_KEYS[0])
      .setOrigin(0, 0)
      .setDepth(PANEL_DEPTH + 2)
      .setVisible(false);

    for (let i = 0; i < MAX_ICON_SLOTS; i += 1) {
      this.slotPortraitImages.push(
        scene.add
          .image(0, 0, VILLAGER_PORTRAIT_KEYS[i % VILLAGER_PORTRAIT_KEYS.length])
          .setOrigin(0, 0)
          .setDepth(PANEL_DEPTH + 2)
          .setVisible(false)
      );
    }

    this.iconOverlayGraphics = scene.add.graphics().setDepth(PANEL_DEPTH + 3);

    const fontStack =
      'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

    for (let i = 0; i < 4; i += 1) {
      this.quickLabels.push(
        scene.add
          .text(0, 0, '', {
            fontFamily: fontStack,
            fontSize: '11px',
            fontStyle: 'bold',
            color: '#f1f5f9',
          })
          .setOrigin(0.5, 0.5)
          .setDepth(PANEL_DEPTH + 2)
      );
      this.quickButtonRects.push(new Phaser.Geom.Rectangle(0, 0, 0, 0));
    }

    this.headerTitle = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '14px',
        fontStyle: 'bold',
        color: '#fef3c7',
      })
      .setOrigin(0, 0)
      .setDepth(PANEL_DEPTH + 4);

    this.headerSubtitle = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '11.5px',
        color: '#94a3b8',
      })
      .setOrigin(0, 0)
      .setDepth(PANEL_DEPTH + 4);

    this.col1Text = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '11.5px',
        color: '#e2e8f0',
        lineSpacing: 4,
      })
      .setOrigin(0, 0)
      .setDepth(PANEL_DEPTH + 4);

    this.col2Text = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '11.5px',
        color: '#cbd5e1',
        lineSpacing: 4,
      })
      .setOrigin(0, 0)
      .setDepth(PANEL_DEPTH + 4);

    this.col3TitleText = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '11.5px',
        fontStyle: 'bold',
        color: '#fde68a',
      })
      .setOrigin(0, 0)
      .setDepth(PANEL_DEPTH + 4);

    this.primaryBtnText = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '11.5px',
        fontStyle: 'bold',
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(PANEL_DEPTH + 5);

    this.secondaryBtnText = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '11px',
        fontStyle: 'bold',
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(PANEL_DEPTH + 5);

    this.tertiaryBtnText = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '11px',
        fontStyle: 'bold',
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(PANEL_DEPTH + 5);

    this.pageInfoText = scene.add
      .text(0, 0, '', {
        fontFamily: fontStack,
        fontSize: '10.5px',
        color: '#94a3b8',
      })
      .setOrigin(1, 0)
      .setDepth(PANEL_DEPTH + 4);

    for (let i = 0; i < MAX_ICON_SLOTS; i += 1) {
      this.slotTexts.push(
        scene.add
          .text(0, 0, '', {
            fontFamily: fontStack,
            fontSize: '9.5px',
            fontStyle: 'bold',
            color: '#f8fafc',
            stroke: '#020617',
            strokeThickness: 2.5,
          })
          .setOrigin(0.5, 1)
          .setDepth(PANEL_DEPTH + 5)
          .setVisible(false)
      );
    }

    scene.input.on('pointerdown', this.handlePointerDown, this);
  }

  /** Yakın plan Karahanlı köylü ve Town Hall portrelerini önbelleğe yükler. */
  public static preload(scene: Phaser.Scene): void {
    scene.load.image(VILLAGER_PORTRAIT_KEYS[0], 'assets/portraits/villager_1.png');
    scene.load.image(VILLAGER_PORTRAIT_KEYS[1], 'assets/portraits/villager_2.png');
    scene.load.image(VILLAGER_PORTRAIT_KEYS[2], 'assets/portraits/villager_3.png');
    scene.load.image(TOWN_HALL_PORTRAIT_KEY, 'assets/portraits/town_hall.png');
  }

  public getGameObjects(): Phaser.GameObjects.GameObject[] {
    return [
      this.quickBarBg,
      this.rootBg,
      this.mainPortraitImage,
      ...this.slotPortraitImages,
      this.iconOverlayGraphics,
      ...this.quickLabels,
      this.headerTitle,
      this.headerSubtitle,
      this.col1Text,
      this.col2Text,
      this.col3TitleText,
      this.primaryBtnText,
      this.secondaryBtnText,
      this.tertiaryBtnText,
      this.pageInfoText,
      ...this.slotTexts,
    ];
  }

  /**
   * Belirtilen ekran koordinatının alt bilgi paneli veya hızlı butonlar üzerinde
   * olup olmadığını döndürür (haritaya tıklama sızmasını engeller).
   */
  public containsScreenPoint(screenX: number, screenY: number): boolean {
    if (Phaser.Geom.Rectangle.Contains(this.panelHitRect, screenX, screenY)) {
      return true;
    }
    for (const r of this.quickButtonRects) {
      if (Phaser.Geom.Rectangle.Contains(r, screenX, screenY)) {
        return true;
      }
    }
    return false;
  }

  public render(
    screenWidth: number,
    screenHeight: number,
    unitStatus: VillagerHudStatus,
    townHallSnap: TownHallHudSnapshot,
    force = false
  ): void {
    const warnFlash = this.scene.time.now < this.warnFlashUntil;
    const sig = this.buildSignature(
      screenWidth,
      screenHeight,
      unitStatus,
      townHallSnap,
      warnFlash
    );

    if (!force && sig === this.lastRenderSignature) {
      return;
    }
    this.lastRenderSignature = sig;

    this.clickableZones = [];
    this.hideTransientVisuals();
    this.rootBg.clear();
    this.iconOverlayGraphics.clear();
    this.quickBarBg.clear();

    const isCompact = screenWidth < 680;
    const panelMarginX = isCompact ? 6 : 14;
    const panelW = Math.min(980, Math.max(280, screenWidth - panelMarginX * 2));
    const panelH = isCompact ? 124 : 118;
    const panelX = Math.round((screenWidth - panelW) * 0.5);
    const panelY = Math.round(screenHeight - panelH - 6);

    this.panelHitRect.setTo(panelX, panelY, panelW, panelH);

    // 1) Üst hızlı kontrol şeridi (Kutu Seç, Tümünü Seç, Town Hall, Bırak — garnizon sayısı göstermez)
    this.renderQuickToolbar(
      screenWidth,
      panelY - 31,
      unitStatus,
      townHallSnap,
      isCompact
    );

    // 2) Ana alt panel çerçevesi (Karahanlı koyu arduvaz & bronz-kehribar çerçeve)
    this.rootBg.fillStyle(0x0b1322, 0.94);
    this.rootBg.fillRoundedRect(panelX, panelY, panelW, panelH, 11);
    this.rootBg.lineStyle(1.5, 0xb45309, 0.92);
    this.rootBg.strokeRoundedRect(panelX, panelY, panelW, panelH, 11);
    this.rootBg.lineStyle(1, 0x334155, 0.65);
    this.rootBg.strokeRoundedRect(
      panelX + 3,
      panelY + 3,
      panelW - 6,
      panelH - 6,
      9
    );

    // 3) Seçim moduna göre içerik düzeni
    if (townHallSnap.selected) {
      this.renderTownHallMode(
        panelX,
        panelY,
        panelW,
        panelH,
        unitStatus,
        townHallSnap,
        warnFlash,
        isCompact
      );
    } else if (unitStatus.selectedUnit) {
      this.renderSingleUnitMode(
        panelX,
        panelY,
        panelW,
        panelH,
        unitStatus.selectedUnit,
        isCompact
      );
    } else if (unitStatus.multiSelected) {
      this.renderMultiUnitMode(
        panelX,
        panelY,
        panelW,
        panelH,
        unitStatus.multiSelected,
        isCompact
      );
    } else {
      this.renderIdleSettlementMode(
        panelX,
        panelY,
        panelW,
        panelH,
        unitStatus,
        townHallSnap,
        isCompact
      );
    }
  }

  public destroy(): void {
    this.scene.input.off('pointerdown', this.handlePointerDown, this);
    for (const obj of this.getGameObjects()) {
      obj.destroy();
    }
    this.clickableZones = [];
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    for (const zone of this.clickableZones) {
      if (Phaser.Geom.Rectangle.Contains(zone.rect, pointer.x, pointer.y)) {
        zone.onClick();
        return;
      }
    }
  }

  private renderQuickToolbar(
    screenWidth: number,
    topY: number,
    unitStatus: VillagerHudStatus,
    townHallSnap: TownHallHudSnapshot,
    isCompact: boolean
  ): void {
    const anySelected = unitStatus.selectedCount > 0 || townHallSnap.selected;

    const items: Array<{
      label: string;
      active: boolean;
      dim: boolean;
      action: () => void;
    }> = [
      {
        label: unitStatus.touchBoxSelectMode ? '■ Kutu Seç' : '□ Kutu Seç',
        active: unitStatus.touchBoxSelectMode,
        dim: false,
        action: () => this.callbacks.onToggleTouchBoxMode(),
      },
      {
        label: `Tümünü Seç (${unitStatus.fieldVillagersCount})`,
        active:
          unitStatus.fieldVillagersCount > 0 &&
          unitStatus.selectedCount === unitStatus.fieldVillagersCount,
        dim: unitStatus.fieldVillagersCount === 0,
        action: () => this.callbacks.onSelectAllUnits(),
      },
      {
        label: 'Town Hall',
        active: townHallSnap.selected,
        dim: false,
        action: () => this.callbacks.onSelectTownHall(),
      },
      {
        label:
          unitStatus.selectedCount > 0
            ? `Bırak (${unitStatus.selectedCount})`
            : 'Bırak',
        active: false,
        dim: !anySelected,
        action: () => this.callbacks.onClearSelection(),
      },
    ];

    const btnH = 26;
    const gap = isCompact ? 5 : 8;
    const padX = isCompact ? 8 : 12;
    const fontSize = isCompact ? 10.5 : 11;

    const widths: number[] = [];
    let totalW = 0;

    for (let i = 0; i < items.length; i += 1) {
      const lbl = this.quickLabels[i];
      lbl.setFontSize(fontSize);
      lbl.setText(items[i].label);
      lbl.setColor(
        items[i].dim
          ? '#64748b'
          : items[i].active
            ? '#dcfce7'
            : '#f1f5f9'
      );
      const w = Math.ceil(lbl.width + padX * 2);
      widths.push(w);
      totalW += w;
    }
    totalW += gap * (items.length - 1);

    let curX = Math.round((screenWidth - totalW) * 0.5);
    const centerY = topY + btnH * 0.5;

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const w = widths[i];
      const rect = this.quickButtonRects[i];
      rect.setTo(curX, topY, w, btnH);

      this.quickLabels[i].setPosition(curX + w * 0.5, centerY);

      this.quickBarBg.fillStyle(
        item.active ? 0x166534 : 0x1e293b,
        item.dim ? 0.65 : 0.92
      );
      this.quickBarBg.fillRoundedRect(curX, topY, w, btnH, 8);
      this.quickBarBg.lineStyle(
        1.1,
        item.active ? 0x4ade80 : item.dim ? 0x334155 : 0x64748b,
        0.9
      );
      this.quickBarBg.strokeRoundedRect(curX, topY, w, btnH, 8);

      this.clickableZones.push({
        rect: new Phaser.Geom.Rectangle(curX, topY, w, btnH),
        onClick: item.action,
      });

      curX += w + gap;
    }
  }

  private renderSingleUnitMode(
    px: number,
    py: number,
    pw: number,
    ph: number,
    unit: NonNullable<VillagerHudStatus['selectedUnit']>,
    isCompact: boolean
  ): void {
    // Sol yakın plan karakter portresi + can çubuğu
    const portraitX = px + 12;
    const portraitY = py + 12;
    const portraitSize = isCompact ? 54 : 64;

    this.drawUnitPortraitCard(
      this.mainPortraitImage,
      portraitX,
      portraitY,
      portraitSize,
      unit.id,
      unit.category,
      unit.hp,
      unit.maxHp,
      true
    );

    const textStartX = portraitX + portraitSize + 12;
    const rightBtnW = isCompact ? 116 : 148;
    const rightBtnX = px + pw - rightBtnW - 12;

    this.headerTitle.setFontSize(isCompact ? 13 : 14);
    this.headerTitle.setText(`${unit.displayName}  —  ${unit.unitTypeLabel}`);
    this.headerTitle.setPosition(textStartX, py + 9);
    this.headerTitle.setVisible(true);

    const combatNote = unit.combatSystemActive ? '' : ' (yakında)';
    const carryLine =
      unit.carriedResource.amount > 0
        ? `${unit.carriedResource.resourceLabel} ${unit.carriedResource.amount}/${unit.carriedResource.maxCapacity}`
        : `Yok (0/${unit.carriedResource.maxCapacity} ${unit.carriedResource.resourceLabel})`;

    if (isCompact) {
      this.col1Text.setFontSize(10.5);
      this.col1Text.setColor('#e2e8f0');
      this.col1Text.setText(
        `Can: ${unit.hp}/${unit.maxHp}  •  Saldırı: ${unit.attackDamage}  •  Savunma: ${unit.defenseArmor}${combatNote}\n` +
          `Açlık: ${unit.nutrition.statusText}\n` +
          `Taşınan: ${carryLine}\n` +
          `Görev: ${unit.taskDescription}`
      );
      this.col1Text.setPosition(textStartX, py + 29);
      this.col1Text.setVisible(true);
    } else {
      const midColX = textStartX + Math.min(300, (rightBtnX - textStartX) * 0.5);

      this.col1Text.setFontSize(11.5);
      this.col1Text.setColor('#e2e8f0');
      this.col1Text.setText(
        `Can: ${unit.hp} / ${unit.maxHp}\n` +
          `Saldırı Hasarı: ${unit.attackDamage}${combatNote}\n` +
          `Savunma Değeri: ${unit.defenseArmor}${combatNote}`
      );
      this.col1Text.setPosition(textStartX, py + 33);
      this.col1Text.setVisible(true);

      this.col2Text.setFontSize(11.5);
      this.col2Text.setColor('#cbd5e1');
      this.col2Text.setText(
        `Açlık / Tokluk: ${unit.nutrition.statusText}\n` +
          `Taşınan Kaynak: ${carryLine}\n` +
          `Mevcut Görev: ${unit.taskDescription}`
      );
      this.col2Text.setPosition(midColX, py + 33);
      this.col2Text.setVisible(true);
    }

    // Sağ tarafta "Town Hall'a Gir" hızlı aksiyon butonu
    const btnY = py + Math.round((ph - 38) * 0.5);
    this.drawActionButton(
      rightBtnX,
      btnY,
      rightBtnW,
      38,
      isCompact ? "Konak'a Gir" : "Town Hall'a Gir",
      this.primaryBtnText,
      true,
      false,
      0x1e3a5f,
      0x60a5fa,
      () => this.callbacks.onCommandSelectedEnterTownHall()
    );
  }

  private renderMultiUnitMode(
    px: number,
    py: number,
    pw: number,
    ph: number,
    multi: NonNullable<VillagerHudStatus['multiSelected']>,
    isCompact: boolean
  ): void {
    const taskParts: string[] = [];
    if (multi.choppingCount > 0) {
      taskParts.push(`${multi.choppingCount} Odun Topluyor`);
    }
    if (multi.movingCount > 0) {
      taskParts.push(`${multi.movingCount} Hareket Ediyor`);
    }
    const taskSummary =
      taskParts.length > 0 ? taskParts.join(', ') : 'Bekliyor';

    this.headerTitle.setFontSize(isCompact ? 12.5 : 13.5);
    this.headerTitle.setText(`Seçili Birimler: ${multi.count} Köylü`);
    this.headerTitle.setPosition(px + 14, py + 9);
    this.headerTitle.setVisible(true);

    this.headerSubtitle.setFontSize(isCompact ? 10.5 : 11);
    this.headerSubtitle.setText(
      `Taşınan Odun: ${multi.totalCarriedWood}/${multi.totalCapacity}  •  Durum: ${taskSummary}`
    );
    this.headerSubtitle.setPosition(px + 14, py + 27);
    this.headerSubtitle.setVisible(true);

    const rightBtnW = isCompact ? 112 : 144;
    const rightBtnX = px + pw - rightBtnW - 12;

    this.drawActionButton(
      rightBtnX,
      py + Math.round((ph - 38) * 0.5) + 6,
      rightBtnW,
      36,
      isCompact ? 'Toplu Gir' : "Grupça Konak'a Gir",
      this.primaryBtnText,
      true,
      false,
      0x1e3a5f,
      0x60a5fa,
      () => this.callbacks.onCommandSelectedEnterTownHall()
    );

    // Yakın plan köylü portreleri ızgarası (sayfalı, 50+ birim destekli)
    const gridAreaX = px + 14;
    const gridAreaW = Math.max(140, rightBtnX - gridAreaX - 12);
    const slotSize = isCompact ? 42 : 48;
    const slotGap = 6;
    const maxCols = Math.max(
      3,
      Math.min(
        MAX_ICON_SLOTS,
        Math.floor((gridAreaW + slotGap) / (slotSize + slotGap))
      )
    );

    const totalPages = Math.max(1, Math.ceil(multi.units.length / maxCols));
    this.multiPage = Phaser.Math.Clamp(this.multiPage, 0, totalPages - 1);
    const startIdx = this.multiPage * maxCols;
    const visibleUnits = multi.units.slice(startIdx, startIdx + maxCols);

    const slotY = py + (isCompact ? 47 : 48);
    for (let i = 0; i < visibleUnits.length; i += 1) {
      const item = visibleUnits[i];
      const sx = gridAreaX + i * (slotSize + slotGap);
      this.drawUnitPortraitCard(
        this.slotPortraitImages[i],
        sx,
        slotY,
        slotSize,
        item.id,
        item.category,
        item.hp,
        item.maxHp,
        true
      );

      const tagTxt = this.slotTexts[i];
      tagTxt.setText(item.shortTag);
      tagTxt.setPosition(sx + slotSize * 0.5, slotY + slotSize - 6);
      tagTxt.setVisible(true);

      this.clickableZones.push({
        rect: new Phaser.Geom.Rectangle(sx, slotY, slotSize, slotSize + 6),
        onClick: () => this.callbacks.onSelectSingleUnit(item.id),
      });
    }

    if (totalPages > 1) {
      this.renderPaginationButtons(
        rightBtnX - 8,
        py + 10,
        this.multiPage,
        totalPages,
        (delta) => {
          this.multiPage = Phaser.Math.Clamp(
            this.multiPage + delta,
            0,
            totalPages - 1
          );
          this.lastRenderSignature = '';
        }
      );
    }
  }

  private renderTownHallMode(
    px: number,
    py: number,
    pw: number,
    ph: number,
    unitStatus: VillagerHudStatus,
    snap: TownHallHudSnapshot,
    warnFlash: boolean,
    isCompact: boolean
  ): void {
    // SOL BÖLÜM: Town Hall yakın plan portresi + bina bilgileri + Köylü üretimi
    const iconX = px + 12;
    const iconY = py + 12;
    const iconSize = isCompact ? 46 : 54;
    this.drawTownHallPortraitCard(
      this.mainPortraitImage,
      iconX,
      iconY,
      iconSize,
      snap.hp,
      snap.maxHp
    );

    const leftTextX = iconX + iconSize + 10;
    const dividerX = px + Math.round(pw * (isCompact ? 0.5 : 0.48));

    this.rootBg.lineStyle(1, 0x334155, 0.85);
    this.rootBg.lineBetween(dividerX, py + 10, dividerX, py + ph - 10);

    this.headerTitle.setFontSize(isCompact ? 12 : 13.5);
    this.headerTitle.setText(
      isCompact
        ? `${snap.buildingName} (${snap.buildingSubtitle})`
        : `${snap.buildingName} — ${snap.buildingSubtitle}`
    );
    this.headerTitle.setPosition(leftTextX, py + 9);
    this.headerTitle.setVisible(true);

    this.headerSubtitle.setFontSize(isCompact ? 10 : 11);
    this.headerSubtitle.setText(
      `${snap.ageTitle}  •  Can: ${snap.hp}/${snap.maxHp}`
    );
    this.headerSubtitle.setPosition(leftTextX, py + 26);
    this.headerSubtitle.setVisible(true);

    let prodNote: string;
    if (snap.queueLength > 0) {
      prodNote =
        `Üretiliyor: ${snap.activeRemainingSec.toFixed(1)} sn` +
        (snap.queueLength > 1 ? ` (Sıra: ${snap.queueLength})` : '');
      this.col1Text.setColor('#86efac');
    } else if (!snap.canTrainVillager && snap.storedWood < snap.villagerWoodCost) {
      prodNote = `Yetersiz odun (${snap.storedWood}/${snap.villagerWoodCost}) • Erzak: Yakında`;
      this.col1Text.setColor(warnFlash ? '#fca5a5' : '#94a3b8');
    } else {
      prodNote = `Nüfus: ${unitStatus.totalVillagersCount} Köylü • Çağ/Teknoloji: Yakında`;
      this.col1Text.setColor('#cbd5e1');
    }
    this.col1Text.setFontSize(isCompact ? 10 : 10.5);
    this.col1Text.setText(prodNote);
    this.col1Text.setPosition(leftTextX, py + 43);
    this.col1Text.setVisible(true);

    const trainBtnX = px + 12;
    const trainBtnW = dividerX - px - 22;
    const trainBtnY = py + ph - 40;

    if (snap.queueLength > 0) {
      const barY = trainBtnY - 10;
      this.rootBg.fillStyle(0x1e293b, 0.95);
      this.rootBg.fillRoundedRect(trainBtnX, barY, trainBtnW, 6, 3);
      if (snap.activeProgressRatio > 0.01) {
        this.rootBg.fillStyle(0x4ade80, 0.95);
        this.rootBg.fillRoundedRect(
          trainBtnX,
          barY,
          Math.max(4, trainBtnW * snap.activeProgressRatio),
          6,
          3
        );
      }
    }

    const trainLabel = snap.canTrainVillager
      ? `+ Köylü Üret (${snap.villagerWoodCost} Odun • ${snap.villagerDurationSec} sn)`
      : snap.storedWood < snap.villagerWoodCost
        ? `Köylü Üret (${snap.villagerWoodCost} Odun Gerekli)`
        : 'Üretim Sırası Dolu';

    this.drawActionButton(
      trainBtnX,
      trainBtnY,
      trainBtnW,
      31,
      trainLabel,
      this.primaryBtnText,
      snap.canTrainVillager,
      warnFlash,
      0x166534,
      0x4ade80,
      () => {
        const ok = this.callbacks.onTrainVillager();
        if (!ok) {
          this.warnFlashUntil = this.scene.time.now + 650;
          this.lastRenderSignature = '';
        }
      }
    );

    // SAĞ BÖLÜM: Garnizon (yalnızca Town Hall seçildiğinde gösterilen birim sayısı, türleri ve portreler)
    const garX = dividerX + 12;
    const garW = px + pw - garX - 12;
    const gar = snap.garrison;

    const catSummaryParts: string[] = [];
    if (gar.countsByCategory.villager > 0) {
      catSummaryParts.push(`Köylü ×${gar.countsByCategory.villager}`);
    }
    if (gar.countsByCategory.warrior > 0) {
      catSummaryParts.push(`Savaşçı ×${gar.countsByCategory.warrior}`);
    }
    if (gar.countsByCategory.commander > 0) {
      catSummaryParts.push(`Komutan ×${gar.countsByCategory.commander}`);
    }
    const catDetail =
      catSummaryParts.length > 0
        ? ` (${catSummaryParts.join(', ')})`
        : ' — Boş (Sağ tıkla birim sokun)';

    this.col3TitleText.setFontSize(isCompact ? 11 : 12);
    this.col3TitleText.setText(
      `İçerideki Birimler: ${gar.totalCount}${isCompact ? '' : catDetail}`
    );
    this.col3TitleText.setPosition(garX, py + 9);
    this.col3TitleText.setVisible(true);

    const slotSize = isCompact ? 34 : 38;
    const slotGap = 5;
    const maxSlots = Math.max(
      3,
      Math.min(
        MAX_ICON_SLOTS,
        Math.floor((garW + slotGap) / (slotSize + slotGap))
      )
    );
    const totalPages = Math.max(1, Math.ceil(gar.units.length / maxSlots));
    this.garrisonPage = Phaser.Math.Clamp(
      this.garrisonPage,
      0,
      totalPages - 1
    );

    if (gar.totalCount === 0) {
      this.col2Text.setFontSize(isCompact ? 10 : 10.5);
      this.col2Text.setColor('#94a3b8');
      this.col2Text.setText(
        'İçeride birim yok. Seçili birimlerle binaya sağ tıklayarak\nveya "Konak\'a Gir" butonuyla garnizona alabilirsiniz (50+ kapasite).'
      );
      this.col2Text.setPosition(garX, py + 31);
      this.col2Text.setVisible(true);
    } else {
      const startIdx = this.garrisonPage * maxSlots;
      const visible = gar.units.slice(startIdx, startIdx + maxSlots);
      const slotY = py + 28;

      for (let i = 0; i < visible.length; i += 1) {
        const gu = visible[i];
        const sx = garX + i * (slotSize + slotGap);
        this.drawUnitPortraitCard(
          this.slotPortraitImages[i],
          sx,
          slotY,
          slotSize,
          gu.id,
          gu.category,
          gu.hp,
          gu.maxHp,
          false
        );

        const numMatch = /\d+$/.exec(gu.id);
        const tag = this.slotTexts[i];
        tag.setText(numMatch ? `#${numMatch[0]}` : gu.displayName.slice(0, 3));
        tag.setPosition(sx + slotSize * 0.5, slotY + slotSize - 5);
        tag.setVisible(true);

        // Portreye tıklanınca doğrudan o birimi dışarı çıkarır
        this.clickableZones.push({
          rect: new Phaser.Geom.Rectangle(sx, slotY, slotSize, slotSize + 5),
          onClick: () => this.callbacks.onEjectSingleUnit(gu.id),
        });
      }

      if (totalPages > 1) {
        this.renderPaginationButtons(
          px + pw - 14,
          py + 8,
          this.garrisonPage,
          totalPages,
          (delta) => {
            this.garrisonPage = Phaser.Math.Clamp(
              this.garrisonPage + delta,
              0,
              totalPages - 1
            );
            this.lastRenderSignature = '';
          }
        );
      }
    }

    const hasGarrison = gar.totalCount > 0;
    const ejectBtnY = py + ph - 40;
    const halfBtnW = Math.floor((garW - 8) * 0.5);

    this.drawActionButton(
      garX,
      ejectBtnY,
      halfBtnW,
      31,
      'Tek Çıkar',
      this.secondaryBtnText,
      hasGarrison,
      false,
      0x334155,
      0x94a3b8,
      () => {
        if (hasGarrison) {
          this.callbacks.onEjectSingleUnit();
        }
      }
    );

    this.drawActionButton(
      garX + halfBtnW + 8,
      ejectBtnY,
      garW - halfBtnW - 8,
      31,
      hasGarrison ? `Tümünü Çıkar (${gar.totalCount})` : 'Tümünü Çıkar',
      this.tertiaryBtnText,
      hasGarrison,
      false,
      0x78350f,
      0xf59e0b,
      () => {
        if (hasGarrison) {
          this.callbacks.onEjectAllUnits();
        }
      }
    );
  }

  private renderIdleSettlementMode(
    px: number,
    py: number,
    pw: number,
    ph: number,
    unitStatus: VillagerHudStatus,
    townHallSnap: TownHallHudSnapshot,
    isCompact: boolean
  ): void {
    const iconX = px + 14;
    const iconY = py + 14;
    const iconSize = isCompact ? 48 : 56;
    this.drawTownHallPortraitCard(
      this.mainPortraitImage,
      iconX,
      iconY,
      iconSize,
      townHallSnap.hp,
      townHallSnap.maxHp
    );

    const textX = iconX + iconSize + 12;
    this.headerTitle.setFontSize(isCompact ? 12.5 : 14);
    this.headerTitle.setText(
      `Karahanlı Yerleşimi  —  ${townHallSnap.ageTitle}`
    );
    this.headerTitle.setPosition(textX, py + 12);
    this.headerTitle.setVisible(true);

    this.col1Text.setFontSize(isCompact ? 10.5 : 11.5);
    this.col1Text.setColor('#cbd5e1');
    this.col1Text.setText(
      `Toplam Nüfus: ${unitStatus.totalVillagersCount} Köylü   •   Depodaki Odun: ${unitStatus.totalStoredWood}\n` +
        `Erzak Ekonomisi & Savaş Sistemi: Geliştirme Aşamasında\n` +
        `İpucu: Köylü üretimi ve garnizon yönetimi için Town Hall binasını seçin.`
    );
    this.col1Text.setPosition(textX, py + 34);
    this.col1Text.setVisible(true);

    if (!isCompact) {
      const btnW = 148;
      const btnX = px + pw - btnW - 14;
      this.drawActionButton(
        btnX,
        py + Math.round((ph - 36) * 0.5),
        btnW,
        36,
        'Town Hall Aç',
        this.primaryBtnText,
        true,
        false,
        0x78350f,
        0xf59e0b,
        () => this.callbacks.onSelectTownHall()
      );
    }
  }

  private renderPaginationButtons(
    rightEdgeX: number,
    topY: number,
    page: number,
    totalPages: number,
    onStep: (delta: number) => void
  ): void {
    const btnW = 20;
    const btnH = 18;
    const nextX = rightEdgeX - btnW;
    const prevX = nextX - btnW - 4;

    this.pageInfoText.setText(`${page + 1}/${totalPages}  ‹   ›`);
    this.pageInfoText.setPosition(rightEdgeX - 4, topY + 2);
    this.pageInfoText.setVisible(true);

    this.iconOverlayGraphics.fillStyle(0x1e293b, 0.9);
    this.iconOverlayGraphics.fillRoundedRect(prevX, topY, btnW, btnH, 4);
    this.iconOverlayGraphics.fillRoundedRect(nextX, topY, btnW, btnH, 4);
    this.iconOverlayGraphics.lineStyle(1, 0x64748b, 0.9);
    this.iconOverlayGraphics.strokeRoundedRect(prevX, topY, btnW, btnH, 4);
    this.iconOverlayGraphics.strokeRoundedRect(nextX, topY, btnW, btnH, 4);

    this.clickableZones.push({
      rect: new Phaser.Geom.Rectangle(prevX, topY, btnW, btnH),
      onClick: () => onStep(-1),
    });
    this.clickableZones.push({
      rect: new Phaser.Geom.Rectangle(nextX, topY, btnW, btnH),
      onClick: () => onStep(1),
    });
  }

  private drawActionButton(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    textObj: Phaser.GameObjects.Text,
    enabled: boolean,
    warnFlash: boolean,
    fillColor: number,
    strokeColor: number,
    onClick: () => void
  ): void {
    const bgFill = enabled
      ? fillColor
      : warnFlash
        ? 0x450a0a
        : 0x1e293b;
    const stroke = enabled
      ? strokeColor
      : warnFlash
        ? 0xef4444
        : 0x475569;

    this.rootBg.fillStyle(bgFill, enabled ? 0.95 : 0.72);
    this.rootBg.fillRoundedRect(x, y, w, h, 8);
    this.rootBg.lineStyle(1.3, stroke, 0.95);
    this.rootBg.strokeRoundedRect(x, y, w, h, 8);

    textObj.setText(label);
    textObj.setColor(
      enabled ? '#f8fafc' : warnFlash ? '#fecaca' : '#64748b'
    );
    textObj.setPosition(x + w * 0.5, y + h * 0.5);
    textObj.setVisible(true);

    this.clickableZones.push({
      rect: new Phaser.Geom.Rectangle(x, y, w, h),
      onClick,
    });
  }

  /**
   * Karahanlı dönemi börk ve kaftanına uygun yakın plan karakter portresini,
   * çerçevesini ve alt can çubuğunu çizer.
   */
  private drawUnitPortraitCard(
    img: Phaser.GameObjects.Image,
    x: number,
    y: number,
    size: number,
    unitId: string,
    category: UnitCategory,
    hp: number,
    maxHp: number,
    brightBorder: boolean
  ): void {
    const g = this.iconOverlayGraphics;
    const borderTone = brightBorder ? 0x4ade80 : 0xd97706;

    if (category === 'villager') {
      const texKey = this.resolveVillagerPortraitKey(unitId);
      img.setTexture(texKey);
      img.setPosition(x + 1, y + 1);
      img.setDisplaySize(size - 2, size - 2);
      img.setVisible(true);
    } else {
      // Gelecekteki savaşçı / komutan birimleri için rozet altlığı
      img.setVisible(false);
      const bgTone = category === 'commander' ? 0x3b1d1d : 0x1e293b;
      g.fillStyle(bgTone, 0.96);
      g.fillRect(x, y, size, size);
      const cx = x + size * 0.5;
      const cy = y + size * 0.44;
      const s = size / 42;
      g.fillStyle(category === 'commander' ? 0xf59e0b : 0x94a3b8, 1);
      g.fillCircle(cx, cy - 2 * s, 6.5 * s);
    }

    // Portre dış çerçevesi
    g.lineStyle(1.6, borderTone, 0.95);
    g.strokeRect(x, y, size, size);

    // Alt can çubuğu
    const barW = size - 6;
    const barH = 4;
    const barX = x + 3;
    const barY = y + size - 5;
    const ratio = maxHp > 0 ? Phaser.Math.Clamp(hp / maxHp, 0, 1) : 1;

    g.fillStyle(0x020617, 0.92);
    g.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
    g.fillStyle(ratio > 0.45 ? 0x22c55e : 0xf59e0b, 1);
    g.fillRect(barX, barY, Math.max(2, barW * ratio), barH);
  }

  /**
   * Kurt armalı Eski Türk Hükümdar Konağı (Town Hall) yakın plan portre kartını çizer.
   */
  private drawTownHallPortraitCard(
    img: Phaser.GameObjects.Image,
    x: number,
    y: number,
    size: number,
    hp: number,
    maxHp: number
  ): void {
    img.setTexture(TOWN_HALL_PORTRAIT_KEY);
    img.setPosition(x + 1, y + 1);
    img.setDisplaySize(size - 2, size - 2);
    img.setVisible(true);

    const g = this.iconOverlayGraphics;
    g.lineStyle(1.6, 0xd97706, 0.96);
    g.strokeRect(x, y, size, size);

    const ratio = maxHp > 0 ? Phaser.Math.Clamp(hp / maxHp, 0, 1) : 1;
    g.fillStyle(0x020617, 0.92);
    g.fillRect(x + 3, y + size - 6, size - 6, 5);
    g.fillStyle(0x22c55e, 1);
    g.fillRect(x + 4, y + size - 5, Math.max(2, (size - 8) * ratio), 3.5);
  }

  private resolveVillagerPortraitKey(unitId: string): string {
    const match = /\d+$/.exec(unitId);
    if (match) {
      const idx = (Math.max(1, parseInt(match[0], 10)) - 1) % VILLAGER_PORTRAIT_KEYS.length;
      return VILLAGER_PORTRAIT_KEYS[idx];
    }
    let hash = 0;
    for (let i = 0; i < unitId.length; i += 1) {
      hash = (hash * 31 + unitId.charCodeAt(i)) >>> 0;
    }
    return VILLAGER_PORTRAIT_KEYS[hash % VILLAGER_PORTRAIT_KEYS.length];
  }

  private hideTransientVisuals(): void {
    this.mainPortraitImage.setVisible(false);
    for (const img of this.slotPortraitImages) {
      img.setVisible(false);
    }
    this.headerTitle.setVisible(false);
    this.headerSubtitle.setVisible(false);
    this.col1Text.setVisible(false);
    this.col2Text.setVisible(false);
    this.col3TitleText.setVisible(false);
    this.primaryBtnText.setVisible(false);
    this.secondaryBtnText.setVisible(false);
    this.tertiaryBtnText.setVisible(false);
    this.pageInfoText.setVisible(false);
    for (const t of this.slotTexts) {
      t.setVisible(false);
    }
  }

  private buildSignature(
    w: number,
    h: number,
    u: VillagerHudStatus,
    th: TownHallHudSnapshot,
    warn: boolean
  ): string {
    const su = u.selectedUnit;
    const mu = u.multiSelected;
    const progBucket = Math.round(th.activeProgressRatio * 50);
    const remBucket = Math.ceil(th.activeRemainingSec * 10);

    return [
      `${w}x${h}`,
      u.totalStoredWood,
      u.totalVillagersCount,
      u.fieldVillagersCount,
      u.garrisonedVillagersCount,
      u.selectedCount,
      u.touchBoxSelectMode ? 1 : 0,
      th.selected ? 1 : 0,
      th.canTrainVillager ? 1 : 0,
      th.queueLength,
      progBucket,
      remBucket,
      th.garrison.totalCount,
      this.multiPage,
      this.garrisonPage,
      warn ? 1 : 0,
      su
        ? `${su.id}:${su.hp}:${su.carriedResource.amount}:${su.taskDescription}`
        : '-',
      mu
        ? `${mu.count}:${mu.totalCarriedWood}:${mu.choppingCount}:${mu.movingCount}`
        : '-',
    ].join('|');
  }
}
