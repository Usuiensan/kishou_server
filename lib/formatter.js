const COLORS = {
    MAJOR_TSUNAMI: '#ff00ff',
    TSUNAMI_WARNING: '#FF2800',
    TSUNAMI_ADVISORY: '#FAF500'
};

const INTENSITY_MAP = {
    '7': '7',
    '6+': '6強',
    '6-': '6弱',
    '5+': '5強',
    '5-': '5弱',
    '4': '4',
    '3': '3',
    '2': '2',
    '1': '1'
};

function splitAreasHelper(label, areas, limit = 6) {
    const lines = [];
    if (!areas || areas.length === 0) return lines;
    for (let i = 0; i < areas.length; i += limit) {
        const chunk = areas.slice(i, i + limit);
        lines.push(`${label} ${chunk.join(' ')}`);
    }
    return lines;
}

function formatEarthquake(eq) {
    const lines = [];
    const timeStr = eq.originTimeFormatted ? `${eq.originTimeFormatted}ごろ ` : '';
    
    // 1. 発生時刻と発生通知
    lines.push(`${timeStr}地震がありました`);

    // 2. 津波情報 (最優先)
    let comment = (eq.comment || "")
        .replace("この地震について、緊急地震速報を発表しています。", "")
        .replace("を発表中です。", "が発表されています。")
        .trim();
    
    if (eq.infoKind === "震度速報") {
        comment = "揺れが強かった沿岸部では\n念のため津波に注意してください";
    }
    if (comment) lines.push(comment);

    // 3. 震源情報
    const eqInfo = eq.earthquake;
    if (eqInfo && eqInfo.hypocenter) {
        const magStr = eqInfo.magnitude === 'NaN' 
            ? (eqInfo.magnitudeDescription || '不明') 
            : `マグニチュード${eqInfo.magnitude}`;
        
        const depthMatch = eqInfo.hypocenter?.coordinate?.match(/-(\d+)\/$/);
        const depth = depthMatch ? `${parseInt(depthMatch[1]) / 1000}キロ` : '不明';
        lines.push(`震源は${eqInfo.hypocenter.name}\n深さ${depth}  ${magStr}`);
    }

    // 4. 震度情報
    if (eq.intensity && eq.intensity.maxInt) {
        // 市町村レベルの表示を優先する
        const targetGroups = (eq.intensity.cityGroups && Object.keys(eq.intensity.cityGroups).length > 0)
            ? eq.intensity.cityGroups
            : eq.intensity.groups;

        const intensityOrder = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
        intensityOrder.forEach(int => {
            const areas = targetGroups?.[int];
            if (areas && areas.length > 0) {
                const label = `[震度${INTENSITY_MAP[int] || int}]`;
                lines.push(...splitAreasHelper(label, areas));
            }
        });
    }

    return {
        type: "emergency",
        id: eq.eventId,
        lines: lines
    };
}

function formatTsunami(ts) {
    const lines = [];
    const groups = ts.tsunami.groups;

    if (groups.majorTsunami.length > 0) {
        const label = `<color=${COLORS.MAJOR_TSUNAMI}>[大津波警報]</color>`;
        lines.push(...splitAreasHelper(label, groups.majorTsunami));
    }
    if (groups.warning.length > 0) {
        const label = `<color=${COLORS.TSUNAMI_WARNING}>[津波警報]</color>`;
        lines.push(...splitAreasHelper(label, groups.warning));
    }
    if (groups.advisory.length > 0) {
        const label = `<color=${COLORS.TSUNAMI_ADVISORY}>[津波注意報]</color>`;
        lines.push(...splitAreasHelper(label, groups.advisory));
    }

    lines.push("");
    
    // 津波タイトルの動的変更
    let tsunamiTitle = "津波注意報";
    if (groups.majorTsunami.length > 0) {
        tsunamiTitle = "大津波警報";
    } else if (groups.warning.length > 0) {
        tsunamiTitle = "津波警報";
    }
    
    lines.push(`${tsunamiTitle}が出ている各沿岸の\n津波到達予想は次のとおりです`);

    ts.tsunami.forecasts.forEach(f => {
        let color = "";
        const kindCode = String(f.category.code);
        if (['52', '53'].includes(kindCode)) color = COLORS.MAJOR_TSUNAMI;
        else if (['51'].includes(kindCode)) color = COLORS.TSUNAMI_WARNING;
        else if (['62'].includes(kindCode)) color = COLORS.TSUNAMI_ADVISORY;

        if (color) {
            const time = f.formattedArrivalTime || f.firstHeight?.condition || '不明';
            lines.push(`<color=${color}>[${f.category.kind}]</color>${f.area.name}\n[予想] ${f.maxHeight} ${time}`);
        }
    });

    // 震度情報の追加 (VTSEに含まれる場合)
    if (ts.intensity && ts.intensity.maxInt) {
        lines.push("");
        lines.push("この地震による各地の震度は次のとおりです");
        
        const targetGroups = (ts.intensity.cityGroups && Object.keys(ts.intensity.cityGroups).length > 0)
            ? ts.intensity.cityGroups
            : ts.intensity.groups;

        const intensityOrder = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
        intensityOrder.forEach(int => {
            const areas = targetGroups?.[int];
            if (areas && areas.length > 0) {
                const label = `[震度${INTENSITY_MAP[int] || int}]`;
                lines.push(...splitAreasHelper(label, areas));
            }
        });
    }

    return {
        type: "emergency",
        id: ts.eventId,
        lines: lines
    };
}

module.exports = { formatEarthquake, formatTsunami };
