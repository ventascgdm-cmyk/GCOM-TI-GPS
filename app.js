// ============================================================================
// GRUDICOM TI & GPS - C4 MASTER (v6.1 - Fix Anti-Congelamiento y Modo Offline)
// ============================================================================

const firebaseConfig = { databaseURL: "https://monitoreo-logistica-default-rtdb.firebaseio.com/" };
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

function mostrarNotificacion(msg) {
    document.getElementById('sysToastBody').innerText = msg;
    new bootstrap.Toast(document.getElementById('sysToast')).show();
}

// --- FIX ANTI-CONGELAMIENTO (UI_PAUSED SEGURO) ---
let UI_PAUSED = false;
document.addEventListener('show.bs.dropdown', (e) => { 
    UI_PAUSED = true; document.body.classList.add('dropdown-open'); 
    let tr = e.target.closest('tr'); if(tr) tr.classList.add('dropdown-active');
});
document.addEventListener('hide.bs.dropdown', (e) => { 
    UI_PAUSED = false; document.body.classList.remove('dropdown-open'); 
    let tr = e.target.closest('tr'); if(tr) tr.classList.remove('dropdown-active');
    setTimeout(solicitarRenderizado, 200); 
});
document.addEventListener('focusin', (e) => { 
    // Solo pausa la UI si estás escribiendo DENTRO de la tabla principal, no en los Hubs
    if(['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        if(e.target.closest('#mainTable')) UI_PAUSED = true; 
    }
});
document.addEventListener('focusout', (e) => { 
    UI_PAUSED = false; setTimeout(solicitarRenderizado, 200); 
});

let currentUser = null; let configSistema = { tokens: [] }; let dataClientes = {}; let viajesActivos = {};
let unidadesGlobales = {}; let diccChoferesGlobal = {}; let ramDrivers = {}; let dbOperadores = {};
let geocercasNativas = []; let activeSIDs = {}; let pollingInterval = null; let lmap = null;
let mapVisible = false; let mapLayerGroup = null; let geofenceLayerGroup = null; let estadoTokens = {};
let datosAgrupadosGlobal = {}; let mapaMarcadores = {}; 
let alertasSeguridad = {}; let alertasLogistica = {};
let geocodeCache = JSON.parse(localStorage.getItem('tms_geoCache')) || {}; 
let geoQueue = []; let isGeocoding = false; let motorArrancado = false; let isSyncingFlotas = false;
let currentCaptureBlob = null; let edChipsArray = []; let edChipsContArray = []; 

// --- SISTEMA ANTI-PARPADEO ---
let renderTimer = null;
function solicitarRenderizado() {
    if(renderTimer) return; 
    renderTimer = setTimeout(() => { renderTimer = null; renderizarBitacora(); if(mapVisible) actualizarMarcadoresMapa(); }, 200); 
}

// --- ORDENAMIENTO MANUAL ---
let sortState = { column: null, direction: 'asc' };
window.cambiarOrden = function(col) {
    if (sortState.column === col) { sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc'; } 
    else { sortState.column = col; sortState.direction = 'asc'; } solicitarRenderizado();
};

const columnasDef = {
    'col-unidad': { titulo: 'UNIDAD <i class="fa-solid fa-sort sort-icon" title="Ordenar por Unidad" onclick="cambiarOrden(\'unidad\')"></i>', ancho: '140' },
    'col-operador': { titulo: 'OPERADOR GPS', ancho: '150' },
    'col-ruta': { titulo: 'RUTA (O ➔ D) <i class="fa-solid fa-sort sort-icon" title="Ordenar por Origen" onclick="cambiarOrden(\'ruta\')"></i>', ancho: '190' },
    'col-horarios': { titulo: 'HORARIOS', ancho: '125' }, 
    'col-estatus': { titulo: 'ESTATUS <i class="fa-solid fa-sort sort-icon" title="Ordenar por Estatus" onclick="cambiarOrden(\'estatus\')"></i>', ancho: '120' },
    'col-gps': { titulo: 'UBICACIÓN Y GEOCERCA', ancho: '420' }, 
    'col-alertas': { titulo: 'ALERTAS', ancho: '90' },
    'col-historial': { titulo: 'HISTORIAL LOG', ancho: '240' }, 
    'col-accion': { titulo: '<i class="fa-solid fa-bars"></i>', ancho: '65' }
};

let colOrder = JSON.parse(localStorage.getItem('tms_colOrder'));
if (!colOrder || colOrder.length !== Object.keys(columnasDef).length) { colOrder = Object.keys(columnasDef); localStorage.setItem('tms_colOrder', JSON.stringify(colOrder)); }
let hiddenCols = JSON.parse(localStorage.getItem('tms_hiddenCols')) || { 'col-alertas': false, 'col-historial': false };

window.estatusData = { "s1":{nombre:"1. Ruta",col:"#10b981"}, "s2":{nombre:"1.1 PARADO",col:"#ef4444"}, "s3":{nombre:"1.2 RETEN",col:"#d97706"}, "s4":{nombre:"1.3 Resguardo",col:"#8b5cf6"}, "s5":{nombre:"1.4 REGRESANDO",col:"#f59e0b"}, "s6":{nombre:"2. Incidencia",col:"#be123c"}, "s7":{nombre:"3. Cargando",col:"#64748b"}, "s8":{nombre:"4. Descargando",col:"#0284c7"}, "s9":{nombre:"5. Patio GDL",col:"#06b6d4"}, "s10":{nombre:"6. Patio Reynosa",col:"#14b8a6"}, "s11":{nombre:"7. Taller",col:"#94a3b8"}, "s12":{nombre:"8. Finalizado",col:"#1e40af"}, "s13":{nombre:"9. Baja cobertura",col:"#fbbf24"}, "s14":{nombre:"ALIMENTOS",col:"#f59e0b"} };

document.addEventListener("visibilitychange", () => { if (document.visibilityState === 'visible' && motorArrancado) { sincronizarFlotas(); } });

// --- FUNCIONES MATEMÁTICAS ---
function getSafeNumber(val) { if (!val) return null; let n = Number(val); return isNaN(n) ? null : n; }
function limpiarStr(str) { return str ? String(str).trim().replace(/\s+/g, ' ').toUpperCase() : ""; }
function escapeSafe(str) { return str ? String(str).replace(/'/g, "\\'") : ""; }
function hexToRgba(hex, alpha) { if(!hex || hex.length !== 7) return `rgba(15, 23, 42, ${alpha})`; let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16); return `rgba(${r}, ${g}, ${b}, ${alpha})`; }
function encontrarUnidad(v, vId) { if(!v) return null; if(v.wialonId && v.wialonId !== "EXTERNO" && unidadesGlobales[v.wialonId]) return unidadesGlobales[v.wialonId]; let n = limpiarStr(v.unidadN || v.unidadFallback); let norm = n.replace(/[\s\-]/g, ""); for(let k in unidadesGlobales) { let uName = limpiarStr(unidadesGlobales[k].name); if(uName === n || uName.replace(/[\s\-]/g, "") === norm) return unidadesGlobales[k]; } if(unidadesGlobales[vId]) return unidadesGlobales[vId]; return null; }
function isInsidePolygon(point, vs) { let x = point[0], y = point[1], inside = false; for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) { let xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y; let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi); if (intersect) inside = !inside; } return inside; }
function getDistanceMeters(lat1, lon1, lat2, lon2) { const R = 6371000; const dLat = (lat2-lat1)*Math.PI/180; const dLon = (lon2-lon1)*Math.PI/180; const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2); return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); }
function resolverGeocerca(lat, lon) { if(!geocercasNativas || geocercasNativas.length === 0) return null; for(let z of geocercasNativas) { if(!z.p) continue; if(z.t === 3) { let r = z.p[0].r || 50; if(getDistanceMeters(lat, lon, z.p[0].y, z.p[0].x) <= r) return limpiarStr(z.n); } else { if(isInsidePolygon([lon, lat], z.p)) return limpiarStr(z.n); } } return null; }
function formatearFechaElegante(ms) { let n = getSafeNumber(ms); if (!n) return "--:--"; let d = new Date(n); if (isNaN(d.getTime())) return "--:--"; let meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]; return `${String(d.getDate()).padStart(2, '0')} ${meses[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function formatTimeFriendly(ms) { let n = getSafeNumber(ms); if (!n) return "--:--"; let d = new Date(n); if(isNaN(d.getTime())) return "--:--"; let today = new Date(); let timeStr = d.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}); if(d.toDateString() === today.toDateString()) return timeStr; return d.toLocaleDateString('es-MX', {day:'2-digit', month:'short'}) + " " + timeStr; }
function formatTimeDiff(mins) { let m = Math.abs(getSafeNumber(mins) || 0); let d = Math.floor(m / 1440); let h = Math.floor((m % 1440) / 60); let remM = m % 60; let str = []; if(d > 0) str.push(`${d}d`); if(h > 0) str.push(`${h}h`); if(remM > 0 || str.length === 0) str.push(`${remM}m`); return str.join(' '); }
function timeAgo(unixSecs) { if(!unixSecs) return "N/A"; let diff = Math.floor(Date.now()/1000) - unixSecs; if(diff < 60) return `${diff}s`; if(diff < 3600) return `${Math.floor(diff/60)}m`; if(diff < 86400) return `${Math.floor(diff/3600)}h`; let d = Math.floor(diff/86400); let h = Math.floor((diff%86400)/3600); return `${d}d ${h}h`; }

// --- CONTROL DE COLUMNAS ---
window.inicializarMenuColumnas = function() {
    let menuHtml = ''; colOrder.forEach((k, index) => {
        let checked = !hiddenCols[k] ? 'checked' : '';
        let btnUp = index > 0 ? `<i class="fa-solid fa-arrow-up mx-1 text-primary cp fs-6" onclick="moverColumna(${index}, -1)"></i>` : `<i class="fa-solid fa-arrow-up mx-1 text-muted fs-6" style="opacity:0.2"></i>`;
        let btnDown = index < colOrder.length - 1 ? `<i class="fa-solid fa-arrow-down mx-1 text-primary cp fs-6" onclick="moverColumna(${index}, 1)"></i>` : `<i class="fa-solid fa-arrow-down mx-1 text-muted fs-6" style="opacity:0.2"></i>`;
        let tituloLimpio = columnasDef[k].titulo.replace(/<[^>]*>?/gm, ''); 
        menuHtml += `<li class="dropdown-item d-flex justify-content-between align-items-center py-1 px-3 border-bottom"><label class="cp mb-0 flex-grow-1"><input type="checkbox" class="form-check-input me-2" onchange="toggleCol('${k}', this.checked)" ${checked}> <span style="font-size:0.7rem; font-weight:bold;">${tituloLimpio}</span></label><div class="d-flex bg-white rounded border px-2 py-1 shadow-sm">${btnUp}${btnDown}</div></li>`;
    });
    document.getElementById('column-toggles').innerHTML = menuHtml; Object.keys(hiddenCols).forEach(k => toggleCol(k, !hiddenCols[k], false));
};
window.moverColumna = function(idx, dir) { if(idx + dir < 0 || idx + dir >= colOrder.length) return; let temp = colOrder[idx]; colOrder[idx] = colOrder[idx + dir]; colOrder[idx + dir] = temp; localStorage.setItem('tms_colOrder', JSON.stringify(colOrder)); inicializarMenuColumnas(); solicitarRenderizado(); };
window.toggleCol = function(colClass, isVisible, save = true) { if(save) { hiddenCols[colClass] = !isVisible; localStorage.setItem('tms_hiddenCols', JSON.stringify(hiddenCols)); } document.querySelectorAll('.' + colClass).forEach(el => { if(isVisible) el.classList.remove('d-none'); else el.classList.add('d-none'); }); };
window.resetColumnas = function() { localStorage.removeItem('tms_colOrder'); localStorage.removeItem('tms_hiddenCols'); localStorage.removeItem('tms_colWidths'); location.reload(); };
window.aplicarAnchosGuardados = function() { let savedWidths = JSON.parse(localStorage.getItem('tms_colWidths')) || {}; let css = ''; Object.keys(columnasDef).forEach(c => { let w = savedWidths[c] || columnasDef[c].ancho; css += `.${c} { width: ${w}px !important; min-width: ${w}px !important; max-width: ${w}px !important; }\n`; }); let styleEl = document.getElementById('dynamic-col-styles'); if(!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'dynamic-col-styles'; document.head.appendChild(styleEl); } styleEl.innerHTML = css; };

let isResizing = false; let currentTh = null; let startX = 0; let startWidth = 0;
document.addEventListener('mousedown', function(e) { if (e.target.classList.contains('resizer')) { isResizing = true; currentTh = e.target.parentElement; startX = e.pageX; startWidth = currentTh.offsetWidth; e.target.classList.add('resizing'); document.body.style.userSelect = 'none'; } });
document.addEventListener('mousemove', function(e) { if (isResizing && currentTh) { let newWidth = Math.max(50, startWidth + (e.pageX - startX)); let colClass = Array.from(currentTh.classList).find(c => c.startsWith('col-')); if(colClass) { let liveStyle = document.getElementById('live-resize-style'); if(!liveStyle) { liveStyle = document.createElement('style'); liveStyle.id = 'live-resize-style'; document.head.appendChild(liveStyle); } liveStyle.innerHTML = `.${colClass} { width: ${newWidth}px !important; min-width: ${newWidth}px !important; max-width: ${newWidth}px !important; }`; } } });
document.addEventListener('mouseup', function(e) { if (isResizing) { isResizing = false; let colClass = Array.from(currentTh.classList).find(c => c.startsWith('col-')); if (colClass) { let savedWidths = JSON.parse(localStorage.getItem('tms_colWidths')) || {}; savedWidths[colClass] = currentTh.offsetWidth; localStorage.setItem('tms_colWidths', JSON.stringify(savedWidths)); aplicarAnchosGuardados(); let liveStyle = document.getElementById('live-resize-style'); if(liveStyle) liveStyle.innerHTML = ''; } document.querySelectorAll('.resizer').forEach(r => r.classList.remove('resizing')); currentTh = null; document.body.style.userSelect = ''; } });

function getHeadersRow(cId) {
    let html = `<tr class="header-columnas shadow-sm client-group-${cId}">`; colOrder.forEach((c) => {
        let titulo = columnasDef[c].titulo; let display = hiddenCols[c] ? 'd-none' : ''; let tituloModificado = titulo;
        if(c === 'col-unidad' && sortState.column === 'unidad') tituloModificado = titulo.replace('sort-icon', 'sort-icon active');
        if(c === 'col-ruta' && sortState.column === 'ruta') tituloModificado = titulo.replace('sort-icon', 'sort-icon active');
        if(c === 'col-estatus' && sortState.column === 'estatus') tituloModificado = titulo.replace('sort-icon', 'sort-icon active');
        html += `<th class="${c} ${display} position-relative"><div class="d-flex justify-content-center align-items-center h-100 px-1"><span class="text-center">${tituloModificado}</span></div><div class="resizer" title="Arrastrar para cambiar tamaño"></div></th>`;
    }); return html + `</tr>`;
}

// --- MAPA FLUIDO ---
window.initMap = function() { lmap = L.map('map').setView([23.6, -102.5], 5); L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(lmap); mapLayerGroup = L.layerGroup().addTo(lmap); geofenceLayerGroup = L.layerGroup().addTo(lmap); };
window.toggleMap = function() { document.getElementById("mainWorkspace").classList.toggle("show-map"); if(!lmap) initMap(); mapVisible = !mapVisible; setTimeout(() => { if(lmap) { lmap.invalidateSize(); actualizarMarcadoresMapa(); pintarGeocercasEnMapa(); } }, 400); };
window.clickMapaUnidad = function(vId) { let v = viajesActivos[vId]; if(!v) return alert("Unidad no encontrada."); let uData = encontrarUnidad(v, vId); if(uData && uData.pos && uData.pos.y) { centrarUnidadMapa(uData.pos.y, uData.pos.x, vId); } else { alert("Unidad sin coordenadas GPS válidas en este momento."); } };
window.centrarUnidadMapa = function(lat, lon, vId) { if(!mapVisible) toggleMap(); setTimeout(() => { if(lmap) { lmap.flyTo([lat, lon], 16, { animate: true, duration: 1.5 }); if(vId && mapaMarcadores[vId]) { setTimeout(() => { mapaMarcadores[vId].openPopup(); }, 1500); } } }, 400); };
window.actualizarMarcadoresMapa = function() {
    if(!lmap || !mapLayerGroup) return; mapLayerGroup.clearLayers(); mapaMarcadores = {}; 
    Object.keys(viajesActivos).forEach(vId => {
        let v = viajesActivos[vId]; if(typeof v !== 'object' || !v) return; let uData = encontrarUnidad(v, vId);
        if(uData && uData.pos) {
            let isMoving = uData.pos.s > 0; let colorIcon = isMoving ? '#10b981' : '#0284c7'; let rotation = (uData.pos.c || 0) - 45;
            let markerHtml = isMoving ? `<div style="transform: rotate(${rotation}deg); color: ${colorIcon}; font-size: 22px; text-shadow: 0 2px 4px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;"><i class="fa-solid fa-location-arrow"></i></div>` : `<div style="color: ${colorIcon}; font-size: 24px; text-shadow: 0 2px 4px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;"><i class="fa-solid fa-location-dot"></i></div>`;
            let customIcon = L.divIcon({ html: markerHtml, className: '', iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -14] });
            let vel = uData.pos.s; let est = window.estatusData[v.estatus]?.nombre || "En Trayecto"; let operador = escapeSafe(v.operador || (uData.choferObj && uData.choferObj.nombre !== "Sin asignar" ? uData.choferObj.nombre : "Sin Operador"));
            let hoverText = isMoving ? `En movimiento a ${vel} km/h (hace ${timeAgo(uData.pos.t)})` : `Unidad detenida (hace ${timeAgo(uData.pos.t)})`;
            let popupContent = `<div style="text-align:center; min-width: 160px; font-family: 'Inter', sans-serif;"><b style="font-size:15px; color:#0f172a; text-transform:uppercase;">${escapeSafe(uData.name)}</b><br><span style="font-size:11px; color:#64748b; font-weight:bold;">${operador}</span><br><div style="margin-top:5px; margin-bottom:5px; background:${isMoving?'#10b981':'#64748b'}; color:white; border-radius:4px; padding:2px; font-weight:bold; font-size:12px;">${vel} km/h</div><b style="font-size:11px; color:#0284c7;">${est}</b><br><span style="color:#94a3b8; font-size:10px;">Act: hace ${timeAgo(uData.pos.t)}</span></div>`;
            let marker = L.marker([uData.pos.y, uData.pos.x], {icon: customIcon}).bindTooltip(hoverText, {direction: 'top', className: 'fw-bold'}).bindPopup(popupContent, {className: 'custom-popup'}).addTo(mapLayerGroup);
            mapaMarcadores[vId] = marker;
        }
    });
};
window.pintarGeocercasEnMapa = function() {
    if(!lmap || !geofenceLayerGroup) return; geofenceLayerGroup.clearLayers(); let geocercasActivas = {};
    Object.values(viajesActivos).forEach(v => {
        if(typeof v !== 'object' || !v) return; if(v.origen) geocercasActivas[limpiarStr(v.origen)] = "origen";
        let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []); arrDests.forEach(d => geocercasActivas[d] = "destino");
    });
    geocercasNativas.forEach(z => {
        let uName = limpiarStr(z.n);
        if(geocercasActivas[uName]) {
            let isOrigen = geocercasActivas[uName] === "origen"; let colorHex = isOrigen ? '#15803d' : '#b91c1c'; let txtLabel = isOrigen ? `📍 ORIGEN: ${z.n}` : `🏁 DESTINO: ${z.n}`; let cssClass = isOrigen ? 'geocerca-tooltip origen' : 'geocerca-tooltip destino';
            let shape;
            if(z.t === 3 && z.p && z.p[0]) { shape = L.circle([z.p[0].y, z.p[0].x], {radius: z.p[0].r, color: colorHex, weight: 3, fillOpacity: 0.2}); } 
            else if((z.t === 1 || z.t === 2) && z.p) { shape = L.polygon(z.p.map(pt => [pt.y, pt.x]), {color: colorHex, weight: 3, fillOpacity: 0.2}); }
            if(shape) { shape.bindTooltip(txtLabel, { permanent: true, direction: 'top', className: cssClass }).addTo(geofenceLayerGroup); }
        }
    });
};

// --- HUBS DE NOTIFICACIONES ---
db.ref('notificaciones_pendientes').on('value', snap => {
    let data = snap.val() || {}; alertasSeguridad = {}; alertasLogistica = {};
    Object.keys(data).forEach(k => { let notif = data[k]; notif.id = k; if (['SALIDA', 'ARRIBO', 'FINALIZACION'].includes(notif.tipo)) alertasLogistica[k] = notif; else alertasSeguridad[k] = notif; }); window.actualizarBotonesHubs();
});

window.enviarNotificacionPersistente = function(vId, unidadName, tipo, detalle) {
    let idLogico = vId + "_" + tipo; db.ref('notificaciones_pendientes/' + idLogico).once('value', snap => { if(!snap.exists()) { db.ref('notificaciones_pendientes/' + idLogico).set({ vId: vId, unidad: unidadName, tipo: tipo, detalle: detalle, t_evento: Date.now() }); } });
};

window.actualizarBotonesHubs = function() {
    let cSeg = Object.keys(alertasSeguridad).length; let cLog = Object.keys(alertasLogistica).length;
    let bSeg = document.getElementById("btnHubSeguridad"); let lSeg = document.getElementById("lblCountSeguridad");
    if(bSeg && lSeg) { if(cSeg>0) { lSeg.innerText=cSeg; bSeg.classList.remove("d-none"); } else { bSeg.classList.add("d-none"); try{ bootstrap.Modal.getInstance(document.getElementById('modalHubSeguridad')).hide(); }catch(e){} } }
    let bLog = document.getElementById("btnHubLogistico"); let lLog = document.getElementById("lblCountLogistico");
    if(bLog && lLog) { if(cLog>0) { lLog.innerText=cLog; bLog.classList.remove("d-none"); } else { bLog.classList.add("d-none"); try{ bootstrap.Modal.getInstance(document.getElementById('modalHubLogistico')).hide(); }catch(e){} } }
};

window.abrirHubSeguridad = function() {
    let container = document.getElementById("listaHubSeguridad"); container.innerHTML = "";
    let count = Object.keys(alertasSeguridad).length;
    if (count === 0) { try { bootstrap.Modal.getInstance(document.getElementById('modalHubSeguridad')).hide(); } catch(e){} return; }
    
    Object.values(alertasSeguridad).forEach(n => {
        let icon = n.tipo === "PARADA" ? "fa-stop text-danger" : (n.tipo === "REANUDACION" ? "fa-play text-success" : "fa-triangle-exclamation text-warning");
        container.innerHTML += `<div class="bg-white p-3 rounded shadow-sm border border-danger mb-3"><div class="d-flex justify-content-between align-items-start mb-2"><div><div class="fw-bold text-dark" style="font-size:0.95rem;"><i class="fa-solid ${icon} me-1"></i> ${escapeSafe(n.unidad)}</div><div class="text-muted" style="font-size:0.8rem;">${n.detalle} (Sensor: ${formatTimeFriendly(n.t_evento)})</div></div></div><textarea id="nota_hub_${n.id}" class="form-control border-secondary mb-2" rows="2" placeholder="Justificación o anotación..."></textarea><div class="d-flex gap-2 justify-content-end"><button class="btn btn-sm btn-outline-danger fw-bold px-3" onclick="rechazarNotificacion('${n.id}', true)"><i class="fa-solid fa-xmark"></i> Falsa Alarma</button><button class="btn btn-sm btn-success fw-bold px-3" onclick="confirmarNotificacion('${n.id}', true)"><i class="fa-solid fa-check"></i> Confirmar y Guardar</button></div></div>`;
    }); new bootstrap.Modal(document.getElementById('modalHubSeguridad')).show();
};

window.abrirHubLogistico = function() {
    let container = document.getElementById("listaHubLogistico"); container.innerHTML = "";
    let count = Object.keys(alertasLogistica).length;
    if (count === 0) { try { bootstrap.Modal.getInstance(document.getElementById('modalHubLogistico')).hide(); } catch(e){} return; }
    
    Object.values(alertasLogistica).forEach(n => {
        let icon = n.tipo === "SALIDA" ? "fa-rocket text-primary" : (n.tipo === "ARRIBO" ? "fa-map-pin text-success" : "fa-flag-checkered text-dark"); let borderClass = n.tipo === "SALIDA" ? "border-primary" : (n.tipo === "ARRIBO" ? "border-success" : "border-dark");
        container.innerHTML += `<div class="bg-white p-3 rounded shadow-sm border ${borderClass} mb-3"><div class="d-flex justify-content-between align-items-start mb-2"><div><div class="fw-bold text-dark" style="font-size:0.95rem;"><i class="fa-solid ${icon} me-1"></i> ${escapeSafe(n.unidad)}</div><div class="text-muted" style="font-size:0.8rem;">${n.detalle} (Sensor: ${formatTimeFriendly(n.t_evento)})</div></div></div><textarea id="nota_hub_${n.id}" class="form-control border-secondary mb-2" rows="1" placeholder="Nota adicional (opcional)..."></textarea><div class="d-flex gap-2 justify-content-end"><button class="btn btn-sm btn-outline-danger fw-bold px-3" onclick="rechazarNotificacion('${n.id}', false)"><i class="fa-solid fa-xmark"></i> Falsa Alarma</button><button class="btn btn-sm btn-success fw-bold px-3" onclick="confirmarNotificacion('${n.id}', false)"><i class="fa-solid fa-check"></i> Confirmar Evento</button></div></div>`;
    }); new bootstrap.Modal(document.getElementById('modalHubLogistico')).show();
};

window.confirmarNotificacion = function(id, isSeguridad) {
    UI_PAUSED = false; 
    let n = isSeguridad ? alertasSeguridad[id] : alertasLogistica[id]; if(!n) return;
    let inputEl = document.getElementById('nota_hub_' + id); let nota = inputEl ? inputEl.value.trim() : "";
    if(isSeguridad && n.tipo === "PARADA" && !nota) { return alert("⚠️ Debes escribir una justificación obligatoria para la parada antes de confirmar."); }
    let vId = n.vId; let timeReaccion = Date.now(); let timeReal = n.t_evento; let detalleLog = `Hora Real de Sensor: ${formatTimeFriendly(timeReal)}`; if (nota) detalleLog += ` | Nota: ${nota}`;
    if (n.tipo === "SALIDA") { db.ref('viajes_activos/'+vId).update({ t_salida: timeReal, t_confirmacion_salida: timeReaccion }); registrarLog(vId, 'Confirmó SALIDA', detalleLog); } 
    else if (n.tipo === "ARRIBO") { db.ref('viajes_activos/'+vId).update({ t_arribo: timeReal, t_confirmacion_arribo: timeReaccion, estatus: 's8' }); registrarLog(vId, 'Confirmó ARRIBO', detalleLog); } 
    else if (n.tipo === "FINALIZACION") { db.ref('viajes_activos/'+vId).update({ t_fin: timeReal, t_confirmacion_fin: timeReaccion, estatus: 's12' }); registrarLog(vId, 'Confirmó FINALIZADO', detalleLog); } 
    else if (n.tipo === "PARADA") { db.ref('viajes_activos/'+vId).update({ estatus: 's2', alerta_detenida: true }); registrarLog(vId, 'Justificó PARADA', detalleLog); } 
    else if (n.tipo === "REANUDACION") { db.ref('viajes_activos/'+vId).update({ estatus: 's1', alerta_detenida: null }); registrarLog(vId, 'Confirmó REANUDACIÓN', detalleLog); } 
    else if (n.tipo === "DESCONEXION") { registrarLog(vId, 'Confirmó DESCONEXIÓN', detalleLog); }
    db.ref('notificaciones_pendientes/' + id).remove(); mostrarNotificacion("✅ Evento procesado con éxito."); 
    if(isSeguridad) { setTimeout(window.abrirHubSeguridad, 100); } else { setTimeout(window.abrirHubLogistico, 100); }
};

window.rechazarNotificacion = function(id, isSeguridad) {
    UI_PAUSED = false;
    let n = isSeguridad ? alertasSeguridad[id] : alertasLogistica[id]; if(!n) return;
    let inputEl = document.getElementById('nota_hub_' + id); let nota = inputEl ? inputEl.value.trim() : ""; let detalleLog = `Descartado por el Monitorista como Falsa Alarma`; if(nota) detalleLog += ` | Nota: ${nota}`;
    registrarLog(n.vId, `Rechazó alerta de ${n.tipo}`, detalleLog); db.ref('notificaciones_pendientes/' + id).remove(); mostrarNotificacion("🚫 Evento descartado."); 
    if(isSeguridad) { setTimeout(window.abrirHubSeguridad, 100); } else { setTimeout(window.abrirHubLogistico, 100); }
};

// --- ACCIONES Y WHATSAPP ---
window.cambiarEstatus = function(val, vId) { 
    let v = viajesActivos[vId]; if (val === 's8' && (!v || !v.t_arribo)) { if (confirm("Esta unidad no tiene registrado su horario de ARRIBO.\n\n¿Deseas marcar el arribo en este momento (Hora actual)?")) { db.ref(`viajes_activos/${vId}/t_arribo`).set(Date.now()); registrarLog(vId, 'Marcó ARRIBO', 'Automático'); } }
    let txt = window.estatusData[val].nombre; registrarLog(vId, 'Cambió estatus a', txt); db.ref('viajes_activos/'+vId+'/estatus').set(val); 
};
window.editarUbicacionManual = function(vId) { 
    let v = viajesActivos[vId]; if(!v) return; let uName = limpiarStr(v.unidadN || v.unidadFallback); let u = prompt(`Escribir ubicación o coordenadas (ej. 20.123, -100.456) para ${uName}:`, v.ubicacion_manual_raw || v.ubicacion_manual || ''); 
    if(u !== null && u.trim() !== '') { 
        let rawText = limpiarStr(u); let locText = rawText; let isCoords = /^[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?)[,\s]+[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/.test(rawText);
        if (isCoords) { let coords = rawText.replace(/\s/g, ''); locText = `<a href="https://www.google.com/maps?q=lat,lng{coords}" target="_blank" class="text-primary text-decoration-underline" title="Abrir en Maps"><i class="fa-solid fa-map-location-dot me-1"></i>${coords}</a>`; }
        db.ref(`viajes_activos/${vId}`).update({ ubicacion_manual: locText, ubicacion_manual_raw: rawText, t_ubicacion_manual: Date.now() }); registrarLog(vId, 'Actualizó Ubicación', rawText); 
    } 
};
window.registrarLog = function(viajeId, accion, detalle = "") { let usrName = currentUser ? currentUser.nom : "Sistema"; db.ref(`viajes_activos/${viajeId}/log`).push({ t: Date.now(), usr: usrName, act: accion, det: detalle }); };
window.cerrarSesion = function() { localStorage.clear(); location.reload(); };
window.finalizarViaje = function(vId, nombre) { if(confirm(`¿Estás seguro de archivar el viaje de la unidad ${nombre}?`)) { db.ref('viajes_activos/' + vId).once('value').then(snap => { let data = snap.val(); if(data) { data.fecha_archivado = Date.now(); db.ref('viajes_archivados/' + vId).set(data).then(() => { db.ref('viajes_activos/' + vId).remove(); mostrarNotificacion(`Viaje de ${nombre} archivado exitosamente.`); }); } }).catch(err => alert("Error al archivar: " + err.message)); } };

document.getElementById('modalArchivarMasivo')?.addEventListener('show.bs.modal', () => { let sel = document.getElementById("selClienteArchivar"); sel.innerHTML = '<option value="TODOS">🚨 TODOS LOS CLIENTES 🚨</option>'; Object.keys(dataClientes).forEach(k => { sel.innerHTML += `<option value="${k}">${dataClientes[k].nombre}</option>`; }); });
window.ejecutarArchivadoMasivo = function() { let cId = document.getElementById("selClienteArchivar").value; if(!cId) return alert("Selecciona un cliente válido."); let nombreCli = cId === "TODOS" ? "TODOS LOS CLIENTES" : dataClientes[cId]?.nombre; if(!confirm(`¿Estás seguro de archivar TODOS los viajes con estatus "8. Finalizado" de ${nombreCli}?`)) return; let cont = 0; let promesas = []; Object.keys(viajesActivos).forEach(vId => { let v = viajesActivos[vId]; if((cId === "TODOS" || v.cliente === cId) && v.estatus === "s12") { v.fecha_archivado = Date.now(); let p = db.ref('viajes_archivados/' + vId).set(v).then(() => db.ref('viajes_activos/' + vId).remove()); promesas.push(p); cont++; } }); if(cont === 0) return alert(`No se encontraron viajes con estatus "8. Finalizado" para ${nombreCli}.`); Promise.all(promesas).then(() => { mostrarNotificacion(`🧹 Limpieza completa: ${cont} viajes archivados.`); try{ bootstrap.Modal.getInstance(document.getElementById('modalArchivarMasivo')).hide(); }catch(e){} }); };
window.abrirModalLog = function(uId, uName) { document.getElementById("log_uid").value = uId; document.getElementById("log_uName").innerText = uName; document.getElementById("log_txt").value = ""; let logsObj = viajesActivos[uId]?.log || {}; let logsArr = Object.values(logsObj).sort((a,b)=>b.t - a.t); let html = logsArr.map(l => `<div class="mb-2 border-bottom pb-1"><div style="font-size:0.65rem; color:#6c757d; font-weight:bold; margin-bottom:1px;"><i class="fa-regular fa-calendar text-primary"></i> ${formatearFechaElegante(l.t)}</div><b class="text-dark">${escapeSafe(l.usr)}:</b> <span class="text-primary">${escapeSafe(l.act)}</span> <span class="text-muted">${escapeSafe(l.det||'')}</span></div>`).join(''); document.getElementById("log_container").innerHTML = html || '<div class="text-muted text-center p-2 mt-3">Sin eventos.</div>'; new bootstrap.Modal(document.getElementById('modalLog')).show(); };
window.guardarLogManual = function() { let uId = document.getElementById("log_uid").value; let txt = limpiarStr(document.getElementById("log_txt").value); if(!txt) return; registrarLog(uId, "Agregó Nota", txt); try { bootstrap.Modal.getInstance(document.getElementById('modalLog')).hide(); } catch(e){} mostrarNotificacion("Nota guardada en el historial."); };

window.enviarWA = function(vId) {
    let v = viajesActivos[vId]; if(!v) return; let uData = encontrarUnidad(v, vId); let nombreCamion = limpiarStr(v.unidadN || v.unidadFallback); let estNombre = window.estatusData[v.estatus]?.nombre || "En Trayecto"; let pos = uData ? uData.pos : null; let speed = pos ? pos.s : 0; let cliId = v.cliente || "Sin_Cliente"; let subId = v.subcliente || "N/A"; let cliName = (dataClientes[cliId] && dataClientes[cliId].nombre) ? dataClientes[cliId].nombre : "SIN CLIENTE"; let subName = (dataClientes[cliId] && dataClientes[cliId].subclientes && dataClientes[cliId].subclientes[subId]) ? dataClientes[cliId].subclientes[subId].nombre : ""; let subText = subName && subName !== "N/A" ? ` -> ${subName}` : ''; let addrText = v.ubicacion_manual_raw || "Buscando..."; let locLink = addrText; let geoTextWA = "";
    if (pos) { let zonaGeo = (uData && uData.zonaOficial) ? uData.zonaOficial : resolverGeocerca(pos.y, pos.x); if(zonaGeo) geoTextWA = `\n📍 *Geocerca:* ${zonaGeo}`; let domAddr = document.getElementById("addr_" + vId); if(domAddr && domAddr.innerText !== "Buscando...") { addrText = domAddr.innerText.trim(); } else { addrText = "Ubicación GPS"; } locLink = `${addrText} \nhttps://www.google.com/maps?q=lat,lng${pos.y},${pos.x}`; }
    let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []); let cIdx = v.destino_idx || 0; let cOrigen = v.origen_actual || v.origen || "N/A"; let cDestino = arrDests[cIdx] || v.destino || "N/A"; let contStr = Array.isArray(v.contenedores_arr) ? v.contenedores_arr.join(' / ') : (v.contenedores || 'N/A');
    let text = `*GRUDICOM TI & GPS - REPORTE DE UNIDAD*\n\n🏢 *Cliente:* ${cliName}${subText}\n\n🚛 *Unidad:* ${nombreCamion}\n📦 *Contenedores:* ${contStr}\n🛣️ *Ruta Actual:* ${cOrigen} ➔ ${cDestino}\n🚦 *Estatus:* ${estNombre}\n⏱️ *Vel:* ${speed} km/h${geoTextWA}\n📍 *Ubicación:* ${locLink}\n\n_Reporte C4_`; window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank'); 
};
window.generarReporteGrupal = function(cId, sId, titulo) {
    if(!datosAgrupadosGlobal[cId] || !datosAgrupadosGlobal[cId][sId]) return; let arrViajes = datosAgrupadosGlobal[cId][sId]; let txt = `*GRUDICOM TI & GPS - REPORTE DE FLOTA*\n🏢 *${titulo}*\n\n`;
    arrViajes.forEach(({v, vId}) => {
        let uData = encontrarUnidad(v, vId); let name = limpiarStr(v.unidadN || v.unidadFallback); let est = window.estatusData[v.estatus]?.nombre || "En Trayecto"; let pos = uData ? uData.pos : null; let vel = pos ? pos.s : 0; let locLink = v.ubicacion_manual_raw || "Manual"; let geoTextWA = "";
        if (pos) { let zonaGeo = (uData && uData.zonaOficial) ? uData.zonaOficial : resolverGeocerca(pos.y, pos.x); if(zonaGeo) geoTextWA = `\n📍 *Geocerca:* ${zonaGeo}`; locLink = `https://www.google.com/maps?q=lat,lng${pos.y},${pos.x}`; }
        let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []); let cIdx = v.destino_idx || 0; let cOrigen = v.origen_actual || v.origen || "N/A"; let cDestino = arrDests[cIdx] || v.destino || "N/A"; let contStr = Array.isArray(v.contenedores_arr) ? v.contenedores_arr.join(' / ') : (v.contenedores || 'N/A');
        txt += `🚛 *Unidad:* ${name}\n📦 *Contenedores:* ${contStr}\n⏱️ *Vel:* ${vel} km/h\n🚦 *Estatus:* ${est}\n🏁 *Ruta:* ${cOrigen} ➔ ${cDestino}${geoTextWA}\n📍 *Ubicación:* ${locLink}\n\n`;
    }); txt += `_Reporte C4_`; window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(txt)}`, '_blank');
};

// --- CAPTURA INTELIGENTE ---
window.generarCapturaCliente = async function(cId, cliName) {
    let tableWrap = document.getElementById('scrollContainer'); let allRows = document.querySelectorAll('#units-body tr'); let hiddenRows = [];
    allRows.forEach(r => { if(!r.classList.contains(`client-group-${cId}`)) { hiddenRows.push({el: r, display: r.style.display}); r.style.display = 'none'; } });
    let colsToHide = document.querySelectorAll('.col-operador, .col-alertas, .col-accion, .col-historial'); let originalDisplaysCols = []; colsToHide.forEach(el => { originalDisplaysCols.push({el: el, disp: el.style.display}); el.style.display = 'none'; });
    let extraHides = document.querySelectorAll('.dropdown-toggle, .btn-dots, .fw-bold.text-muted.user-select-all.mt-1'); let originalDisplaysExtras = []; extraHides.forEach(el => { originalDisplaysExtras.push({el: el, disp: el.style.display}); el.style.display = 'none'; });
    let oldHeight = tableWrap.style.height; let oldMaxHeight = tableWrap.style.maxHeight; let oldOverflow = tableWrap.style.overflow; tableWrap.style.height = 'auto'; tableWrap.style.maxHeight = 'none'; tableWrap.style.overflow = 'visible'; let oldW = document.getElementById("mainTable").style.width; document.getElementById("mainTable").style.width = "max-content";
    await new Promise(r => setTimeout(r, 400));
    try { let canvas = await html2canvas(document.getElementById('mainTable'), { scale: 2, backgroundColor: '#f1f5f9', useCORS: true }); canvas.toBlob(function(blob) { currentCaptureBlob = blob; document.getElementById('imgPreviewCaptura').src = URL.createObjectURL(blob); new bootstrap.Modal(document.getElementById('modalPreviewCaptura')).show(); }, 'image/png'); } 
    catch(e) { console.error(e); alert("Error al generar captura de pantalla."); } 
    finally { tableWrap.style.height = oldHeight; tableWrap.style.maxHeight = oldMaxHeight; tableWrap.style.overflow = oldOverflow; document.getElementById("mainTable").style.width = oldW; hiddenRows.forEach(item => item.el.style.display = item.display); colsToHide.forEach((el, i) => el.style.display = originalDisplaysCols[i].disp); extraHides.forEach((el, i) => el.style.display = originalDisplaysExtras[i].disp); }
};
window.descargarCaptura = function() { if(!currentCaptureBlob) return; let link = document.createElement('a'); link.download = `Estatus_Bitacora.png`; link.href = URL.createObjectURL(currentCaptureBlob); link.click(); };
window.copiarCaptura = async function() { if(!currentCaptureBlob) return; try { const item = new ClipboardItem({ "image/png": currentCaptureBlob }); await navigator.clipboard.write([item]); alert("¡Imagen copiada! Ya puedes pegarla en WhatsApp."); } catch (err) { alert("Tu navegador no permite copiar directo. Usa el botón Descargar."); } };
window.renderChips = function(containerId, arrayData) { let container = document.getElementById(containerId); container.querySelectorAll('.chip').forEach(e => e.remove()); let inputEl = container.querySelector('input'); arrayData.forEach((text, index) => { let chip = document.createElement('div'); chip.className = 'chip'; chip.innerHTML = `${text} <span class="chip-close" onclick="borrarChip(event, '${containerId}', ${index})"><i class="fa-solid fa-xmark"></i></span>`; container.insertBefore(chip, inputEl); }); };
window.manejarChipInput = function(e, containerId, arrayData) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); let val = limpiarStr(e.target.value.replace(/,/g, '')); if (val) { arrayData.push(val); renderChips(containerId, arrayData); } e.target.value = ''; } else if (e.key === 'Backspace' && e.target.value === '' && arrayData.length > 0) { arrayData.pop(); renderChips(containerId, arrayData); } };
window.borrarChip = function(e, containerId, index) { e.stopPropagation(); if(containerId === 'ed_chips_box') { edChipsArray.splice(index, 1); renderChips(containerId, edChipsArray); } else if(containerId === 'ed_chips_cont_box') { edChipsContArray.splice(index, 1); renderChips(containerId, edChipsContArray); } else { let filaCont = document.getElementById(containerId); if(filaCont && filaCont.chipData) { filaCont.chipData.splice(index, 1); renderChips(containerId, filaCont.chipData); } } };
window.expandirRuta = function(vId) { let tramo = document.getElementById('exp_ruta_' + vId); if(tramo) { tramo.classList.toggle('expanded'); tramo.classList.toggle('d-none'); } };

// --- CALENDARIO FLATPICKR ---
let fpInstance = null;
window.abrirModalEdicionHora = function(vId, field, titulo, actualTs) {
    document.getElementById('eh_vId').value = vId; document.getElementById('eh_field').value = field; document.getElementById('eh_txtVacio').value = titulo; document.getElementById('eh_title').innerText = titulo;
    let defaultD = (actualTs && actualTs !== 'null') ? new Date(Number(actualTs)) : new Date(); if(fpInstance) fpInstance.destroy(); let modalEl = document.getElementById('modalEditHora');
    fpInstance = flatpickr("#eh_input", { enableTime: true, dateFormat: "Y-m-d H:i", defaultDate: defaultD, locale: "es", time_24hr: true, minuteIncrement: 1, allowInput: true, appendTo: modalEl });
    new bootstrap.Modal(modalEl).show();
};
window.guardarHorarioModal = function() { let vId = document.getElementById('eh_vId').value; let field = document.getElementById('eh_field').value; let titulo = document.getElementById('eh_txtVacio').value; if(!fpInstance || !fpInstance.selectedDates[0]) return mostrarNotificacion("Selecciona una fecha válida."); let d = fpInstance.selectedDates[0].getTime(); if(d) { db.ref('viajes_activos/'+vId+'/'+field).set(d); registrarLog(vId, 'Modificó horario de', titulo); mostrarNotificacion("Horario actualizado."); try { bootstrap.Modal.getInstance(document.getElementById('modalEditHora')).hide(); } catch(e){} } };
window.borrarHorarioModal = function() { let vId = document.getElementById('eh_vId').value; let field = document.getElementById('eh_field').value; let titulo = document.getElementById('eh_txtVacio').value; if(confirm(`¿Estás seguro de BORRAR el horario de ${titulo}?`)) { db.ref('viajes_activos/'+vId+'/'+field).set(null); registrarLog(vId, 'Eliminó horario', titulo); mostrarNotificacion(`Horario de ${titulo} borrado.`); try { bootstrap.Modal.getInstance(document.getElementById('modalEditHora')).hide(); } catch(e){} } };

function construirBotonHorario(vId, timestampStr, dbField, textoVacio, claseColor) {
    let ts = getSafeNumber(timestampStr);
    if(!ts) { let onClk = `db.ref('viajes_activos/${vId}/${dbField}').set(Date.now()); registrarLog('${vId}', 'Marcó horario de', '${textoVacio}');`; if (dbField === 't_salida') { onClk = `db.ref('viajes_activos/${vId}').update({t_salida: Date.now(), t_salida_origen: (viajesActivos['${vId}'].destino_idx === 0 ? Date.now() : viajesActivos['${vId}'].t_salida_origen)}); registrarLog('${vId}', 'Marcó SALIDA');`; } return `<div class="time-wrapper color-${claseColor}"><button class="time-btn-dashed" onclick="${onClk}">${textoVacio}</button></div>`; } 
    else { let displayDate = formatearFechaElegante(ts); let onClk = `abrirModalEdicionHora('${vId}', '${dbField}', '${textoVacio}', '${ts}')`; return `<div class="time-wrapper color-${claseColor}" title="Clic para modificar"><div class="time-capsule cp" onclick="${onClk}"><div class="time-capsule-icon">${textoVacio.charAt(0)}</div><div class="time-capsule-input">${displayDate}</div></div></div>`; }
}
window.avanzarMultiDestino = function(vId) { let v = viajesActivos[vId]; if (!v) return; let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []); let totalDests = arrDests.length || 1; let currentIdx = v.destino_idx || 0; let now = Date.now(); db.ref(`viajes_activos/${vId}/t_fin`).set(now); setTimeout(() => { if (currentIdx < totalDests - 1) { let updates = {}; registrarLog(vId, `Terminó Destino ${currentIdx + 1}`, arrDests[currentIdx]); let tramoRef = `historial_tramos/${currentIdx}`; updates[tramoRef] = { destino: arrDests[currentIdx], t_salida: v.t_salida || null, t_arribo: v.t_arribo || null, t_fin: now }; updates['destino_idx'] = currentIdx + 1; updates['origen_actual'] = arrDests[currentIdx]; updates['t_salida'] = now; updates['t_arribo'] = null; updates['t_fin'] = null; updates['is_transit'] = true; db.ref(`viajes_activos/${vId}`).update(updates); } }, 300); };
