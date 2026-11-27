import React, { useMemo } from 'react';
import { getBuildableDef, getModuleDef } from '../core/catalog';
import { getBuildingSizeCells, getFrameGridSpec, getModuleBoundsM, getModuleSizeUnits } from '../core/geometry';
import { useI18n } from '../core/i18n';
import type { BlueprintDocument } from '../core/types';
import type { CadThemeId } from '../renderer/theme';

interface BlueprintThumbnailProps {
  doc: BlueprintDocument | null;
  cacheKey: string;
  theme: CadThemeId;
  loading?: boolean;
}

const MAX_CACHE_ENTRIES = 160;
const thumbCache = new Map<string, string>();

function setCachedThumb(key: string, dataUrl: string): void {
  if (thumbCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = thumbCache.keys().next().value;
    if (firstKey !== undefined) thumbCache.delete(firstKey);
  }
  thumbCache.set(key, dataUrl);
}

/**
 * Render an in-game-inspired crisp top-down CAD schematic thumbnail onto an offscreen canvas.
 * Handles everything from single starter modules up to 26,000+ building mega-stations in a few ms.
 */
export function renderBlueprintThumbnailDataUrl(doc: BlueprintDocument, theme: CadThemeId): string {
  const W = 440;
  const H = 264;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const isLight = theme === 'stealth-cad';
  const bg = isLight ? '#edf1f6' : '#070b11';
  const gridCol = isLight ? 'rgba(65, 92, 128, 0.09)' : 'rgba(126, 162, 206, 0.08)';
  const hullStroke = isLight ? '#2b507d' : '#7ba6d6';
  const hullInner = isLight ? 'rgba(43, 80, 125, 0.14)' : 'rgba(120, 168, 220, 0.16)';
  const solarAccent = isLight ? '#1c6ea4' : '#66c7e8';
  const turretAccent = isLight ? '#a64d3c' : '#d6826c';
  const beltCol = isLight ? '#227c96' : '#52bed8';
  const crafterCol = isLight ? '#b57b24' : '#d4b277';
  const storageCol = isLight ? '#267a4e' : '#56ba88';
  const logisticsCol = isLight ? '#3867a8' : '#8db8ec';
  const emptyStroke = isLight ? '#8ea0b5' : '#2f4156';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle schematic grid
  ctx.strokeStyle = gridCol;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 22; x < W; x += 22) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
  }
  for (let y = 22; y < H; y += 22) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  ctx.stroke();

  // Compute world XY bounds across all modules & buildings
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minFloor = Infinity;
  let maxFloor = -Infinity;

  const unitM = getFrameGridSpec(doc.category).unitM;
  for (const m of doc.modules) {
    const def = getModuleDef(m.type);
    const [x0, y0, x1, y1] = def
      ? getModuleBoundsM(m, def)
      : [m.gx * unitM, m.gy * unitM, (m.gx + 1) * unitM, (m.gy + 1) * unitM];
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
    if (m.floor < minFloor) minFloor = m.floor;
    if (m.floor > maxFloor) maxFloor = m.floor;
  }

  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    const [bw, bd] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + bw > maxX) maxX = b.x + bw;
    if (b.y + bd > maxY) maxY = b.y + bd;
    if (b.floor < minFloor) minFloor = b.floor;
    if (b.floor > maxFloor) maxFloor = b.floor;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    // Empty blueprint crosshair icon
    ctx.strokeStyle = emptyStroke;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(W / 2 - 44, H / 2 - 32, 88, 64);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(W / 2 - 12, H / 2);
    ctx.lineTo(W / 2 + 12, H / 2);
    ctx.moveTo(W / 2, H / 2 - 12);
    ctx.lineTo(W / 2, H / 2 + 12);
    ctx.stroke();
    return canvas.toDataURL('image/png');
  }

  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const pad = 26;
  const scale = Math.min((W - pad * 2) / worldW, (H - pad * 2) / worldH);
  const offsetX = (W - worldW * scale) * 0.5 - minX * scale;
  const offsetY = (H - worldH * scale) * 0.5 - minY * scale;

  const toX = (wx: number) => offsetX + wx * scale;
  const toY = (wy: number) => offsetY + wy * scale;
  const floorRange = Math.max(1, maxFloor - minFloor);

  // Default ship orientation: bow (+X) faces LEFT (180° rotated to match 3D ship canvas)
  const isShip = doc.category === 'ship';
  if (isShip) {
    ctx.save();
    ctx.translate(W, H);
    ctx.rotate(Math.PI);
  }

  // Layer 1: Station/Ship modules (sorted low floor -> high floor for natural top-down depth)
  const sortedModules = [...doc.modules].sort((a, b) => a.floor - b.floor);
  for (const m of sortedModules) {
    const def = getModuleDef(m.type);
    const [x0, y0, x1, y1] = def
      ? getModuleBoundsM(m, def)
      : [m.gx * unitM, m.gy * unitM, (m.gx + 1) * unitM, (m.gy + 1) * unitM];
    const rx = toX(x0);
    const ry = toY(y0);
    const rw = Math.max(2, (x1 - x0) * scale);
    const rh = Math.max(2, (y1 - y0) * scale);
    const floorNorm = (m.floor - minFloor) / floorRange;

    const alpha = isLight ? 0.1 + floorNorm * 0.14 : 0.13 + floorNorm * 0.18;
    const isSolar = m.type.includes('Solar') || m.type.includes('WarpDrive') || m.type.includes('Shield');
    const isReactor = m.type === 'BPO_ReactorBlock_Small';
    const isTurret = m.type.includes('Turret') || m.type.includes('Cannon') || m.type.includes('Lance');
    const isCorner = m.type === 'BPO_StationCorner_01';
    const isDock = m.type.includes('Dock') || m.type.includes('Shipyard') || m.type.includes('MiningDrone');

    ctx.fillStyle = isReactor
      ? isLight
        ? `rgba(181, 123, 36, ${alpha + 0.1})`
        : `rgba(200, 169, 120, ${alpha + 0.1})`
      : isSolar
        ? isLight
          ? `rgba(28, 110, 164, ${alpha + 0.08})`
          : `rgba(82, 184, 224, ${alpha + 0.08})`
        : isTurret
          ? isLight
            ? `rgba(166, 77, 60, ${alpha + 0.08})`
            : `rgba(214, 130, 108, ${alpha + 0.08})`
          : isLight
            ? `rgba(43, 80, 125, ${alpha})`
            : `rgba(116, 160, 212, ${alpha})`;

    ctx.strokeStyle = isReactor ? crafterCol : isSolar ? solarAccent : isTurret ? turretAccent : hullStroke;
    ctx.lineWidth = Math.max(1, Math.min(2, scale * 0.12));

    if (isCorner) {
      // 45-degree beveled corner polygon
      const corners: Array<[number, number]> = [
        [rx, ry],
        [rx + rw, ry],
        [rx + rw, ry + rh],
        [rx, ry + rh],
      ];
      // Cut corner opposite docking edges according to rotation (rot 0: NE bevel cut)
      const cutIdx = (1 + m.rotation) % 4;
      const pts = corners.filter((_, idx) => idx !== cutIdx);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);

      // Architectural silhouette details when module is large enough on screen
      if (rw >= 14 && rh >= 14) {
        if (isSolar) {
          // Mk.2/Mk.3 razor-thin vertical sail spine vs Mk.1 horizontal wing ribs
          ctx.beginPath();
          if (m.type.endsWith('_02') || m.type.endsWith('_03')) {
            if (m.rotation % 2 === 0) {
              ctx.moveTo(rx + rw * 0.5, ry + 2);
              ctx.lineTo(rx + rw * 0.5, ry + rh - 2);
            } else {
              ctx.moveTo(rx + 2, ry + rh * 0.5);
              ctx.lineTo(rx + rw - 2, ry + rh * 0.5);
            }
          } else {
            ctx.moveTo(rx + 3, ry + rh * 0.35);
            ctx.lineTo(rx + rw - 3, ry + rh * 0.35);
            ctx.moveTo(rx + 3, ry + rh * 0.65);
            ctx.lineTo(rx + rw - 3, ry + rh * 0.65);
          }
          ctx.stroke();
        } else if (isTurret) {
          const cx = rx + rw * 0.5;
          const cy = ry + rh * 0.5;
          const r = Math.min(rw, rh) * 0.24;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          const ang = (m.rotation * Math.PI) / 2;
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(ang) * rw * 0.48, cy + Math.sin(ang) * rh * 0.48);
          ctx.stroke();
        } else if (isDock) {
          const inset = Math.max(2, Math.min(rw, rh) * 0.16);
          ctx.strokeStyle = hullInner;
          ctx.strokeRect(rx + inset, ry + inset, rw - inset * 2, rh - inset * 2);
        } else if (def && def.floors.length > 0 && rw >= 22) {
          // Walkable interior bay outline
          const [wu, du] = getModuleSizeUnits(def, m.rotation);
          const padPx = Math.max(2, scale * 1.1);
          if (wu >= 1 && du >= 1 && rw > padPx * 2.5 && rh > padPx * 2.5) {
            ctx.strokeStyle = hullInner;
            ctx.lineWidth = 1;
            ctx.strokeRect(rx + padPx, ry + padPx, rw - padPx * 2, rh - padPx * 2);
          }
        }
      }
    }
  }

  // Layer 2: Interior buildings & logistics (belts first, machines on top)
  const belts: typeof doc.buildings = [];
  const structures: typeof doc.buildings = [];
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (def?.kind === 'belt' || def?.kind === 'underground') {
      belts.push(b);
    } else {
      structures.push(b);
    }
  }

  if (belts.length > 0) {
    ctx.fillStyle = beltCol;
    const minBeltPx = Math.max(1.15, scale * 0.72);
    for (const b of belts) {
      const bx = toX(b.x + 0.14);
      const by = toY(b.y + 0.14);
      ctx.fillRect(bx, by, minBeltPx, minBeltPx);
    }
  }

  for (const b of structures) {
    const def = getBuildableDef(b.type);
    const [bw, bd] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
    const bx = toX(b.x);
    const by = toY(b.y);
    const rw = Math.max(1.6, bw * scale);
    const rh = Math.max(1.6, bd * scale);

    if (def?.kind === 'container') {
      ctx.fillStyle = storageCol;
    } else if (def?.kind === 'splitter' || def?.kind === 'balancer' || def?.kind === 'teleporter') {
      ctx.fillStyle = logisticsCol;
    } else {
      ctx.fillStyle = crafterCol;
    }
    ctx.fillRect(bx, by, rw, rh);

    if (rw >= 6 && rh >= 6) {
      ctx.strokeStyle = isLight ? 'rgba(20, 28, 39, 0.35)' : 'rgba(7, 11, 17, 0.65)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, rw - 1, rh - 1);
    }
  }

  if (isShip) ctx.restore();
  return canvas.toDataURL('image/png');
}

export const BlueprintThumbnail: React.FC<BlueprintThumbnailProps> = ({ doc, cacheKey, theme, loading }) => {
  const { t } = useI18n();
  const dataUrl = useMemo(() => {
    if (!doc || typeof document === 'undefined') return null;
    const fullKey = `${theme}::${cacheKey}`;
    const existing = thumbCache.get(fullKey);
    if (existing) return existing;
    const rendered = renderBlueprintThumbnailDataUrl(doc, theme);
    if (rendered) setCachedThumb(fullKey, rendered);
    return rendered;
  }, [doc, cacheKey, theme]);

  if (dataUrl) {
    return <img className="bp-thumb-img" src={dataUrl} alt="" draggable={false} />;
  }

  return (
    <div className={`bp-thumb-placeholder ${loading ? 'loading' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 120 72" className="bp-thumb-placeholder-svg">
        <rect x="26" y="14" width="68" height="44" rx="3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="4 3" />
        <line x1="52" y1="36" x2="68" y2="36" stroke="currentColor" strokeWidth="1.2" />
        <line x1="60" y1="28" x2="60" y2="44" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span>{loading ? t('加载中...', 'Loading...') : t('待载入', 'Pending')}</span>
    </div>
  );
};
