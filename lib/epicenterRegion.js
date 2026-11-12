'use strict';

// 気象庁「地震情報で用いる震央地名」の範囲ポリゴン（data/jma_epicenter_regions.json、
// 中身はGeoJSON）を使った、震央座標→震央地名の包含判定。データの出典・ライセンスは
// data/JMA_EPICENTER_REGIONS.md を参照。
// ポリゴンの経度は0〜360度表記（本初子午線またぎはマルチポリゴン分割）。

const collection = require('../data/jma_epicenter_regions.json');

function polygonsOf(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

const REGIONS = (collection.features || []).map((feature) => {
  const polygons = polygonsOf(feature.geometry);
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return {
    code: Number(feature.properties?.id),
    name: feature.properties?.name || '',
    reading: feature.properties?.name_kana || '',
    polygons,
    bbox: { minLon, minLat, maxLon, maxLat },
    bboxArea: (maxLon - minLon) * (maxLat - minLat),
  };
}).filter((region) => region.name && Number.isFinite(region.code));

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function regionContains(region, lon, lat) {
  for (const polygon of region.polygons) {
    if (!pointInRing(lon, lat, polygon[0])) continue;
    if (polygon.slice(1).some((hole) => pointInRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

// 震央座標（緯度・経度）から震央地名 { code, name, reading } を返す。
// 該当なし・不正な座標では null。複数ポリゴンに含まれる場合は
// バウンディングボックスが小さい（＝より限定的な）地域を優先する。
function lookupEpicenterRegion(latitude, longitude) {
  if (latitude == null || longitude == null || latitude === '' || longitude === '') return null;
  const lat = Number(latitude);
  let lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 360) return null;
  if (lon < 0) lon += 360;
  let best = null;
  for (const region of REGIONS) {
    const { bbox } = region;
    if (lon < bbox.minLon || lon > bbox.maxLon || lat < bbox.minLat || lat > bbox.maxLat) continue;
    if (!regionContains(region, lon, lat)) continue;
    if (!best || region.bboxArea < best.bboxArea) best = region;
  }
  return best ? { code: best.code, name: best.name, reading: best.reading } : null;
}

module.exports = { lookupEpicenterRegion, EPICENTER_REGION_COUNT: REGIONS.length };
