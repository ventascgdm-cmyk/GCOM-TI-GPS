// ============================================================================
// GRUDICOM TI & GPS - C4 MASTER (v8.0 Estabilizada y Seccionada)
// PARTE 1: CONFIGURACIÓN, UTILIDADES Y CONTROL DE INTERFAZ
// ============================================================================

const firebaseConfig = { databaseURL: "https://monitoreo-logistica-default-rtdb.firebaseio.com/" };
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

function mostrarNotificacion(msg) {
    document.getElementById('sysToastBody').innerText = msg;
    new bootstrap.Toast(document.getElementById('sysToast')).show();
}

// --- CONTROL DE PARPADEOS EN UI ---
let UI_PAUSED = false;
document.addEventListener('show.bs.dropdown', (e) => { 
    UI_PAUSED = true; document.body.classList.add('dropdown-open');
    let tr = e.target.closest('tr'); if(tr) tr.classList.add('dropdown-active');
});
document.addEventListener('hide.bs.dropdown', (e) => { 
    UI_PAUSED = false; document.body.classList.remove('dropdown-open');
    let tr = e.target.closest('tr'); if(tr) tr.classList.remove('dropdown-active');
    setTimeout(solicitarRenderizado, 150); 
});
document.addEventListener('focusin', (e) => { 
    if(['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        if(e.target.closest('#mainTable')) UI_PAUSED = true; 
    }
});
document.addEventListener('focusout', (e) => { 
    UI_PAUSED = false; setTimeout(solicitarRenderizado, 150); 
});

let currentUser = null, configSistema = { tokens: [] }, dataClientes = {}, viajesActivos = {};
let unidadesGlobales = {}, ramDrivers = {}, dbOperadores = {}, geocercasNativas = [], activeSIDs = {}, pollingInterval = null;
let lmap = null, mapVisible = false, mapLayerGroup = null, geofenceLayerGroup = null;
let estadoTokens = {}, datosAgrupadosGlobal = {}; 
let mapaMarcadores = {}; 
let alertasSeguridad = {}; let alertasLogistica = {};

let geocodeCache = JSON.parse(localStorage.getItem('tms_geoCache')) || {}; 
let geoQueue = []; let isGeocoding = false; let motorArrancado = false; let isSyncingFlotas = false;
let currentCaptureBlob = null; 

// --- SISTEMA ANTI-PARPADEO (AMORTIGUADOR) ---
let renderTimer = null;
function solicitarRenderizado() {
    if(renderTimer) return; 
    renderTimer = setTimeout(() => { 
        renderTimer = null; 
        renderizarBitacora(); 
        if(mapVisible) actualizarMarcadoresMapa(); 
    }, 200); 
}

// --- PRIORIDADES ESTRICTAS DE COLUMNAS ---
const columnasDef = {
    'col-unidad': { titulo: 'UNIDAD', ancho: '110' },
    'col-operador': { titulo: 'OPERADOR GPS', ancho: '150' },
    'col-ruta': { titulo: 'RUTA (O ➔ D)', ancho: '180' },
    'col-contenedores': { titulo: 'CONTENEDORES', ancho: '110' },
    'col-horarios': { titulo: 'HORARIOS', ancho: '95' }, 
    'col-estatus': { titulo: 'ESTATUS', ancho: '120' },
    'col-gps': { titulo: 'UBICACIÓN Y GEOCERCA', ancho: '420' }, 
    'col-alertas': { titulo: 'ALERTAS', ancho: '90' },
    'col-historial': { titulo: 'HISTORIAL LOG', ancho: '240' }, 
    'col-accion': { titulo: '<i class="fa-solid fa-bars"></i>', ancho: '65' }
};
    
let colOrder = JSON.parse(localStorage.getItem('tms_colOrder'));
if (!colOrder || colOrder.length !== Object.keys(columnasDef).length) colOrder = Object.keys(columnasDef);

let hiddenCols = JSON.parse(localStorage.getItem('tms_hiddenCols')) || { 'col-contenedores': false, 'col-alertas': false, 'col-historial': false };

window.estatusData = { 
    "s1":{nombre:"1. Ruta",col:"#10b981"}, "s2":{nombre:"1.1 PARADO",col:"#ef4444"}, "s3":{nombre:"1.2 RETEN",col:"#d97706"}, "s4":{nombre:"1.3 Resguardo",col:"#8b5cf6"}, "s5":{nombre:"1.4 REGRESANDO",col:"#f59e0b"}, "s6":{nombre:"2. Incidencia",col:"#be123c"}, "s7":{nombre:"3. Cargando",col:"#64748b"}, "s8":{nombre:"4. Descargando",col:"#0284c7"}, "s9":{nombre:"5. Patio GDL",col:"#06b6d4"}, "s10":{nombre:"6. Patio Reynosa",col:"#14b8a6"}, "s11":{nombre:"7. Taller",col:"#94a3b8"}, "s12":{nombre:"8. Finalizado",col:"#1e40af"}, "s13":{nombre:"9. Baja cobertura",col:"#fbbf24"}, "s14":{nombre:"ALIMENTOS",col:"#f59e0b"} 
};

// --- FUNCIONES MATEMÁTICAS Y DE FECHA ---
function hexToRgba(hex, alpha) {
    if(!hex || hex.length !== 7) return `rgba(15, 23, 42, ${alpha})`;
    let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeSafe(str) { return str ? String(str).replace(/'/g, "\\'") : ""; }
function limpiarStr(str) { return str ? String(str).trim().replace(/\s+/g, ' ').toUpperCase() : ""; }

function encontrarUnidad(v, vId) {
    if(!v) return null;
    if(v.wialonId && v.wialonId !== "EXTERNO" && unidadesGlobales[v.wialonId]) return unidadesGlobales[v.wialonId];
    let n = String(v.unidadN || v.unidadFallback || "").trim().toUpperCase(); let norm = n.replace(/[\s\-]/g, "");
    for(let k in unidadesGlobales) {
        let uName = String(unidadesGlobales[k].name).trim().toUpperCase();
        if(uName === n || uName.replace(/[\s\-]/g, "") === norm) return unidadesGlobales[k];
    }
    if(unidadesGlobales[vId]) return unidadesGlobales[vId]; return null; 
}

function isInsidePolygon(point, vs) {
    let x = point[0], y = point[1], inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y;
        let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    } return inside;
}
    
function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; const dLat = (lat2-lat1)*Math.PI/180; const dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
    
function resolverGeocerca(lat, lon) {
    if(!geocercasNativas || geocercasNativas.length === 0) return null;
    for(let z of geocercasNativas) {
        if(!z.p) continue;
        if(z.t === 3) { let r = z.p[0].r || 50; if(getDistanceMeters(lat, lon, z.p[0].y, z.p[0].x) <= r) return z.n; } 
        else { if(isInsidePolygon([lon, lat], z.p)) return z.n; }
    } return null;
}

function formatearFechaElegante(ms) {
    if (!ms) return "--:--"; let d = new Date(ms); let meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    return `${String(d.getDate()).padStart(2, '0')} ${meses[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
    
function formatTimeFriendly(unixSecs) { 
    if(!unixSecs) return "--:--"; let d = new Date(unixSecs * 1000); let today = new Date();
    let timeStr = d.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'});
    if(d.toDateString() === today.toDateString()) return timeStr;
    return d.toLocaleDateString('es-MX', {day:'2-digit', month:'short'}) + " " + timeStr; 
}
    
function getLocalISO(unixMillis) {
    if(!unixMillis) return ""; let tzoffset = (new Date()).getTimezoneOffset() * 60000;
    return (new Date(unixMillis - tzoffset)).toISOString().slice(0, 16);
}
    
function timeAgo(unixSecs) {
    if(!unixSecs) return "N/A"; let diff = Math.floor(Date.now()/1000) - unixSecs;
    if(diff < 60) return `${diff}s`; if(diff < 3600) return `${Math.floor(diff/60)}m`;
    if(diff < 86400) return `${Math.floor(diff/3600)}h`;
    let d = Math.floor(diff/86400); let h = Math.floor((diff%86400)/3600);
    return `${d}d ${h}h`;
}

// --- MENÚ ORDENAMIENTO ---
function inicializarMenuColumnas() {
    let menuHtml = '';
    colOrder.forEach((k, index) => {
        let checked = !hiddenCols[k] ? 'checked' : '';
        let btnUp = index > 0 ? `<i class="fa-solid fa-arrow-up mx-1 text-primary cp fs-6" title="Mover Izquierda" onclick="moverColumna(${index}, -1)"></i>` : `<i class="fa-solid fa-arrow-up mx-1 text-muted fs-6" style="opacity:0.2"></i>`;
        let btnDown = index < colOrder.length - 1 ? `<i class="fa-solid fa-arrow-down mx-1 text-primary cp fs-6" title="Mover Derecha" onclick="moverColumna(${index}, 1)"></i>` : `<i class="fa-solid fa-arrow-down mx-1 text-muted fs-6" style="opacity:0.2"></i>`;
        menuHtml += `<li class="dropdown-item d-flex justify-content-between align-items-center py-1 px-3 border-bottom">
                        <label class="cp mb-0 flex-grow-1"><input type="checkbox" class="form-check-input me-2" onchange="toggleCol('${k}', this.checked)" ${checked}> <span style="font-size:0.7rem; font-weight:bold;">${columnasDef[k].titulo}</span></label>
                        <div class="d-flex bg-white rounded border px-2 py-1 shadow-sm">${btnUp}${btnDown}</div>
                    </li>`;
    });
    document.getElementById('column-toggles').innerHTML = menuHtml;
    Object.keys(hiddenCols).forEach(k => toggleCol(k, !hiddenCols[k], false));
}

function moverColumna(idx, dir) {
    if(idx + dir < 0 || idx + dir >= colOrder.length) return;
    let temp = colOrder[idx]; colOrder[idx] = colOrder[idx + dir]; colOrder[idx + dir] = temp;
    localStorage.setItem('tms_colOrder', JSON.stringify(colOrder));
    inicializarMenuColumnas(); solicitarRenderizado();
}

function toggleCol(colClass, isVisible, save = true) {
    if(save) { hiddenCols[colClass] = !isVisible; localStorage.setItem('tms_hiddenCols', JSON.stringify(hiddenCols)); }
    document.querySelectorAll('.' + colClass).forEach(el => { if(isVisible) el.classList.remove('d-none'); else el.classList.add('d-none'); });
}
    
function resetColumnas() {
    localStorage.removeItem('tms_colOrder'); localStorage.removeItem('tms_hiddenCols'); localStorage.removeItem('tms_colWidths'); location.reload();
}

function aplicarAnchosGuardados() {
    let savedWidths = JSON.parse(localStorage.getItem('tms_colWidths')) || {}; let css = '';
    Object.keys(columnasDef).forEach(c => { let w = savedWidths[c] || columnasDef[c].ancho; css += `.${c} { width: ${w}px !important; min-width: ${w}px !important; max-width: ${w}px !important; }\n`; });
    let styleEl = document.getElementById('dynamic-col-styles');
    if(!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'dynamic-col-styles'; document.head.appendChild(styleEl); }
    styleEl.innerHTML = css;
}

let isResizing = false; let currentTh = null; let startX = 0; let startWidth = 0;
document.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('resizer')) {
        isResizing = true; currentTh = e.target.parentElement; startX = e.pageX; startWidth = currentTh.offsetWidth;
        e.target.classList.add('resizing'); document.body.style.userSelect = 'none';
    }
});
document.addEventListener('mousemove', function(e) {
    if (isResizing && currentTh) {
        let newWidth = Math.max(50, startWidth + (e.pageX - startX));
        let colClass = Array.from(currentTh.classList).find(c => c.startsWith('col-'));
        if(colClass) {
            let liveStyle = document.getElementById('live-resize-style');
            if(!liveStyle) { liveStyle = document.createElement('style'); liveStyle.id = 'live-resize-style'; document.head.appendChild(liveStyle); }
            liveStyle.innerHTML = `.${colClass} { width: ${newWidth}px !important; min-width: ${newWidth}px !important; max-width: ${newWidth}px !important; }`;
        }
    }
});
document.addEventListener('mouseup', function(e) {
    if (isResizing) {
        isResizing = false; let colClass = Array.from(currentTh.classList).find(c => c.startsWith('col-'));
        if (colClass) {
            let savedWidths = JSON.parse(localStorage.getItem('tms_colWidths')) || {};
            savedWidths[colClass] = currentTh.offsetWidth; localStorage.setItem('tms_colWidths', JSON.stringify(savedWidths));
            aplicarAnchosGuardados();
            let liveStyle = document.getElementById('live-resize-style'); if(liveStyle) liveStyle.innerHTML = '';
        }
        document.querySelectorAll('.resizer').forEach(r => r.classList.remove('resizing'));
        currentTh = null; document.body.style.userSelect = '';
    }
});

function getHeadersRow(cId) {
    let html = `<tr class="header-columnas shadow-sm client-group-${cId}">`;
    colOrder.forEach((c) => {
        let titulo = columnasDef[c].titulo; let display = hiddenCols[c] ? 'd-none' : ''; 
        html += `<th class="${c} ${display} position-relative">
                    <div class="d-flex justify-content-center align-items-center h-100 px-1"><span class="text-center">${titulo}</span></div>
                    <div class="resizer" title="Arrastrar para cambiar tamaño"></div>
                </th>`;
    }); return html + `</tr>`;
}

// --- MAPA FLUIDO Y MARCADORES CON POPUP ---
function initMap() { 
    lmap = L.map('map').setView([23.6, -102.5], 5); 
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(lmap); 
    mapLayerGroup = L.layerGroup().addTo(lmap); geofenceLayerGroup = L.layerGroup().addTo(lmap);
}

function toggleMap() { 
    document.getElementById("mainWorkspace").classList.toggle("show-map"); 
    if(!lmap) initMap(); mapVisible = !mapVisible; 
    setTimeout(() => { if(lmap) { lmap.invalidateSize(); actualizarMarcadoresMapa(); pintarGeocercasEnMapa(); } }, 400); 
}

window.clickMapaUnidad = function(vId) {
    let v = viajesActivos[vId]; if(!v) return alert("Unidad no encontrada.");
    let uData = encontrarUnidad(v, vId);
    if(uData && uData.pos && typeof uData.pos.y !== 'undefined') {
        centrarUnidadMapa(uData.pos.y, uData.pos.x, vId);
    } else {
        alert("Esta unidad no tiene coordenadas GPS válidas en este momento.");
    }
};

function centrarUnidadMapa(lat, lon, vId) { 
    if(!mapVisible) toggleMap(); 
    setTimeout(() => { 
        if(lmap) {
            lmap.flyTo([lat, lon], 16, { animate: true, duration: 1.5 });
            if(vId && mapaMarcadores[vId]) {
                setTimeout(() => { mapaMarcadores[vId].openPopup(); }, 1500); 
            }
        }
    }, 400); 
}

function actualizarMarcadoresMapa() {
    if(!lmap || !mapLayerGroup) return; 
    mapLayerGroup.clearLayers();
    mapaMarcadores = {}; 
    
    Object.keys(viajesActivos).forEach(vId => {
        let v = viajesActivos[vId]; if(typeof v !== 'object' || !v) return;
        let uData = encontrarUnidad(v, vId);
        
        if(uData && uData.pos && typeof uData.pos.y !== 'undefined') {
            let isMoving = uData.pos.s > 0;
            let colorIcon = isMoving ? '#10b981' : '#0284c7';
            let course = uData.pos.c || 0;
            
            let rotation = course - 45;
            
            let markerHtml = isMoving 
                ? `<div style="transform: rotate(${rotation}deg); color: ${colorIcon}; font-size: 22px; text-shadow: 0 2px 4px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;"><i class="fa-solid fa-location-arrow"></i></div>` 
                : `<div style="color: ${colorIcon}; font-size: 24px; text-shadow: 0 2px 4px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;"><i class="fa-solid fa-location-dot"></i></div>`;
            
            let customIcon = L.divIcon({ html: markerHtml, className: '', iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -14] });
            
            let vel = uData.pos.s;
            let est = window.estatusData[v.estatus]?.nombre || "En Trayecto";
            let operador = escapeSafe(v.operador || (uData.choferObj && uData.choferObj.nombre !== "Sin asignar" ? uData.choferObj.nombre : "Sin Operador"));

            let popupContent = `
                <div style="text-align:center; min-width: 160px; font-family: 'Inter', sans-serif;">
                    <b style="font-size:15px; color:#0f172a; text-transform:uppercase;">${escapeSafe(uData.name)}</b><br>
                    <span style="font-size:11px; color:#64748b; font-weight:bold;">${operador}</span><br>
                    <div style="margin-top:5px; margin-bottom:5px; background:${isMoving?'#10b981':'#64748b'}; color:white; border-radius:4px; padding:2px; font-weight:bold; font-size:12px;">${vel} km/h</div>
                    <b style="font-size:11px; color:#0284c7;">${est}</b><br>
                    <span style="color:#94a3b8; font-size:10px;">Act: hace ${timeAgo(uData.pos.t)}</span>
                </div>
            `;
            let marker = L.marker([uData.pos.y, uData.pos.x], {icon: customIcon}).bindPopup(popupContent, {className: 'custom-popup'}).addTo(mapLayerGroup);
            mapaMarcadores[vId] = marker;
        }
    });
}

function pintarGeocercasEnMapa() {
    if(!lmap || !geofenceLayerGroup) return; geofenceLayerGroup.clearLayers();
    geocercasNativas.forEach(z => {
        let colorHex = z.c ? `#${z.c.toString(16).padStart(6, '0')}` : '#3b82f6';
        if(z.t === 3 && z.p && z.p[0]) L.circle([z.p[0].y, z.p[0].x], {radius: z.p[0].r, color: colorHex, weight: 2, fillOpacity: 0.15}).bindTooltip(z.n).addTo(geofenceLayerGroup);
        else if((z.t === 1 || z.t === 2) && z.p) L.polygon(z.p.map(pt => [pt.y, pt.x]), {color: colorHex, weight: 2, fillOpacity: 0.15}).bindTooltip(z.n).addTo(geofenceLayerGroup);
    });
}

// --- HUBS DE NOTIFICACIONES ---
db.ref('notificaciones_pendientes').on('value', snap => {
    let data = snap.val() || {}; alertasSeguridad = {}; alertasLogistica = {};
    Object.keys(data).forEach(k => { 
        let notif = data[k]; notif.id = k; 
        if (['SALIDA', 'ARRIBO', 'FINALIZACION'].includes(notif.tipo)) alertasLogistica[k] = notif; 
        else alertasSeguridad[k] = notif; 
    });
    actualizarBotonesHubs();
});

window.enviarNotificacionPersistente = function(vId, unidadName, tipo, detalle) {
    let idLogico = vId + "_" + tipo; 
    db.ref('notificaciones_pendientes/' + idLogico).once('value', snap => { 
        if(!snap.exists()) { 
            db.ref('notificaciones_pendientes/' + idLogico).set({ vId: vId, unidad: unidadName, tipo: tipo, detalle: detalle, t_evento: Date.now() }); 
        } 
    });
};

window.actualizarBotonesHubs = function() {
    let cSeg = Object.keys(alertasSeguridad).length; let cLog = Object.keys(alertasLogistica).length;
    let bSeg = document.getElementById("btnHubSeguridad"); let lSeg = document.getElementById("lblCountSeguridad");
    if(bSeg && lSeg) { 
        if(cSeg>0) { lSeg.innerText=cSeg; bSeg.classList.remove("d-none"); } 
        else { bSeg.classList.add("d-none"); try{ bootstrap.Modal.getInstance(document.getElementById('modalHubSeguridad')).hide(); }catch(e){} } 
    }
    let bLog = document.getElementById("btnHubLogistico"); let lLog = document.getElementById("lblCountLogistico");
    if(bLog && lLog) { 
        if(cLog>0) { lLog.innerText=cLog; bLog.classList.remove("d-none"); } 
        else { bLog.classList.add("d-none"); try{ bootstrap.Modal.getInstance(document.getElementById('modalHubLogistico')).hide(); }catch(e){} } 
    }
};

window.abrirHubSeguridad = function() {
    let container = document.getElementById("listaHubSeguridad"); container.innerHTML = "";
    let count = Object.keys(alertasSeguridad).length; if (count === 0) return;
    Object.values(alertasSeguridad).forEach(n => {
        let icon = n.tipo === "PARADA" ? "fa-stop text-danger" : (n.tipo === "REANUDACION" ? "fa-play text-success" : "fa-triangle-exclamation text-warning");
        container.innerHTML += `
        <div class="bg-white p-3 rounded shadow-sm border border-danger mb-3">
            <div class="d-flex justify-content-between align-items-start mb-2">
                <div>
                    <div class="fw-bold text-dark" style="font-size:0.95rem;"><i class="fa-solid ${icon} me-1"></i> ${escapeSafe(n.unidad)}</div>
                    <div class="text-muted" style="font-size:0.8rem;">${escapeSafe(n.detalle)} (Sensor: ${formatTimeFriendly(n.t_evento/1000)})</div>
                </div>
            </div>
            <textarea id="nota_hub_${n.id}" class="form-control border-secondary mb-2" rows="2" placeholder="Justificación o anotación..."></textarea>
            <div class="d-flex gap-2 justify-content-end">
                <button class="btn btn-sm btn-outline-danger fw-bold px-3" onclick="rechazarNotificacion('${n.id}', true)"><i class="fa-solid fa-xmark"></i> Falsa Alarma</button>
                <button class="btn btn-sm btn-success fw-bold px-3" onclick="confirmarNotificacion('${n.id}', true)"><i class="fa-solid fa-check"></i> Confirmar y Guardar</button>
            </div>
        </div>`;
    }); 
    new bootstrap.Modal(document.getElementById('modalHubSeguridad')).show();
};

window.abrirHubLogistico = function() {
    let container = document.getElementById("listaHubLogistico"); container.innerHTML = "";
    let count = Object.keys(alertasLogistica).length; if (count === 0) return;
    Object.values(alertasLogistica).forEach(n => {
        let icon = n.tipo === "SALIDA" ? "fa-rocket text-primary" : (n.tipo === "ARRIBO" ? "fa-map-pin text-success" : "fa-flag-checkered text-dark"); 
        let borderClass = n.tipo === "SALIDA" ? "border-primary" : (n.tipo === "ARRIBO" ? "border-success" : "border-dark");
        container.innerHTML += `
        <div class="bg-white p-3 rounded shadow-sm border ${borderClass} mb-3">
            <div class="d-flex justify-content-between align-items-start mb-2">
                <div>
                    <div class="fw-bold text-dark" style="font-size:0.95rem;"><i class="fa-solid ${icon} me-1"></i> ${escapeSafe(n.unidad)}</div>
                    <div class="text-muted" style="font-size:0.8rem;">${escapeSafe(n.detalle)} (Sensor: ${formatTimeFriendly(n.t_evento/1000)})</div>
                </div>
            </div>
            <textarea id="nota_hub_${n.id}" class="form-control border-secondary mb-2" rows="1" placeholder="Nota adicional (opcional)..."></textarea>
            <div class="d-flex gap-2 justify-content-end">
                <button class="btn btn-sm btn-outline-danger fw-bold px-3" onclick="rechazarNotificacion('${n.id}', false)"><i class="fa-solid fa-xmark"></i> Falsa Alarma</button>
                <button class="btn btn-sm btn-success fw-bold px-3" onclick="confirmarNotificacion('${n.id}', false)"><i class="fa-solid fa-check"></i> Confirmar Evento</button>
            </div>
        </div>`;
    }); 
    new bootstrap.Modal(document.getElementById('modalHubLogistico')).show();
};

window.confirmarNotificacion = function(id, isSeguridad) {
    UI_PAUSED = false;
    let n = isSeguridad ? alertasSeguridad[id] : alertasLogistica[id]; if(!n) return;
    let inputEl = document.getElementById('nota_hub_' + id); let nota = inputEl ? inputEl.value.trim() : "";
    if(isSeguridad && n.tipo === "PARADA" && !nota) return alert("⚠️ Escribe una justificación para la parada.");
    let vId = n.vId; let detalleLog = `Sensor: ${formatTimeFriendly(n.t_evento/1000)}`; if (nota) detalleLog += ` | Nota: ${nota}`;
    
    if (n.tipo === "SALIDA") { db.ref('viajes_activos/'+vId).update({ t_salida: n.t_evento }); registrarLog(vId, 'Confirmó SALIDA', detalleLog); } 
    else if (n.tipo === "ARRIBO") { db.ref('viajes_activos/'+vId).update({ t_arribo: n.t_evento, estatus: 's8' }); registrarLog(vId, 'Confirmó ARRIBO', detalleLog); } 
    else if (n.tipo === "FINALIZACION") { db.ref('viajes_activos/'+vId).update({ t_fin: n.t_evento, estatus: 's12' }); registrarLog(vId, 'Confirmó FINALIZADO', detalleLog); } 
    else if (n.tipo === "PARADA") { db.ref('viajes_activos/'+vId).update({ estatus: 's2', alerta_detenida: true }); registrarLog(vId, 'Justificó PARADA', detalleLog); } 
    else if (n.tipo === "REANUDACION") { db.ref('viajes_activos/'+vId).update({ estatus: 's1', alerta_detenida: null }); registrarLog(vId, 'Confirmó REANUDACIÓN', detalleLog); } 
    
    db.ref('notificaciones_pendientes/' + id).remove(); mostrarNotificacion("✅ Evento guardado."); 
    if(isSeguridad) setTimeout(window.abrirHubSeguridad, 100); else setTimeout(window.abrirHubLogistico, 100);
};

window.rechazarNotificacion = function(id, isSeguridad) {
    UI_PAUSED = false;
    let n = isSeguridad ? alertasSeguridad[id] : alertasLogistica[id]; if(!n) return;
    let inputEl = document.getElementById('nota_hub_' + id); let nota = inputEl ? inputEl.value.trim() : ""; 
    let detalleLog = `Falsa Alarma`; if(nota) detalleLog += ` | Nota: ${nota}`;
    
    registrarLog(n.vId, `Rechazó alerta de ${n.tipo}`, detalleLog); 
    db.ref('notificaciones_pendientes/' + id).remove(); 
    mostrarNotificacion("🚫 Descartado."); 
    
    if(isSeguridad) setTimeout(window.abrirHubSeguridad, 100); else setTimeout(window.abrirHubLogistico, 100);
};

// --- ACCIONES SECUNDARIAS ---
window.cambiarEstatus = function(val, vId) {
    let txt = window.estatusData[val].nombre; 
    registrarLog(vId, 'Cambió estatus a', txt); 
    db.ref('viajes_activos/'+vId+'/estatus').set(val);
};

// WHATSAPP REPARADO (Google Maps Format Correcto)
window.enviarWA = function(vId) {
    let v = viajesActivos[vId]; if(!v) return;
    let uData = encontrarUnidad(v, vId); let nombreCamion = String(v.unidadN || v.unidadFallback || "Desconocida").trim().toUpperCase();
    let estNombre = window.estatusData[v.estatus]?.nombre || "En Trayecto"; let pos = uData ? uData.pos : null; let speed = pos ? pos.s : 0;
    
    let cliId = v.cliente || "Sin_Cliente"; let subId = v.subcliente || "N/A";
    let cliName = (dataClientes[cliId] && dataClientes[cliId].nombre) ? dataClientes[cliId].nombre : "SIN CLIENTE";
    let subName = (dataClientes[cliId] && dataClientes[cliId].subclientes && dataClientes[cliId].subclientes[subId]) ? dataClientes[cliId].subclientes[subId].nombre : "";
    let subText = subName && subName !== "N/A" ? ` -> ${subName}` : '';
    
    let addrText = v.ubicacion_manual || "Buscando..."; let locLink = addrText; let geoTextWA = "";

    if (pos && typeof pos.y !== 'undefined' && typeof pos.x !== 'undefined') {
        let zonaGeo = (uData && uData.zonaOficial) ? uData.zonaOficial : resolverGeocerca(pos.y, pos.x);
        if(zonaGeo) geoTextWA = `\n📍 *Geocerca:* ${zonaGeo}`;
        let domAddr = document.getElementById("addr_" + vId);
        if(domAddr && domAddr.innerText !== "Buscando...") { addrText = domAddr.innerText.trim(); } else { addrText = "Ubicación GPS"; }
        
        // CORRECCIÓN LINK WA: http://maps.google.com/?q=lat,lon
        locLink = `${addrText} \nhttp://maps.google.com/?q=${pos.y},${pos.x}`;
    }
    
    let arrDests = v.destino ? String(v.destino).split(/,|\n/).map(d => d.trim()).filter(d => d !== "") : [];
    let cIdx = v.destino_idx || 0;
    let cOrigen = v.origen_actual || v.origen || "N/A";
    let cDestino = arrDests[cIdx] || v.destino || "N/A";

    let text = `*GRUDICOM TI & GPS - REPORTE DE UNIDAD*\n\n🏢 *Cliente:* ${cliName}${subText}\n\n🚛 *Unidad:* ${nombreCamion}\n📦 *Contenedores:* ${v.contenedores||'N/A'}\n🛣️ *Ruta:* ${cOrigen} ➔ ${cDestino}\n🚦 *Estatus:* ${estNombre}\n⏱️ *Vel:* ${speed} km/h${geoTextWA}\n📍 *Ubicación:* ${locLink}\n\n_Reporte C4_`;
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank'); 
};

window.generarReporteGrupal = function(cId, sId, titulo) {
    if(!datosAgrupadosGlobal[cId] || !datosAgrupadosGlobal[cId][sId]) return;
    let arrViajes = datosAgrupadosGlobal[cId][sId];
    let txt = `*GRUDICOM TI & GPS - REPORTE DE FLOTA*\n🏢 *${titulo}*\n\n`;
    
    arrViajes.forEach(({v, vId}) => {
        let uData = encontrarUnidad(v, vId); let name = String(v.unidadN || v.unidadFallback || "Desconocida").trim().toUpperCase();
        let est = window.estatusData[v.estatus]?.nombre || "En Trayecto"; let pos = uData ? uData.pos : null; let vel = pos ? pos.s : 0;
        let addrText = v.ubicacion_manual || "Manual"; let locLink = addrText; let geoTextWA = "";
        
        if (pos && typeof pos.y !== 'undefined' && typeof pos.x !== 'undefined') {
            let zonaGeo = (uData && uData.zonaOficial) ? uData.zonaOficial : resolverGeocerca(pos.y, pos.x);
            if(zonaGeo) geoTextWA = `\n📍 *Geocerca:* ${zonaGeo}`;
            locLink = `http://maps.google.com/?q=${pos.y},${pos.x}`;
        }
        
        let arrDests = v.destino ? String(v.destino).split(/,|\n/).map(d => d.trim()).filter(d => d !== "") : [];
        let cIdx = v.destino_idx || 0;
        let cOrigen = v.origen_actual || v.origen || "N/A";
        let cDestino = arrDests[cIdx] || v.destino || "N/A";
        
        txt += `🚛 *Unidad:* ${name}\n📦 *Contenedores:* ${v.contenedores||'N/A'}\n⏱️ *Vel:* ${vel} km/h\n🚦 *Estatus:* ${est}\n🏁 *Ruta:* ${cOrigen} ➔ ${cDestino}${geoTextWA}\n📍 *Ubicación:* ${locLink}\n\n`;
    });
    
    txt += `_Reporte C4_`; 
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(txt)}`, '_blank');
};

// --- CAPTURA DE PANTALLA INTELIGENTE (RAYO BORRADOR) ---
window.generarCapturaCliente = async function(cId, cliName) {
    let tableWrap = document.getElementById('scrollContainer');
    let allRows = document.querySelectorAll('#units-body tr');
    let hiddenRows = [];
    
    allRows.forEach(r => {
        if(!r.classList.contains(`client-group-${cId}`)) {
            hiddenRows.push({el: r, display: r.style.display}); 
            r.style.display = 'none';
        }
    });

    // Ocultar columnas indeseadas para la foto
    let colsToHide = document.querySelectorAll('.col-operador, .col-alertas, .col-accion, .col-historial');
    let originalDisplaysCols = [];
    colsToHide.forEach(el => { originalDisplaysCols.push({el: el, disp: el.style.display}); el.style.display = 'none'; });
    
    let oldHeight = tableWrap.style.height; let oldMaxHeight = tableWrap.style.maxHeight; let oldOverflow = tableWrap.style.overflow;
    tableWrap.style.height = 'auto'; tableWrap.style.maxHeight = 'none'; tableWrap.style.overflow = 'visible';
    let oldW = document.getElementById("mainTable").style.width; document.getElementById("mainTable").style.width = "max-content";

    await new Promise(r => setTimeout(r, 400));
    
    try {
        let canvas = await html2canvas(document.getElementById('mainTable'), { scale: 2, backgroundColor: '#f1f5f9', useCORS: true });
        
        canvas.toBlob(function(blob) {
            currentCaptureBlob = blob;
            document.getElementById('imgPreviewCaptura').src = URL.createObjectURL(blob);
            new bootstrap.Modal(document.getElementById('modalPreviewCaptura')).show();
        }, 'image/png');
        
    } catch(e) { console.error(e); alert("Error al generar captura de pantalla."); } 
    finally {
        tableWrap.style.height = oldHeight; tableWrap.style.maxHeight = oldMaxHeight; tableWrap.style.overflow = oldOverflow;
        document.getElementById("mainTable").style.width = oldW;
        hiddenRows.forEach(item => item.el.style.display = item.display);
        colsToHide.forEach((el, i) => el.style.display = originalDisplaysCols[i].disp);
    }
};

window.descargarCaptura = function() {
    if(!currentCaptureBlob) return;
    let link = document.createElement('a'); link.download = `Estatus_Bitacora.png`;
    link.href = URL.createObjectURL(currentCaptureBlob); link.click();
};

window.copiarCaptura = async function() {
    if(!currentCaptureBlob) return;
    try {
        const item = new ClipboardItem({ "image/png": currentCaptureBlob });
        await navigator.clipboard.write([item]);
        alert("¡Imagen copiada! Ya puedes pegarla en WhatsApp Web (Ctrl+V).");
    } catch (err) { alert("Tu navegador no permite copiar directo. Usa el botón Descargar."); }
};

window.compartirCaptura = async function() {
    if(!currentCaptureBlob) return;
    if (navigator.share) {
        try {
            const file = new File([currentCaptureBlob], "Estatus.png", { type: "image/png" });
            await navigator.share({ title: 'Estatus Bitácora', files: [file] });
        } catch (err) { console.log("Share cancelado"); }
    } else { alert("Tu navegador no soporta compartir directo."); }
};

window.editarUbicacionManual = function(vId) {
    let v = viajesActivos[vId]; if(!v) return;
    let uName = String(v.unidadN || v.unidadFallback || "Desconocida").trim().toUpperCase();
    let u = prompt(`Escribir ubicación manual para ${uName}:`, v.ubicacion_manual || '');
    if(u !== null) { db.ref(`viajes_activos/${vId}/ubicacion_manual`).set(String(u).toUpperCase()); registrarLog(vId, 'Añadió Ubicación Manual', String(u).toUpperCase()); }
};

window.registrarLog = function(viajeId, accion, detalle = "") { 
    let usrName = currentUser ? currentUser.nom : "Sistema"; 
    db.ref(`viajes_activos/${viajeId}/log`).push({ t: Date.now(), usr: usrName, act: accion, det: detalle }); 
};













// ============================================================================
// PARTE 2: ARRANQUE, LOGIN, WIALON API Y MOTOR DE INYECCIÓN GPS
// ============================================================================

window.onload = function () {
    aplicarAnchosGuardados();
    inicializarMenuColumnas();
    
    db.ref('clientes').on('value', s => { dataClientes = s.val() || {}; actualizarListasAdmin(); solicitarRenderizado(); });
    db.ref('viajes_activos').on('value', s => { viajesActivos = s.val() || {}; solicitarRenderizado(); });
    db.ref('sistema/tokens').on('value', s => { let tks = s.val() || {}; configSistema.tokens = Object.values(tks); actualizarListaTokensAdmin(tks); if(currentUser && !motorArrancado) arranqueMotor(); });
    
    document.getElementById("logPass").addEventListener("keyup", e => e.key === "Enter" && autenticarUsuario());
    let sU = localStorage.getItem("tms_user"), sP = localStorage.getItem("tms_pass"); if(sU && sP) autenticarUsuario(sU, sP);
    setInterval(procesarFilaDirecciones, 1100); 
};

window.autenticarUsuario = function(aU, aP) {
    const u = aU || document.getElementById("logUser").value.trim(); const p = aP || document.getElementById("logPass").value.trim(); if(!u || !p) return;
    document.getElementById("status").innerText = "Conectando..."; document.getElementById("status").className = "mt-3 small fw-bold text-primary";
    
    db.ref(`sistema/usuarios/${u}`).once('value').then(s => {
        let user = s.val(); if(!user && u === "admin" && p === "admin123") user = { pass: "admin123", rol: "admin", nom: "Administrador Maestro" };
        if(user && user.pass === p) {
            currentUser = user; localStorage.setItem("tms_user", u); localStorage.setItem("tms_pass", p);
            document.getElementById("loginOverlay").style.display = "none"; document.getElementById("dashboard").style.display = "flex";
            document.getElementById("lblUsuarioActivo").innerHTML = "<i class='fa-solid fa-user-shield me-1'></i> Monitor: " + currentUser.nom;
            if(currentUser.rol === "admin") document.getElementById("btnAdminMenu").style.display = "block";
            if(!motorArrancado) arranqueMotor();
        } else { document.getElementById("status").innerText = "Credenciales Incorrectas"; document.getElementById("status").className = "mt-3 small fw-bold text-danger"; }
    }).catch(err => { document.getElementById("status").innerText = "Error de red."; document.getElementById("status").className = "mt-3 small fw-bold text-danger"; });
};

function peticionWialon(url, svc, params, sid=null) {
    return new Promise(resolve => {
        let script = document.createElement("script"); let cb = "wialon_cb_" + Date.now() + Math.floor(Math.random()*1000);
        let timeout = setTimeout(() => { delete window[cb]; script.remove(); resolve(null); }, 8000);
        window[cb] = d => { clearTimeout(timeout); delete window[cb]; script.remove(); resolve(d); };
        script.onerror = () => { clearTimeout(timeout); delete window[cb]; script.remove(); resolve(null); };
        script.src = `${url.replace(/\/$/, '')}/wialon/ajax.html?svc=${svc}&params=${encodeURIComponent(JSON.stringify(params))}&callback=${cb}${sid?'&sid='+sid:''}`; document.head.appendChild(script);
    });
}

window.arranqueMotor = async function() { 
    if(pollingInterval) clearInterval(pollingInterval); 
    motorArrancado = true; 
    await sincronizarFlotas(); 
    pollingInterval = setInterval(sincronizarFlotas, 20000); 
};

function renderStatusTokens() {
    const lista = document.getElementById("listaStatusTokens"); let html = "";
    for(let tk in estadoTokens) { let stat = estadoTokens[tk]; let badge = stat.status === 'OK' ? '<span class="badge bg-success shadow-sm">ONLINE</span>' : '<span class="badge bg-danger shadow-sm">OFFLINE</span>'; html += `<li class="list-group-item d-flex justify-content-between align-items-center p-2"><div class="fw-bold" style="font-size:0.8rem;">${tk}</div> <div><span class="badge bg-secondary me-2 shadow-sm">${stat.count} Unidades</span> ${badge}</div></li>`; }
    lista.innerHTML = html || '<li class="list-group-item text-center">No hay tokens</li>';
}

window.sincronizarFlotas = async function() {
    if(isSyncingFlotas) return; isSyncingFlotas = true;
    try {
        let indMenu = document.getElementById("menuSyncIndicator"); if(indMenu) indMenu.innerHTML = `<i class="fa-solid fa-satellite-dish text-warning"></i> Sincronizando...`;
        estadoTokens = {}; let tempUnits = {}, tempGeo = [], listUni = new Set(); let conexionesExitosas = 0;

        let promesas = configSistema.tokens.map(async (tk) => {
            try {
                if(!tk.url || !tk.token) return;
                if(!activeSIDs[tk.token]) { let l = await peticionWialon(tk.url, "token/login", {token: tk.token}); if(l && l.eid) activeSIDs[tk.token] = { sid: l.eid }; }
                let auth = activeSIDs[tk.token]; if(!auth || !auth.sid) { estadoTokens[tk.nombre] = { status: 'ERR', count: 0 }; return; }

                let autoLoginUrl = `${tk.url.includes("hst-api") ? "https://hosting.wialon.com" : tk.url}/login.html?token=${tk.token}`;

                let reqR = await peticionWialon(tk.url, "core/search_items", { spec: {itemsType: "avl_resource", propName: "sys_name", propValueMask: "*", sortType: "sys_name"}, force: 1, flags: 1 + 256 + 4096, from: 0, to: 4294967295 }, auth.sid);
                let diccChoferes = {}; let diccZonasReq = {}; let diccZonasNombres = {};

                if(reqR && reqR.items) {
                    reqR.items.forEach(r => { 
                        let rId = r.id; diccZonasReq[rId] = []; diccZonasNombres[rId] = {};
                        if(r.zl) { Object.values(r.zl).forEach(z => { diccZonasReq[rId].push(z.id); diccZonasNombres[rId][z.id] = z.n; tempGeo.push(z); }); }
                        if(r.drvrs || r.drv) {
                            let drivers = r.drvrs || r.drv;
                            Object.values(drivers).forEach(d => { 
                                if(d.bu && d.bu > 0) { 
                                    let telStr = d.p ? String(d.p) : ""; 
                                    diccChoferes[d.bu] = { nombre: d.n, tel: telStr, cod: d.c || "---", rid: rId }; 
                                } 
                            }); 
                        }
                    });
                }

                let reqU = await peticionWialon(tk.url, "core/search_items", { spec: {itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name"}, force: 1, flags: 1 + 1024, from: 0, to: 4294967295 }, auth.sid);
                if(reqU && reqU.items) {
                    conexionesExitosas++; estadoTokens[tk.nombre] = { status: 'OK', count: reqU.items.length };
                    let uIds = reqU.items.map(u => u.id); let checkGeo = {};
                    if(uIds.length > 0) checkGeo = await peticionWialon(tk.url, "resource/get_zones_by_unit", { spec: { zoneId: diccZonasReq, units: uIds, time: 0 } }, auth.sid);

                    reqU.items.forEach(u => { 
                        let n = String(u.nm || "Desconocida").toUpperCase(); 
                        let chofer = diccChoferes[u.id] || { nombre: "Sin asignar", tel: "", cod: "---", rid: null };
                        let miZona = null; let recursoDueño = chofer.rid ? chofer.rid : u.bact;
                        
                        if (recursoDueño && checkGeo && checkGeo[recursoDueño]) {
                            for (let zId in checkGeo[recursoDueño]) { if (checkGeo[recursoDueño][zId].includes(u.id)) { miZona = diccZonasNombres[recursoDueño][zId]; break; } }
                        } else if (checkGeo) {
                            for (let rId in checkGeo) {
                                for (let zId in checkGeo[rId]) { if (checkGeo[rId][zId].includes(u.id)) { miZona = diccZonasNombres[rId][zId]; break; } }
                                if (miZona) break;
                            }
                        }
                        tempUnits[u.id] = { id: u.id, name: n, pos: u.pos, loginUrl: autoLoginUrl, choferObj: chofer, zonaOficial: miZona }; listUni.add(n); 
                    });
                } else { estadoTokens[tk.nombre] = { status: 'ERR', count: 0 }; }
            } catch(errTk) { console.error("Token Falló:", tk.nombre); }
        });

        await Promise.all(promesas); 
        unidadesGlobales = tempUnits; geocercasNativas = tempGeo;
        document.getElementById("listaUnidadesTotales").innerHTML = Array.from(listUni).map(n => `<option value="${n}">`).join('');
        document.getElementById("listaGeocercas").innerHTML = tempGeo.map(z => `<option value="${String(z.n).toUpperCase()}">`).join('');
        
        if(indMenu) {
            if(conexionesExitosas > 0) indMenu.innerHTML = `<span class="badge bg-success shadow-sm rounded-pill py-1 px-2">${Object.keys(unidadesGlobales).length} Camiones Live</span>`;
            else indMenu.innerHTML = `<span class="badge bg-danger shadow-sm rounded-pill py-1 px-2">Error GPS - Offline</span>`;
        }
        renderStatusTokens(); inyectarGPSenTabla(); 
        if(mapVisible) { actualizarMarcadoresMapa(); pintarGeocercasEnMapa(); }
    } catch(errSync) { console.error("Error Global:", errSync); } finally { isSyncingFlotas = false; }
};

function inyectarGPSenTabla() {
    Object.keys(viajesActivos).forEach(vId => {
        try {
            let v = viajesActivos[vId]; if(typeof v !== 'object' || !v) return;
            let uData = encontrarUnidad(v, vId); let isExternal = v.wialonId === "EXTERNO"; 
            let pos = uData ? uData.pos : null; let speed = pos ? pos.s : 0; 
            
            // LA CLAVE ANTI-CRASH (Sombra de Señal)
            let hasCoords = pos && typeof pos.y !== 'undefined' && typeof pos.x !== 'undefined';
            let isLost = !uData || (!hasCoords && !isExternal);
            
            let ageSecs = pos && pos.t ? Math.floor(Date.now()/1000) - pos.t : 0;
            let isStale = ageSecs > 14400; // 4 Horas sin datos de Wialon
            
            let row = document.getElementById("row_" + vId);
            if(row) {
                row.classList.remove("lost-connection-row", "stale-row");
                if(isLost && !isExternal) row.classList.add("lost-connection-row");
                else if (isStale && !isExternal) row.classList.add("stale-row");
            }

            let safeName = uData ? uData.name : "Desconocida";

            // LOGICA HUBS (PARADAS AUTOMÁTICAS)
            if(!isExternal && !isLost && !isStale) {
                if(v.t_salida && !v.t_arribo) {
                    if(speed < 4) {
                        if (!v.t_parada_inicio) { db.ref('viajes_activos/'+vId+'/t_parada_inicio').set(Date.now()); }
                        else {
                            let minsDetenido = (Date.now() - v.t_parada_inicio) / 60000;
                            if (minsDetenido >= 5 && !v.alerta_detenida) {
                                db.ref('viajes_activos/'+vId).update({ alerta_detenida: true });
                                enviarNotificacionPersistente(vId, safeName, 'PARADA', 'Detenida > 5 min');
                            }
                        }
                    } else {
                        if (v.t_parada_inicio) db.ref('viajes_activos/'+vId+'/t_parada_inicio').set(null);
                    }
                }
            }

            let elGpsCell = document.getElementById("gps_cell_" + vId);
            if(elGpsCell) {
                if (isExternal) {
                    elGpsCell.innerHTML = `<div class="d-flex flex-column px-1 w-100"><div class="d-flex justify-content-between align-items-center border-bottom border-light pb-1 mb-1"><div class="d-flex align-items-center"><i class="fa-solid fa-globe text-info me-1 fs-6"></i> <span class="speed-badge bg-secondary m-0">-- km/h</span></div><div style="font-size:0.65rem; color:#64748b; font-weight:800;">Externa</div></div><div class="d-flex align-items-center gap-2 text-start"><span class="text-info fw-bold" style="font-size:0.65rem;">GPS EXTERNO</span><i class="fa-solid fa-pencil ms-2 text-primary cp" title="Editar" onclick="editarUbicacionManual('${vId}')"></i><div class="addr-container flex-grow-1">${v.ubicacion_manual||'--'}</div></div></div>`;
                } else if (isLost) {
                    elGpsCell.innerHTML = `<div class="d-flex flex-column px-1 w-100"><div class="d-flex justify-content-between align-items-center border-bottom border-danger pb-1 mb-1"><div class="d-flex align-items-center"><i class="fa-solid fa-triangle-exclamation text-danger me-1 fs-6"></i> <span class="speed-badge bg-secondary m-0">${speed} km/h</span></div><div style="font-size:0.65rem; color:#ef4444; font-weight:800;">Modo Offline</div></div><div class="d-flex align-items-center gap-2 text-start"><span class="text-danger fw-bold" style="font-size:0.65rem;">SIN SEÑAL</span><i class="fa-solid fa-pencil ms-2 text-primary cp" title="Editar" onclick="editarUbicacionManual('${vId}')"></i><div class="addr-container flex-grow-1">${v.ubicacion_manual||'--'}</div></div></div>`;
                } else {
                    let speedBg = "#64748b"; if(speed > 0 && speed < 100) speedBg = "#10b981"; if(speed >= 100) speedBg = "#ef4444"; 
                    if(isStale) speedBg = "#ef4444"; 
                    let icon = speed > 0 ? `<i class="fa-solid fa-truck-fast text-success me-1 fs-6"></i>` : `<i class="fa-solid fa-truck text-secondary me-1 fs-6"></i>`;
                    let timeColor = isStale ? 'text-danger' : 'text-primary';
                    
                    let geoKey = `${pos.y.toFixed(4)}_${pos.x.toFixed(4)}`;
                    let zonaGeo = (uData && uData.zonaOficial) ? uData.zonaOficial : resolverGeocerca(pos.y, pos.x);
                    let addrText = `<i class="fa-solid fa-spinner fa-spin text-muted"></i> Buscando...`;
                    if(geocodeCache[geoKey]) addrText = `<i class="fa-solid fa-map-location-dot text-primary me-1"></i>${geocodeCache[geoKey]}`;
                    
                    let geoHtml = zonaGeo ? `<span class="badge-geo text-truncate ms-2" style="max-width:150px;" title="${zonaGeo}"><i class="fa-solid fa-draw-polygon me-1"></i>${zonaGeo}</span>` : '';
                    let timeHover = formatTimeFriendly(pos.t);
                    
                    elGpsCell.innerHTML = `
                        <div class="d-flex flex-column px-1 w-100">
                            <div class="d-flex justify-content-between align-items-center border-bottom border-light pb-1 mb-1">
                                <div class="d-flex align-items-center">
                                    ${icon} <span class="speed-badge m-0" style="background-color:${speedBg}; padding:2px 6px;">${speed} km/h</span>
                                    ${geoHtml}
                                </div>
                                <div style="font-size:0.75rem; font-weight:900; cursor:help;" title="${timeHover}">
                                    <span class="${timeColor}">(${timeAgo(pos.t)})</span>
                                </div>
                            </div>
                            <div class="d-flex align-items-center w-100">
                                <a href="https://maps.google.com/?q=${pos.y},${pos.x}" target="_blank" class="addr-link text-start flex-grow-1" title="Abrir en Maps">
                                    <div class="addr-container addr-span-${geoKey}" id="addr_${vId}">${addrText}</div>
                                </a>
                            </div>
                        </div>
                    `;
                }
            }

            let btnName = document.getElementById("name_btn_" + vId);
            if (btnName && pos && typeof pos.y !== 'undefined') {
                btnName.setAttribute("onclick", `centrarUnidadMapa(${pos.y}, ${pos.x}, '${vId}')`);
            } else if (btnName) {
                btnName.setAttribute("onclick", `centrarUnidadMapa(null, null)`);
            }

            let wialonDriverObj = uData ? uData.choferObj : null;
            let elOpWialon = document.getElementById("op_wialon_" + vId);
            if (elOpWialon) {
                if (wialonDriverObj && wialonDriverObj.nombre !== "Sin asignar") {
                    let telRaw = wialonDriverObj.tel || ""; let cleanTel = String(telRaw).replace(/\D/g,'');
                    elOpWialon.innerHTML = `<div class="fw-bold text-truncate text-uppercase" style="font-size:0.75rem; color:#0f172a;"><i class="fa-solid fa-id-card text-muted me-1"></i>${wialonDriverObj.nombre}</div><div class="fw-bold text-muted user-select-all mt-1" style="font-size:0.7rem;">${telRaw}</div>`;
                } else if (v.operador) {
                    elOpWialon.innerHTML = `<div class="fw-bold text-truncate text-uppercase" style="font-size:0.75rem; color:#0f172a;"><i class="fa-solid fa-id-card text-muted me-1"></i>${v.operador}</div><div style="font-size:0.6rem; color:#64748b;">(Manual)</div>`;
                } else { 
                    elOpWialon.innerHTML = '<span class="badge bg-secondary w-100 mt-1" style="font-size:0.65rem;">Sin asignar</span>'; 
                }
            }
            
            let elAlertas = document.getElementById("alertas_" + vId);
            if (elAlertas) { elAlertas.innerHTML = v.alerta ? `<span class="text-danger fw-bold" style="font-size:0.85rem;">${v.alerta.txt}</span>` : `<span class="text-success fw-bold" style="font-size:0.85rem;">OK</span>`; }

        } catch(e) { console.error("Error GPS:", vId, e); }
    });
    desencadenarGeocoding();
}

function desencadenarGeocoding() {
    Object.keys(viajesActivos).forEach(vId => {
        let v = viajesActivos[vId]; if(typeof v !== 'object' || !v) return; let uData = encontrarUnidad(v, vId); 
        
        let destinosArr = v.destino ? String(v.destino).split(/,|\n/).map(d=>d.trim()).filter(d=>d!=="") : [];
        let targetDest = destinosArr[v.destino_idx || 0] || v.destino;

        if(uData && uData.pos) {
            let zonaGeo = (uData && uData.zonaOficial) ? uData.zonaOficial : resolverGeocerca(uData.pos.y, uData.pos.x);
            let geoKey = `${uData.pos.y.toFixed(4)}_${uData.pos.x.toFixed(4)}`;
            if(!geocodeCache[geoKey] && !geoQueue.find(i => i.key === geoKey)) { geoQueue.push({ key: geoKey, y: uData.pos.y, x: uData.pos.x, vId: vId, dest: targetDest }); } 
        }
    });
}

function procesarFilaDirecciones() {
    if(isGeocoding || geoQueue.length === 0) return; isGeocoding = true; let item = geoQueue.shift();
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${item.y}&lon=${item.x}&zoom=16`).then(r => r.json()).then(d => {
        let a = d.display_name || "Sin dirección"; geocodeCache[item.key] = a; localStorage.setItem('tms_geoCache', JSON.stringify(geocodeCache));
        document.querySelectorAll(`.addr-span-${item.key}`).forEach(span => span.innerHTML = `<i class="fa-solid fa-map-location-dot text-primary me-1"></i>${a}`);
    }).catch(e => console.log("Geo Err")).finally(() => { isGeocoding = false; });
}

















