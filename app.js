// ============================================================================
// PARTE 1: CONFIGURACIÓN, VARIABLES GLOBALES, UTILIDADES Y MAPA
// ============================================================================

const firebaseConfig = { databaseURL: "https://monitoreo-logistica-default-rtdb.firebaseio.com/" };
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// --- NOTIFICACIONES DEL SISTEMA ---
function mostrarNotificacion(msg) {
    document.getElementById('sysToastBody').innerText = msg;
    new bootstrap.Toast(document.getElementById('sysToast')).show();
}

// --- CONTROL DE PARPADEOS EN UI Y FIX DE MENÚS ENCIMADOS ---
let UI_PAUSED = false;

document.addEventListener('show.bs.dropdown', (e) => { 
    UI_PAUSED = true; 
    let tr = e.target.closest('tr');
    if(tr) tr.classList.add('dropdown-active'); // Eleva la fila por encima de las demás
});

document.addEventListener('hide.bs.dropdown', (e) => { 
    UI_PAUSED = false; 
    let tr = e.target.closest('tr');
    if(tr) tr.classList.remove('dropdown-active'); // Regresa la fila a la normalidad
    setTimeout(renderizarBitacora, 200); 
});

document.addEventListener('focusin', (e) => { if(['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) UI_PAUSED = true; });
document.addEventListener('focusout', (e) => { if(['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) { UI_PAUSED = false; setTimeout(renderizarBitacora, 200); } });

// --- VARIABLES GLOBALES ---
let currentUser = null;
let configSistema = { tokens: [] };
let dataClientes = {};
let viajesActivos = {};
let unidadesGlobales = {};
let diccChoferesGlobal = {}; 
let ramDrivers = {};
let dbOperadores = {};
let geocercasNativas = [];
let activeSIDs = {};
let pollingInterval = null;
let lmap = null;
let mapVisible = false;
let mapLayerGroup = null;
let geofenceLayerGroup = null;
let estadoTokens = {};
let datosAgrupadosGlobal = {}; 
let mapaMarcadores = {}; 
let salidasPendientes = {}; 
let finalizacionesPendientes = {}; 
let arribosPendientes = {}; 

// NUEVO: VARIABLES PARA LOS HUBS DE AUDITORÍA
let alertasSeguridad = {}; 
let alertasLogistica = {};

let geocodeCache = JSON.parse(localStorage.getItem('tms_geoCache')) || {}; 
let geoQueue = []; 
let isGeocoding = false; 
let motorArrancado = false; 
let isSyncingFlotas = false;
let currentCaptureBlob = null; 

let edChipsArray = [];
let edChipsContArray = []; 

// ORDENAMIENTO MANUAL CON MEMORIA
let savedSort = JSON.parse(localStorage.getItem('tms_sortState'));
let sortState = savedSort || { column: 'estatus', direction: 'asc' }; // Por defecto Estatus

function cambiarOrden(col) {
    if (sortState.column === col) {
        sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        sortState.column = col;
        sortState.direction = 'asc';
    }
    localStorage.setItem('tms_sortState', JSON.stringify(sortState));
    renderizarBitacora();
}

// --- PRIORIDADES ESTRICTAS DE COLUMNAS ---
const columnasDef = {
    'col-unidad': { titulo: 'UNIDAD <i class="fa-solid fa-sort sort-icon" title="Ordenar por Unidad" onclick="cambiarOrden(\'unidad\')"></i>', ancho: '140' },
    'col-operador': { titulo: 'OPERADOR GPS', ancho: '150' },
    'col-ruta': { titulo: 'RUTA (O ➔ D) <i class="fa-solid fa-sort sort-icon" title="Ordenar por Origen" onclick="cambiarOrden(\'ruta\')"></i>', ancho: '190' },
    'col-horarios': { titulo: 'HORARIOS', ancho: '95' }, 
    'col-estatus': { titulo: 'ESTATUS <i class="fa-solid fa-sort sort-icon" title="Ordenar por Estatus" onclick="cambiarOrden(\'estatus\')"></i>', ancho: '120' },
    'col-gps': { titulo: 'UBICACIÓN Y GEOCERCA', ancho: '420' }, 
    'col-alertas': { titulo: 'ALERTAS', ancho: '90' },
    'col-historial': { titulo: 'HISTORIAL LOG', ancho: '240' }, 
    'col-accion': { titulo: '<i class="fa-solid fa-bars"></i>', ancho: '65' }
};

// FIX PANTALLA BLANCA: Auto-Reparación de Columnas si el localStorage falla o es versión vieja
let colOrder = JSON.parse(localStorage.getItem('tms_colOrder'));
if (!colOrder || !Array.isArray(colOrder) || colOrder.length !== Object.keys(columnasDef).length || colOrder.some(c => !columnasDef[c])) {
    colOrder = Object.keys(columnasDef);
    localStorage.setItem('tms_colOrder', JSON.stringify(colOrder));
}

let hiddenCols = JSON.parse(localStorage.getItem('tms_hiddenCols')) || { 
    'col-alertas': false, 
    'col-historial': false 
};

window.estatusData = { 
    "s0":{nombre:"0. SIN ESTATUS",col:"#94a3b8"}, 
    "s1":{nombre:"1. Ruta",col:"#10b981"}, 
    "s2":{nombre:"1.1 PARADO",col:"#ef4444"}, 
    "s3":{nombre:"1.2 RETEN",col:"#d97706"}, 
    "s4":{nombre:"1.3 Resguardo",col:"#8b5cf6"}, 
    "s5":{nombre:"1.4 REGRESANDO",col:"#f59e0b"}, 
    "s6":{nombre:"2. Incidencia",col:"#be123c"}, 
    "s7":{nombre:"3. Cargando",col:"#64748b"}, 
    "s8":{nombre:"4. Descargando",col:"#0284c7"}, 
    "s9":{nombre:"5. Patio GDL",col:"#06b6d4"}, 
    "s10":{nombre:"6. Patio Reynosa",col:"#14b8a6"}, 
    "s11":{nombre:"7. Taller",col:"#94a3b8"}, 
    "s12":{nombre:"8. Finalizado",col:"#1e40af"}, 
    "s13":{nombre:"9. Baja cobertura",col:"#fbbf24"}, 
    "s14":{nombre:"ALIMENTOS",col:"#f59e0b"} 
};

// --- FUNCIONES MATEMÁTICAS Y LIMPIEZA ---
function limpiarStr(str) {
    if(!str) return "";
    return String(str).trim().replace(/\s+/g, ' ').toUpperCase();
}

function escapeSafe(str) { 
    return str ? String(str).replace(/'/g, "\\'") : ""; 
}

function hexToRgba(hex, alpha) {
    if(!hex || hex.length !== 7) return `rgba(15, 23, 42, ${alpha})`;
    let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function encontrarUnidad(v, vId) {
    if(!v) return null;
    if(v.wialonId && v.wialonId !== "EXTERNO" && unidadesGlobales[v.wialonId]) return unidadesGlobales[v.wialonId];
    let n = limpiarStr(v.unidadN || v.unidadFallback);
    let norm = n.replace(/[\s\-]/g, "");
    for(let k in unidadesGlobales) {
        let uName = limpiarStr(unidadesGlobales[k].name);
        if(uName === n || uName.replace(/[\s\-]/g, "") === norm) return unidadesGlobales[k];
    }
    if(unidadesGlobales[vId]) return unidadesGlobales[vId];
    return null; 
}

function isInsidePolygon(point, vs) {
    let x = point[0], y = point[1], inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y;
        let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; 
    const dLat = (lat2-lat1)*Math.PI/180; 
    const dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function resolverGeocerca(lat, lon) {
    if(!geocercasNativas || geocercasNativas.length === 0) return null;
    for(let z of geocercasNativas) {
        if(!z.p) continue;
        if(z.t === 3) { 
            let r = z.p[0].r || 50; 
            if(getDistanceMeters(lat, lon, z.p[0].y, z.p[0].x) <= r) return limpiarStr(z.n); 
        } else { 
            if(isInsidePolygon([lon, lat], z.p)) return limpiarStr(z.n); 
        }
    }
    return null;
}

function formatearFechaElegante(ms) {
    if (!ms) return "--:--"; 
    let d = new Date(ms); 
    let meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    return `${String(d.getDate()).padStart(2, '0')} ${meses[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatTimeFriendly(unixMillis) { 
    if(!unixMillis) return "--:--"; 
    let d = new Date(unixMillis); 
    let today = new Date();
    let timeStr = d.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'});
    if(d.toDateString() === today.toDateString()) return timeStr;
    return d.toLocaleDateString('es-MX', {day:'2-digit', month:'short'}) + " " + timeStr; 
}

function formatTimeDiff(mins) {
    let m = Math.abs(mins);
    let d = Math.floor(m / 1440); 
    let h = Math.floor((m % 1440) / 60); 
    let remM = m % 60;
    let str = []; 
    if(d > 0) str.push(`${d}d`); 
    if(h > 0) str.push(`${h}h`); 
    if(remM > 0 || str.length === 0) str.push(`${remM}m`);
    return str.join(' ');
}

function getLocalISO(unixMillis) {
    if(!unixMillis) return ""; 
    let tzoffset = (new Date()).getTimezoneOffset() * 60000;
    return (new Date(unixMillis - tzoffset)).toISOString().slice(0, 16);
}

function timeAgo(unixSecs) {
    if(!unixSecs) return "N/A"; 
    let diff = Math.floor(Date.now()/1000) - unixSecs;
    if(diff < 60) return `${diff}s`; 
    if(diff < 3600) return `${Math.floor(diff/60)}m`;
    if(diff < 86400) return `${Math.floor(diff/3600)}h`;
    let d = Math.floor(diff/86400); 
    let h = Math.floor((diff%86400)/3600);
    return `${d}d ${h}h`;
}

// --- MENÚ ORDENAMIENTO Y VISIBILIDAD DE COLUMNAS ---
function inicializarMenuColumnas() {
    let menuHtml = '';
    colOrder.forEach((k, index) => {
        let checked = !hiddenCols[k] ? 'checked' : '';
        let btnUp = index > 0 
            ? `<i class="fa-solid fa-arrow-up mx-1 text-primary cp fs-6" title="Mover Izquierda" onclick="moverColumna(${index}, -1)"></i>` 
            : `<i class="fa-solid fa-arrow-up mx-1 text-muted fs-6" style="opacity:0.2"></i>`;
        let btnDown = index < colOrder.length - 1 
            ? `<i class="fa-solid fa-arrow-down mx-1 text-primary cp fs-6" title="Mover Derecha" onclick="moverColumna(${index}, 1)"></i>` 
            : `<i class="fa-solid fa-arrow-down mx-1 text-muted fs-6" style="opacity:0.2"></i>`;
        
        let tituloLimpio = columnasDef[k].titulo.replace(/<[^>]*>?/gm, ''); 

        menuHtml += `
            <li class="dropdown-item d-flex justify-content-between align-items-center py-1 px-3 border-bottom">
                <label class="cp mb-0 flex-grow-1">
                    <input type="checkbox" class="form-check-input me-2" onchange="toggleCol('${k}', this.checked)" ${checked}> 
                    <span style="font-size:0.7rem; font-weight:bold;">${tituloLimpio}</span>
                </label>
                <div class="d-flex bg-white rounded border px-2 py-1 shadow-sm">${btnUp}${btnDown}</div>
            </li>`;
    });
    document.getElementById('column-toggles').innerHTML = menuHtml;
    Object.keys(hiddenCols).forEach(k => toggleCol(k, !hiddenCols[k], false));
}

function moverColumna(idx, dir) {
    if(idx + dir < 0 || idx + dir >= colOrder.length) return;
    let temp = colOrder[idx]; 
    colOrder[idx] = colOrder[idx + dir]; 
    colOrder[idx + dir] = temp;
    localStorage.setItem('tms_colOrder', JSON.stringify(colOrder));
    inicializarMenuColumnas(); 
    renderizarBitacora();
}

function toggleCol(colClass, isVisible, save = true) {
    if(save) { 
        hiddenCols[colClass] = !isVisible; 
        localStorage.setItem('tms_hiddenCols', JSON.stringify(hiddenCols)); 
    }
    document.querySelectorAll('.' + colClass).forEach(el => { 
        if(isVisible) el.classList.remove('d-none'); 
        else el.classList.add('d-none'); 
    });
}

function resetColumnas() {
    localStorage.removeItem('tms_colOrder'); 
    localStorage.removeItem('tms_hiddenCols'); 
    localStorage.removeItem('tms_colWidths'); 
    location.reload();
}

// --- RESIZER EN VIVO ---
function aplicarAnchosGuardados() {
    let savedWidths = JSON.parse(localStorage.getItem('tms_colWidths')) || {};
    let css = '';
    Object.keys(columnasDef).forEach(c => {
        let w = savedWidths[c] || columnasDef[c].ancho;
        css += `.${c} { width: ${w}px !important; min-width: ${w}px !important; max-width: ${w}px !important; }\n`;
    });
    let styleEl = document.getElementById('dynamic-col-styles');
    if(!styleEl) { 
        styleEl = document.createElement('style'); 
        styleEl.id = 'dynamic-col-styles'; 
        document.head.appendChild(styleEl); 
    }
    styleEl.innerHTML = css;
}

let isResizing = false; let currentTh = null; let startX = 0; let startWidth = 0;

document.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('resizer')) {
        isResizing = true; 
        currentTh = e.target.parentElement; 
        startX = e.pageX; 
        startWidth = currentTh.offsetWidth;
        e.target.classList.add('resizing'); 
        document.body.style.userSelect = 'none';
    }
});

document.addEventListener('mousemove', function(e) {
    if (isResizing && currentTh) {
        let newWidth = Math.max(50, startWidth + (e.pageX - startX));
        let colClass = Array.from(currentTh.classList).find(c => c.startsWith('col-'));
        if(colClass) {
            let liveStyle = document.getElementById('live-resize-style');
            if(!liveStyle) { 
                liveStyle = document.createElement('style'); 
                liveStyle.id = 'live-resize-style'; 
                document.head.appendChild(liveStyle); 
            }
            liveStyle.innerHTML = `.${colClass} { width: ${newWidth}px !important; min-width: ${newWidth}px !important; max-width: ${newWidth}px !important; }`;
        }
    }
});

document.addEventListener('mouseup', function(e) {
    if (isResizing) {
        isResizing = false; 
        let colClass = Array.from(currentTh.classList).find(c => c.startsWith('col-'));
        if (colClass) {
            let savedWidths = JSON.parse(localStorage.getItem('tms_colWidths')) || {};
            savedWidths[colClass] = currentTh.offsetWidth; 
            localStorage.setItem('tms_colWidths', JSON.stringify(savedWidths));
            aplicarAnchosGuardados();
            let liveStyle = document.getElementById('live-resize-style'); 
            if(liveStyle) liveStyle.innerHTML = '';
        }
        document.querySelectorAll('.resizer').forEach(r => r.classList.remove('resizing'));
        currentTh = null; 
        document.body.style.userSelect = '';
    }
});

function getHeadersRow(cId) {
    let html = `<tr class="header-columnas shadow-sm client-group-${cId}">`;
    colOrder.forEach((c) => {
        let titulo = columnasDef[c].titulo; 
        let display = hiddenCols[c] ? 'd-none' : ''; 
        
        let tituloModificado = titulo;
        if(c === 'col-unidad' && sortState.column === 'unidad') tituloModificado = titulo.replace('sort-icon', 'sort-icon active');
        if(c === 'col-ruta' && sortState.column === 'ruta') tituloModificado = titulo.replace('sort-icon', 'sort-icon active');
        if(c === 'col-estatus' && sortState.column === 'estatus') tituloModificado = titulo.replace('sort-icon', 'sort-icon active');

        html += `
            <th class="${c} ${display} position-relative">
                <div class="d-flex justify-content-center align-items-center h-100 px-1"><span class="text-center">${tituloModificado}</span></div>
                <div class="resizer" title="Arrastrar para cambiar tamaño"></div>
            </th>`;
    });
    return html + `</tr>`;
}

// --- MAPA FLUIDO Y MARCADORES CON POPUP ---
function initMap() { 
    lmap = L.map('map').setView([23.6, -102.5], 5); 
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(lmap); 
    mapLayerGroup = L.layerGroup().addTo(lmap); 
    geofenceLayerGroup = L.layerGroup().addTo(lmap);
}

function toggleMap() { 
    document.getElementById("mainWorkspace").classList.toggle("show-map"); 
    if(!lmap) initMap(); 
    mapVisible = !mapVisible; 
    setTimeout(() => { 
        if(lmap) { 
            lmap.invalidateSize(); 
            actualizarMarcadoresMapa(); 
            pintarGeocercasEnMapa(); 
        } 
    }, 400); 
}

window.clickMapaUnidad = function(vId) {
    let v = viajesActivos[vId]; 
    if(!v) return alert("Unidad no encontrada.");
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
        let v = viajesActivos[vId]; 
        if(typeof v !== 'object' || !v) return;
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
            let operador = v.operador || (uData.choferObj && uData.choferObj.nombre !== "Sin asignar" ? uData.choferObj.nombre : "Sin Operador");

            let hoverText = isMoving ? `En movimiento a ${vel} km/h (hace ${timeAgo(uData.pos.t)})` : `Unidad detenida (hace ${timeAgo(uData.pos.t)})`;

            let popupContent = `
                <div style="text-align:center; min-width: 160px; font-family: 'Inter', sans-serif;">
                    <b style="font-size:15px; color:#0f172a; text-transform:uppercase;">${escapeSafe(uData.name)}</b><br>
                    <span style="font-size:11px; color:#64748b; font-weight:bold;">${escapeSafe(operador)}</span><br>
                    <div style="margin-top:5px; margin-bottom:5px; background:${isMoving?'#10b981':'#64748b'}; color:white; border-radius:4px; padding:2px; font-weight:bold; font-size:12px;">${vel} km/h</div>
                    <b style="font-size:11px; color:#0284c7;">${est}</b><br>
                    <span style="color:#94a3b8; font-size:10px;">Act: hace ${timeAgo(uData.pos.t)}</span>
                </div>
            `;
            let marker = L.marker([uData.pos.y, uData.pos.x], {icon: customIcon})
                          .bindTooltip(hoverText, {direction: 'top', className: 'fw-bold'})
                          .bindPopup(popupContent, {className: 'custom-popup'})
                          .addTo(mapLayerGroup);
            mapaMarcadores[vId] = marker;
        }
    });
}

function pintarGeocercasEnMapa() {
    if(!lmap || !geofenceLayerGroup) return; 
    geofenceLayerGroup.clearLayers();
    
    let geocercasActivas = {};
    
    Object.values(viajesActivos).forEach(v => {
        if(typeof v !== 'object' || !v) return;
        if(v.origen) geocercasActivas[limpiarStr(v.origen)] = "origen";
        let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []);
        arrDests.forEach(d => geocercasActivas[d] = "destino");
    });

    geocercasNativas.forEach(z => {
        let uName = limpiarStr(z.n);
        if(geocercasActivas[uName]) {
            let isOrigen = geocercasActivas[uName] === "origen";
            let colorHex = isOrigen ? '#15803d' : '#b91c1c';
            let txtLabel = isOrigen ? `📍 ORIGEN: ${z.n}` : `🏁 DESTINO: ${z.n}`;
            let cssClass = isOrigen ? 'geocerca-tooltip origen' : 'geocerca-tooltip destino';
            
            let shape;
            if(z.t === 3 && z.p && z.p[0]) {
                shape = L.circle([z.p[0].y, z.p[0].x], {radius: z.p[0].r, color: colorHex, weight: 3, fillOpacity: 0.2});
            } else if((z.t === 1 || z.t === 2) && z.p) {
                shape = L.polygon(z.p.map(pt => [pt.y, pt.x]), {color: colorHex, weight: 3, fillOpacity: 0.2});
            }
            if(shape) {
                shape.bindTooltip(txtLabel, { permanent: true, direction: 'top', className: cssClass }).addTo(geofenceLayerGroup);
            }
        }
    });
}
// ============================================================================
// PARTE 2: HUBS DE AUDITORÍA, ACCIONES SECUNDARIAS, WHATSAPP Y CAPTURAS
// ============================================================================

// --- SISTEMA CENTRALIZADO DE NOTIFICACIONES Y AUDITORÍA ---
db.ref('notificaciones_pendientes').on('value', snap => { 
    let data = snap.val() || {};  
    alertasSeguridad = {};  
    alertasLogistica = {};
    
    Object.keys(data).forEach(k => { 
        let notif = data[k]; 
        notif.id = k; 
        // Clasificamos si es Logística o Seguridad
        if (['SALIDA', 'ARRIBO', 'FINALIZACION'].includes(notif.tipo)) {
            alertasLogistica[k] = notif; 
        } else {
            alertasSeguridad[k] = notif; 
        }
    });
    actualizarBotonesHubs();
});

function enviarNotificacionPersistente(vId, unidadName, tipo, detalle) {
    let idLogico = vId + "_" + tipo; 
    db.ref('notificaciones_pendientes/' + idLogico).once('value', snap => { 
        if(!snap.exists()) { 
            db.ref('notificaciones_pendientes/' + idLogico).set({ 
                vId: vId, unidad: unidadName, tipo: tipo, detalle: detalle, t_evento: Date.now() 
            }); 
        } 
    });
}

// --- LIMPIEZA FORZADA DE PANTALLA GRIS (BUG FIX) ---
window.cerrarModalLimpio = function(modalId) {
    let el = document.getElementById(modalId);
    if(el) {
        let m = bootstrap.Modal.getInstance(el);
        if(m) m.hide();
    }
    // Forzamos al navegador a borrar cualquier fondo gris que se haya quedado atascado
    setTimeout(() => {
        if (!document.querySelector('.modal.show')) {
            document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
            document.body.classList.remove('modal-open');
            document.body.style.overflow = '';
            document.body.style.paddingRight = '';
        }
    }, 300);
};

function actualizarBotonesHubs() {
    let cSeg = Object.keys(alertasSeguridad).length; 
    let cLog = Object.keys(alertasLogistica).length;
    
    let bSeg = document.getElementById("btnHubSeguridad"); 
    let lSeg = document.getElementById("lblCountSeguridad");
    if(bSeg && lSeg) { 
        if(cSeg > 0) { 
            lSeg.innerText = cSeg; 
            bSeg.classList.remove("d-none"); 
        } else { 
            bSeg.classList.add("d-none"); 
            cerrarModalLimpio('modalHubSeguridad'); 
        } 
    }
    
    let bLog = document.getElementById("btnHubLogistico"); 
    let lLog = document.getElementById("lblCountLogistico");
    if(bLog && lLog) { 
        if(cLog > 0) { 
            lLog.innerText = cLog; 
            bLog.classList.remove("d-none"); 
        } else { 
            bLog.classList.add("d-none"); 
            cerrarModalLimpio('modalHubLogistico'); 
        } 
    }
}

window.abrirHubSeguridad = function() {
    let container = document.getElementById("listaHubSeguridad"); 
    container.innerHTML = "";
    let count = Object.keys(alertasSeguridad).length; 
    if (count === 0) {
        cerrarModalLimpio('modalHubSeguridad');
        return;
    }
    
    Object.values(alertasSeguridad).forEach(n => {
        let icon = n.tipo === "PARADA" ? "fa-stop text-danger" : (n.tipo === "REANUDACION" ? "fa-play text-success" : "fa-triangle-exclamation text-warning");
        let colorClass = n.tipo === "PARADA" ? "border-danger" : (n.tipo === "REANUDACION" ? "border-success" : "border-warning");
        
        container.innerHTML += `
        <div class="bg-white p-3 rounded shadow-sm border ${colorClass} mb-3">
            <div class="d-flex justify-content-between align-items-start mb-2">
                <div>
                    <div class="fw-bold text-dark" style="font-size:0.95rem;"><i class="fa-solid ${icon} me-1"></i> ${n.unidad}</div>
                    <div class="text-muted" style="font-size:0.8rem;">${n.detalle} (Hora Sensor: ${formatTimeFriendly(n.t_evento)})</div>
                </div>
            </div>
            <textarea id="nota_hub_${n.id}" class="form-control border-secondary mb-2" rows="2" placeholder="Justificación (Obligatoria para paradas)..."></textarea>
            <div class="d-flex gap-2 justify-content-end">
                <button class="btn btn-sm btn-outline-danger fw-bold px-3" onclick="rechazarNotificacion('${n.id}', true)"><i class="fa-solid fa-xmark"></i> Falsa Alarma</button>
                <button class="btn btn-sm btn-success fw-bold px-3" onclick="confirmarNotificacion('${n.id}', true)"><i class="fa-solid fa-check"></i> Confirmar y Guardar</button>
            </div>
        </div>`;
    }); 
    
    let modalEl = document.getElementById('modalHubSeguridad');
    let modalInst = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
    modalInst.show();
};

window.abrirHubLogistico = function() {
    let container = document.getElementById("listaHubLogistico"); 
    container.innerHTML = "";
    let count = Object.keys(alertasLogistica).length; 
    if (count === 0) {
        cerrarModalLimpio('modalHubLogistico');
        return;
    }
    
    Object.values(alertasLogistica).forEach(n => {
        let icon = n.tipo === "SALIDA" ? "fa-rocket text-primary" : (n.tipo === "ARRIBO" ? "fa-map-pin text-success" : "fa-flag-checkered text-dark"); 
        let borderClass = n.tipo === "SALIDA" ? "border-primary" : (n.tipo === "ARRIBO" ? "border-success" : "border-dark");
        
        container.innerHTML += `
        <div class="bg-white p-3 rounded shadow-sm border ${borderClass} mb-3">
            <div class="d-flex justify-content-between align-items-start mb-2">
                <div>
                    <div class="fw-bold text-dark" style="font-size:0.95rem;"><i class="fa-solid ${icon} me-1"></i> ${n.unidad}</div>
                    <div class="text-muted" style="font-size:0.8rem;">${n.detalle} (Hora Sensor: ${formatTimeFriendly(n.t_evento)})</div>
                </div>
            </div>
            <textarea id="nota_hub_${n.id}" class="form-control border-secondary mb-2" rows="1" placeholder="Comentario opcional (Ej. Sello de caja)..."></textarea>
            <div class="d-flex gap-2 justify-content-end">
                <button class="btn btn-sm btn-outline-danger fw-bold px-3" onclick="rechazarNotificacion('${n.id}', false)"><i class="fa-solid fa-xmark"></i> Descartar</button>
                <button class="btn btn-sm btn-success fw-bold px-3" onclick="confirmarNotificacion('${n.id}', false)"><i class="fa-solid fa-check"></i> Confirmar Evento</button>
            </div>
        </div>`;
    }); 
    
    let modalEl = document.getElementById('modalHubLogistico');
    let modalInst = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
    modalInst.show();
};

function confirmarNotificacion(id, isSeguridad) {
    UI_PAUSED = false;
    let n = isSeguridad ? alertasSeguridad[id] : alertasLogistica[id]; 
    if(!n) return;
    
    let inputEl = document.getElementById('nota_hub_' + id); 
    let nota = inputEl ? inputEl.value.trim() : "";
    
    if(isSeguridad && n.tipo === "PARADA" && !nota) {
        return alert("⚠️ Por protocolo de auditoría, debes escribir una justificación obligatoria para la parada.");
    }
    
    let vId = n.vId; 
    let defaultAct = "";
    
    if (n.tipo === "SALIDA") defaultAct = 'Confirmó SALIDA';
    else if (n.tipo === "ARRIBO") defaultAct = 'Confirmó ARRIBO';
    else if (n.tipo === "FINALIZACION") defaultAct = 'Confirmó FINALIZADO';
    else if (n.tipo === "PARADA") defaultAct = 'Justificó PARADA';
    else if (n.tipo === "REANUDACION") defaultAct = 'Confirmó REANUDACIÓN';
    else if (n.tipo === "DESCONEXION") defaultAct = 'Confirmó ALERTA CONEXIÓN';
    
    let finalAct = nota ? `🗣️ ${nota}` : defaultAct;
    let finalDet = nota ? `${defaultAct} (Auto: ${n.detalle})` : `${n.detalle}`;
    
    if (n.tipo === "SALIDA") db.ref('viajes_activos/'+vId).update({ t_salida: n.t_evento, estatus: 's1' }); 
    else if (n.tipo === "ARRIBO") db.ref('viajes_activos/'+vId).update({ t_arribo: n.t_evento, estatus: 's8' }); 
    else if (n.tipo === "FINALIZACION") db.ref('viajes_activos/'+vId).update({ t_fin: n.t_evento, estatus: 's12' }); 
    else if (n.tipo === "PARADA") db.ref('viajes_activos/'+vId).update({ estatus: 's2', alerta_detenida: null });
    else if (n.tipo === "REANUDACION") db.ref('viajes_activos/'+vId).update({ estatus: 's1', alerta_detenida: null }); 
    
    registrarLog(vId, finalAct, finalDet); 
    
    db.ref('notificaciones_pendientes/' + id).remove(); 
    mostrarNotificacion("✅ Evento guardado y auditado."); 
    
    if(isSeguridad) setTimeout(abrirHubSeguridad, 100); 
    else setTimeout(abrirHubLogistico, 100);
}

function rechazarNotificacion(id, isSeguridad) {
    UI_PAUSED = false;
    let n = isSeguridad ? alertasSeguridad[id] : alertasLogistica[id]; 
    if(!n) return;
    
    let inputEl = document.getElementById('nota_hub_' + id); 
    let nota = inputEl ? inputEl.value.trim() : ""; 
    
    let finalAct = nota ? `🗣️ ${nota}` : `Canceló Alerta`;
    let finalDet = nota ? `Descartó alerta de ${n.tipo}` : `Falsa alarma de ${n.tipo}`;
    
    if (n.tipo === "PARADA" || n.tipo === "REANUDACION") {
        db.ref('viajes_activos/'+n.vId+'/alerta_detenida').set(null);
    }

    registrarLog(n.vId, finalAct, finalDet); 
    db.ref('notificaciones_pendientes/' + id).remove(); 
    mostrarNotificacion("🚫 Evento descartado."); 
    
    if(isSeguridad) setTimeout(abrirHubSeguridad, 100); 
    else setTimeout(abrirHubLogistico, 100);
}

window.abrirHistorialHubs = function() {
    let container = document.getElementById("listaHistorialGlobal");
    container.innerHTML = '<div class="text-center p-4"><i class="fa-solid fa-spinner fa-spin fs-3 text-secondary"></i> Buscando registros...</div>';

    // Ocultar los otros modales sin trabar la pantalla
    cerrarModalLimpio('modalHubSeguridad');
    cerrarModalLimpio('modalHubLogistico');

    let allLogs = [];
    Object.values(viajesActivos).forEach(v => {
        let uName = limpiarStr(v.unidadN || v.unidadFallback);
        if (v.log) {
            Object.values(v.log).forEach(l => {
                if (l.act.includes("Confirmó") || l.act.includes("Justificó") || l.act.includes("Canceló") || l.act.includes("Descartó") || l.act.includes("🗣️")) {
                    allLogs.push({ ...l, unidad: uName });
                }
            });
        }
    });

    allLogs.sort((a, b) => b.t - a.t);
    let topLogs = allLogs.slice(0, 100);

    if (topLogs.length === 0) {
        container.innerHTML = '<div class="text-muted text-center fw-bold p-4"><i class="fa-solid fa-folder-open fs-3 mb-2"></i><br>Aún no hay registros de auditoría procesados hoy.</div>';
    } else {
        let html = topLogs.map(l => {
            let logAct = String(l.act);
            let logDet = String(l.det || '');
            let notaMonitorista = "";
            
            if(logAct.includes("🗣️")) {
                notaMonitorista = logAct;
                logAct = logDet.split(" (Auto:")[0] || logAct;
                logDet = logDet.includes("(Auto:") ? logDet.split("(Auto:")[1].replace(")", "").trim() : logDet;
            } else if (logDet.includes("| Nota C4:")) {
                let pts = logDet.split("| Nota C4:");
                notaMonitorista = "🗣️ " + pts[1].trim();
                logDet = pts[0].trim();
            } else if (logDet.includes("| Nota:")) {
                let pts = logDet.split("| Nota:");
                notaMonitorista = "🗣️ " + pts[1].trim();
                logDet = pts[0].trim();
            }

            let colorBorder = (logAct.includes("Canceló") || logAct.includes("Descartó")) ? "border-danger" : "border-success";
            let icon = (logAct.includes("Canceló") || logAct.includes("Descartó")) ? "fa-xmark text-danger" : "fa-check text-success";
            
            let htmlNota = notaMonitorista ? `<div class="fw-bold text-primary mb-1" style="font-size:0.85rem;">${notaMonitorista}</div>` : '';

            return `
            <div class="bg-white p-2 rounded shadow-sm border-start border-4 ${colorBorder} mb-2" style="font-size:0.8rem;">
                <div class="d-flex justify-content-between align-items-center border-bottom pb-1 mb-1">
                    <span class="fw-bold text-dark" style="font-size:0.85rem;"><i class="fa-solid fa-truck text-secondary me-1"></i> ${l.unidad}</span>
                    <span class="text-muted" style="font-size:0.7rem;"><i class="fa-regular fa-calendar text-primary"></i> ${formatearFechaElegante(l.t)}</span>
                </div>
                <div>
                    ${htmlNota}
                    <b class="text-secondary"><i class="fa-solid fa-user-shield"></i> ${l.usr}:</b> <span class="fw-bold"><i class="fa-solid ${icon}"></i> ${logAct}</span>
                    <div class="text-muted mt-1 fst-italic" style="background:#f8fafc; padding:4px; border-radius:4px; border:1px dashed #cbd5e1;">${logDet || 'Sin detalles'}</div>
                </div>
            </div>`;
        }).join('');
        container.innerHTML = html;
    }

    let modalEl = document.getElementById('modalHistorialHubs');
    let modalInst = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
    modalInst.show();
};


// --- ACCIONES SECUNDARIAS ---
function cambiarEstatus(val, vId) { 
    let v = viajesActivos[vId]; 
    if(!v) return;

    let uData = encontrarUnidad(v, vId);
    let isExternal = v.wialonId === "EXTERNO";
    let speed = (uData && uData.pos) ? uData.pos.s : 0;
    
    let txt = window.estatusData[val].nombre; 

    // LÓGICA DE VALIDACIÓN: Estatus vs Velocidad real del GPS
    if (!isExternal) {
        // Si intenta poner "1. Ruta" pero va a menos de 4 km/h (Está detenido)
        if (val === 's1' && speed < 4) {
            let confirmacion = confirm(`⚠️ ALERTA DE SISTEMA:\n\nIntentas cambiar el estatus a "${txt}", pero el GPS indica que la unidad está DETENIDA (${speed} km/h).\n\n¿Estás completamente seguro de forzar este cambio?`);
            if (!confirmacion) return; // Si le da a cancelar, se aborta la acción
        } 
        // Si intenta poner "1.1 PARADO" pero va a más de 4 km/h (Está en movimiento)
        else if (val === 's2' && speed >= 4) {
            let confirmacion = confirm(`⚠️ ALERTA DE SISTEMA:\n\nIntentas cambiar el estatus a "${txt}", pero el GPS indica que la unidad está EN MOVIMIENTO (${speed} km/h).\n\n¿Estás completamente seguro de forzar este cambio?`);
            if (!confirmacion) return; // Si le da a cancelar, se aborta la acción
        }
    }

    // Si pasó las validaciones o el monitorista forzó el cambio, se guarda
    registrarLog(vId, 'Cambió estatus a', txt); 
    db.ref('viajes_activos/'+vId+'/estatus').set(val); 
}

function editarUbicacionManual(vId) { 
    let v = viajesActivos[vId]; 
    if(!v) return; 
    let uName = limpiarStr(v.unidadN || v.unidadFallback); 
    let u = prompt(`Escribir ubicación o coordenadas (ej. 20.123, -100.456) para ${uName}:`, v.ubicacion_manual_raw || v.ubicacion_manual || ''); 
    if(u !== null && u.trim() !== '') { 
        let rawText = limpiarStr(u);
        let locText = rawText;
        let isCoords = /^[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?)[,\s]+[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/.test(rawText);
        if (isCoords) {
            let coords = rawText.replace(/\s/g, '');
            // Corrección universal para Google Maps
            locText = `<a href="https://www.google.com/maps?q=$${coords}" target="_blank" class="text-primary text-decoration-underline" title="Abrir en Maps"><i class="fa-solid fa-map-location-dot me-1"></i>${coords}</a>`;
        }
        db.ref(`viajes_activos/${vId}`).update({ ubicacion_manual: locText, ubicacion_manual_raw: rawText, t_ubicacion_manual: Date.now() });
        registrarLog(vId, 'Actualizó Ubicación', rawText); 
    } 
}

function registrarLog(viajeId, accion, detalle = "") { 
    let usrName = currentUser ? currentUser.nom : "Sistema"; 
    db.ref(`viajes_activos/${viajeId}/log`).push({ t: Date.now(), usr: usrName, act: accion, det: detalle }); 
}

function cerrarSesion() { localStorage.clear(); location.reload(); }

function finalizarViaje(vId, nombre) {
    if(confirm(`¿Estás seguro de archivar el viaje de la unidad ${nombre}?`)) {
        db.ref('viajes_activos/' + vId).once('value').then(snap => {
            let data = snap.val();
            if(data) {
                data.fecha_archivado = Date.now(); 
                db.ref('viajes_archivados/' + vId).set(data).then(() => {
                    db.ref('viajes_activos/' + vId).remove();
                    mostrarNotificacion(`Viaje de ${nombre} archivado exitosamente.`);
                });
            }
        }).catch(err => alert("Error al archivar: " + err.message));
    }
}

function abrirModalLog(uId, uName) { 
    document.getElementById("log_uid").value = uId; 
    document.getElementById("log_uName").innerText = uName; 
    document.getElementById("log_txt").value = ""; 
    
    let logsObj = viajesActivos[uId]?.log || {}; 
    let logsArr = Object.values(logsObj).sort((a,b)=>b.t - a.t); 
    let html = logsArr.map(l => `<div class="mb-2 border-bottom pb-1"><div style="font-size:0.65rem; color:#6c757d; font-weight:bold; margin-bottom:1px;"><i class="fa-regular fa-calendar text-primary"></i> ${formatearFechaElegante(l.t)}</div><b class="text-dark">${l.usr}:</b> <span class="text-primary">${l.act}</span> <span class="text-muted">${l.det||''}</span></div>`).join(''); 
    document.getElementById("log_container").innerHTML = html || '<div class="text-muted text-center p-2 mt-3">Sin eventos.</div>'; 
    new bootstrap.Modal(document.getElementById('modalLog')).show(); 
}

function guardarLogManual() { 
    let uId = document.getElementById("log_uid").value; 
    let txt = limpiarStr(document.getElementById("log_txt").value); 
    if(!txt) return; 
    
    registrarLog(uId, "Agregó Nota", txt); 
    let v = viajesActivos[uId]; 
    if (v && v.alerta_detenida) db.ref('viajes_activos/'+uId+'/alerta_detenida').set(null);
    try { bootstrap.Modal.getInstance(document.getElementById('modalLog')).hide(); } catch(e){} 
    mostrarNotificacion("Nota guardada en el historial.");
}

function enviarWA(vId) {
    let v = viajesActivos[vId]; 
    if(!v) return;
    
    let uData = encontrarUnidad(v, vId); 
    let nombreCamion = limpiarStr(v.unidadN || v.unidadFallback);
    let estNombre = window.estatusData[v.estatus]?.nombre || "En Trayecto"; 
    let pos = uData ? uData.pos : null; 
    let speed = pos ? pos.s : 0;
    let cliId = v.cliente || "Sin_Cliente"; 
    let subId = v.subcliente || "N/A";
    let cliName = (dataClientes[cliId] && dataClientes[cliId].nombre) ? dataClientes[cliId].nombre : "SIN CLIENTE";
    let subName = (dataClientes[cliId] && dataClientes[cliId].subclientes && dataClientes[cliId].subclientes[subId]) ? dataClientes[cliId].subclientes[subId].nombre : "";
    let subText = subName && subName !== "N/A" ? ` -> ${subName}` : '';
    let addrText = v.ubicacion_manual_raw || "Buscando..."; 
    let locLink = addrText; 
    let geoTextWA = "";
    
    if (pos && typeof pos.y !== 'undefined') {
        let zonaGeo = (uData && uData.zonaOficial) ? uData.zonaOficial : resolverGeocerca(pos.y, pos.x);
        if(zonaGeo) geoTextWA = `\n📍 *Geocerca:* ${zonaGeo}`;
        let domAddr = document.getElementById("addr_" + vId);
        if(domAddr && domAddr.innerText !== "Buscando...") { addrText = domAddr.innerText.trim(); } else { addrText = "Ubicación GPS"; }
        locLink = `${addrText} \nhttps://www.google.com/maps?q=$${pos.y},${pos.x}`;
    }
    
    let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []);
    let cIdx = v.destino_idx || 0; 
    let cOrigen = v.origen_actual || v.origen || "N/A"; 
    let cDestino = arrDests[cIdx] || v.destino || "N/A";
    let contStr = Array.isArray(v.contenedores_arr) ? v.contenedores_arr.join(' / ') : (v.contenedores || 'N/A');
    
    let text = `*GRUDICOM TI & GPS - REPORTE DE UNIDAD*\n\n🏢 *Cliente:* ${cliName}${subText}\n\n🚛 *Unidad:* ${nombreCamion}\n📦 *Contenedores:* ${contStr}\n🛣️ *Ruta Actual:* ${cOrigen} ➔ ${cDestino}\n🚦 *Estatus:* ${estNombre}\n⏱️ *Vel:* ${speed} km/h${geoTextWA}\n📍 *Ubicación:* ${locLink}\n\n_Reporte C4_`;
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank'); 
}

function generarReporteGrupal(cId, sId, titulo) {
    if(!datosAgrupadosGlobal[cId] || !datosAgrupadosGlobal[cId][sId]) return;
    let arrViajes = datosAgrupadosGlobal[cId][sId]; 
    let txt = `*GRUDICOM TI & GPS - REPORTE DE FLOTA*\n🏢 *${titulo}*\n\n`;
    
    arrViajes.forEach(({v, vId}) => {
        let uData = encontrarUnidad(v, vId); 
        let name = limpiarStr(v.unidadN || v.unidadFallback);
        let est = window.estatusData[v.estatus]?.nombre || "En Trayecto"; 
        let pos = uData ? uData.pos : null; 
        let vel = pos ? pos.s : 0;
        let locLink = v.ubicacion_manual_raw || "Manual"; 
        let geoTextWA = "";
        
        if (pos && typeof pos.y !== 'undefined') {
            let zonaGeo = (uData && uData.zonaOficial) ? uData.zonaOficial : resolverGeocerca(pos.y, pos.x);
            if(zonaGeo) geoTextWA = `\n📍 *Geocerca:* ${zonaGeo}`;
            locLink = `https://www.google.com/maps?q=$${pos.y},${pos.x}`;
        }
        
        let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []);
        let cIdx = v.destino_idx || 0; 
        let cOrigen = v.origen_actual || v.origen || "N/A"; 
        let cDestino = arrDests[cIdx] || v.destino || "N/A";
        let contStr = Array.isArray(v.contenedores_arr) ? v.contenedores_arr.join(' / ') : (v.contenedores || 'N/A');
        
        txt += `🚛 *Unidad:* ${name}\n📦 *Contenedores:* ${contStr}\n⏱️ *Vel:* ${vel} km/h\n🚦 *Estatus:* ${est}\n🏁 *Ruta:* ${cOrigen} ➔ ${cDestino}${geoTextWA}\n📍 *Ubicación:* ${locLink}\n\n`;
    });
    
    txt += `_Reporte C4_`; 
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(txt)}`, '_blank');
}

async function generarCapturaCliente(cId, cliName) {
    let tableWrap = document.getElementById('scrollContainer'); 
    let allRows = document.querySelectorAll('#units-body tr'); 
    let hiddenRows = [];
    
    allRows.forEach(r => { 
        if(!r.classList.contains(`client-group-${cId}`)) { 
            hiddenRows.push({el: r, display: r.style.display}); 
            r.style.display = 'none'; 
        } 
    });
    
    document.querySelectorAll('.col-operador, .col-alertas, .col-accion, .dropdown-toggle, .btn-dots, .dropdown').forEach(el => el.classList.add('oculto-en-captura'));
    
    let oldHeight = tableWrap.style.height; 
    let oldMaxHeight = tableWrap.style.maxHeight; 
    let oldOverflow = tableWrap.style.overflow;
    tableWrap.style.height = 'auto'; 
    tableWrap.style.maxHeight = 'none'; 
    tableWrap.style.overflow = 'visible';
    let oldW = document.getElementById("mainTable").style.width; 
    document.getElementById("mainTable").style.width = "max-content";
    
    await new Promise(r => setTimeout(r, 400));
    
    try {
        let canvas = await html2canvas(document.getElementById('mainTable'), { scale: 2, backgroundColor: '#f1f5f9', useCORS: true });
        canvas.toBlob(function(blob) {
            currentCaptureBlob = blob; 
            document.getElementById('imgPreviewCaptura').src = URL.createObjectURL(blob);
            new bootstrap.Modal(document.getElementById('modalPreviewCaptura')).show();
        }, 'image/png');
    } catch(e) { 
        console.error(e); 
        alert("Error al generar captura de pantalla."); 
    } finally {
        tableWrap.style.height = oldHeight; 
        tableWrap.style.maxHeight = oldMaxHeight; 
        tableWrap.style.overflow = oldOverflow;
        document.getElementById("mainTable").style.width = oldW; 
        hiddenRows.forEach(item => item.el.style.display = item.display);
        document.querySelectorAll('.oculto-en-captura').forEach(el => el.classList.remove('oculto-en-captura'));
    }
}

function descargarCaptura() { 
    if(!currentCaptureBlob) return; 
    let link = document.createElement('a'); 
    link.download = `Estatus_Bitacora.png`; 
    link.href = URL.createObjectURL(currentCaptureBlob); 
    link.click(); 
}

async function copiarCaptura() { 
    if(!currentCaptureBlob) return; 
    try { 
        const item = new ClipboardItem({ "image/png": currentCaptureBlob }); 
        await navigator.clipboard.write([item]); 
        alert("¡Imagen copiada! Ya puedes pegarla en WhatsApp Web (Ctrl+V)."); 
    } catch (err) { 
        alert("Tu navegador no permite copiar directo. Usa el botón Descargar."); 
    } 
}

function renderChips(containerId, arrayData) {
    let container = document.getElementById(containerId); 
    container.querySelectorAll('.chip').forEach(e => e.remove());
    let inputEl = container.querySelector('input');
    
    arrayData.forEach((text, index) => {
        let chip = document.createElement('div'); 
        chip.className = 'chip'; 
        chip.innerHTML = `${text} <span class="chip-close" onclick="borrarChip(event, '${containerId}', ${index})"><i class="fa-solid fa-xmark"></i></span>`;
        container.insertBefore(chip, inputEl);
    });
}

function manejarChipInput(e, containerId, arrayData) {
    if (e.key === 'Enter' || e.key === ',') { 
        e.preventDefault(); 
        let val = limpiarStr(e.target.value.replace(/,/g, '')); 
        if (val) { 
            arrayData.push(val); 
            renderChips(containerId, arrayData); 
        } 
        e.target.value = ''; 
    } else if (e.key === 'Backspace' && e.target.value === '' && arrayData.length > 0) { 
        arrayData.pop(); 
        renderChips(containerId, arrayData); 
    }
}

window.borrarChip = function(e, containerId, index) {
    e.stopPropagation();
    if(containerId === 'ed_chips_box') { 
        edChipsArray.splice(index, 1); 
        renderChips(containerId, edChipsArray); 
    } else if(containerId === 'ed_chips_cont_box') { 
        edChipsContArray.splice(index, 1); 
        renderChips(containerId, edChipsContArray); 
    } else { 
        let filaCont = document.getElementById(containerId); 
        if(filaCont && filaCont.chipData) { 
            filaCont.chipData.splice(index, 1); 
            renderChips(containerId, filaCont.chipData); 
        } 
    }
};

function expandirRuta(vId) { 
    let tramo = document.getElementById('exp_ruta_' + vId); 
    if(tramo) { 
        tramo.classList.toggle('expanded'); 
        tramo.classList.toggle('d-none'); 
    } 
}

window.avanzarMultiDestino = function(vId) {
    let v = viajesActivos[vId]; 
    if (!v) return;
    
    let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []);
    let totalDests = arrDests.length || 1; 
    let currentIdx = v.destino_idx || 0; 
    let now = Date.now();
    
    db.ref(`viajes_activos/${vId}/t_fin`).set(now);
    
    setTimeout(() => {
        if (currentIdx < totalDests - 1) {
            let updates = {}; 
            registrarLog(vId, `Terminó Destino ${currentIdx + 1}`, arrDests[currentIdx]);
            
            let tramoRef = `historial_tramos/${currentIdx}`;
            updates[tramoRef] = { destino: arrDests[currentIdx], t_salida: v.t_salida || null, t_arribo: v.t_arribo || null, t_fin: now };
            updates['destino_idx'] = currentIdx + 1; 
            updates['origen_actual'] = arrDests[currentIdx]; 
            updates['t_salida'] = now; 
            updates['t_arribo'] = null; 
            updates['t_fin'] = null; 
            updates['is_transit'] = true; 
            
            db.ref(`viajes_activos/${vId}`).update(updates);
        }
    }, 300);
};

function marcarSalida(vId, cIdx) {
    let updates = { t_salida: Date.now() }; 
    if (cIdx === 0) updates['t_salida_origen'] = Date.now();
    db.ref(`viajes_activos/${vId}`).update(updates); 
    registrarLog(vId, 'Marcó SALIDA');
}
// UTILIDADES MATEMÁTICAS DE TIEMPO
function formatTimeDiff(mins) {
    let m = Math.abs(mins);
    let d = Math.floor(m / 1440); 
    let h = Math.floor((m % 1440) / 60); 
    let remM = m % 60;
    let str = []; 
    if(d > 0) str.push(`${d}d`); 
    if(h > 0) str.push(`${h}h`); 
    if(remM > 0 || str.length === 0) str.push(`${remM}m`);
    return str.join(' ');
}

function abrirModalEdicionHora(vId, field, titulo, actualTs) {
    document.getElementById('eh_vId').value = vId; 
    document.getElementById('eh_field').value = field;
    document.getElementById('eh_txtVacio').value = titulo; 
    document.getElementById('eh_title').innerText = titulo;
    if(actualTs && actualTs !== 'null') { 
        document.getElementById('eh_input').value = getLocalISO(Number(actualTs)); 
    } else { 
        document.getElementById('eh_input').value = getLocalISO(Date.now()); 
    }
    new bootstrap.Modal(document.getElementById('modalEditHora')).show();
}

function guardarHorarioModal() {
    let vId = document.getElementById('eh_vId').value; 
    let field = document.getElementById('eh_field').value;
    let titulo = document.getElementById('eh_txtVacio').value; 
    let val = document.getElementById('eh_input').value;
    if(!val) return mostrarNotificacion("Selecciona una fecha válida.");
    let d = new Date(val).getTime();
    if(d) {
        db.ref('viajes_activos/'+vId+'/'+field).set(d); 
        registrarLog(vId, 'Modificó horario de', titulo);
        mostrarNotificacion("Horario actualizado."); 
        try { bootstrap.Modal.getInstance(document.getElementById('modalEditHora')).hide(); } catch(e){}
    }
}

window.borrarHorarioModal = function() {
    let vId = document.getElementById('eh_vId').value; 
    let field = document.getElementById('eh_field').value;
    let titulo = document.getElementById('eh_txtVacio').value;
    if(confirm(`¿Estás seguro de BORRAR el horario de ${titulo}?`)) {
        db.ref('viajes_activos/'+vId+'/'+field).set(null); 
        registrarLog(vId, 'Eliminó horario', titulo);
        mostrarNotificacion(`Horario de ${titulo} eliminado.`); 
        try { bootstrap.Modal.getInstance(document.getElementById('modalEditHora')).hide(); } catch(e){}
    }
};

function construirBotonHorario(vId, timestampStr, dbField, textoVacio, claseColor, isTransit = false, onClickOverride = null) {
    let colorFinal = isTransit ? 'warning' : claseColor;
    let onClk = onClickOverride ? onClickOverride : `abrirModalEdicionHora('${vId}', '${dbField}', '${textoVacio}', '${timestampStr || 'null'}')`;
    
    if (dbField === 't_salida' && !timestampStr && !onClickOverride) { 
        onClk = `marcarSalida('${vId}', ${viajesActivos[vId]?.destino_idx || 0})`; 
    }
    
    if(!timestampStr) { 
        return `<button class="btn btn-sm w-100 bg-white text-${colorFinal} shadow-sm" style="font-size:0.6rem; font-weight:800; padding:2px 0; margin-bottom:2px; border: 1px dashed var(--bs-${colorFinal});" onclick="${onClk}">${textoVacio}</button>`; 
    } else { 
        let displayDate = formatearFechaElegante(timestampStr); 
        return `<div class="position-relative w-100 cp" style="margin-bottom:2px;" title="Clic para editar" onclick="${onClk}"><div class="d-flex align-items-center rounded shadow-sm border border-${colorFinal}" style="overflow: hidden; height:18px; background: rgba(255,255,255,0.5);"><span class="bg-${colorFinal} text-white fw-bold text-center d-flex align-items-center justify-content-center" style="font-size:0.55rem; width:18px; height:100%;">${textoVacio.charAt(0)}</span><span class="fw-bold text-center w-100 text-${colorFinal}" style="font-size:0.6rem; line-height:18px;">${displayDate}</span></div></div>`; 
    }
}

function vincularChoferEnWialon(wialonUnitId, nombreChoferLimpio) {
    if (!wialonUnitId || wialonUnitId === "EXTERNO" || !nombreChoferLimpio) return;
    let uData = unidadesGlobales[wialonUnitId]; 
    let choferData = diccChoferesGlobal[nombreChoferLimpio];
    if (uData && choferData) {
        let tkObj = configSistema.tokens.find(t => t.nombre === uData.tkNombre);
        if (tkObj && activeSIDs[tkObj.token]) {
            peticionWialon(tkObj.url, "resource/bind_unit_driver", { resourceId: choferData.rid, unitId: uData.id, driverId: choferData.id, time: 0, mode: 1 }, activeSIDs[tkObj.token].sid).then(res => {
                if(res && res.error) console.error("Error Wialon Bind:", res.error); 
                else { console.log(`Chofer ligado en Wialon: ${nombreChoferLimpio}`); mostrarNotificacion(`✅ Chofer asignado exitosamente en Wialon.`); }
            });
        }
    }
}

// --- CREACIÓN DE NUEVOS VIAJES Y EDICIÓN ---
window.promptNuevoCliente = function() { 
    let n = prompt("Nombre del Nuevo Cliente:"); 
    if(n !== null) { 
        n = limpiarStr(n);
        if(n === '') return alert("⚠️ No puedes registrar un cliente con el nombre vacío.");
        let newRef = db.ref('clientes').push({nombre: n, logo: ""}); 
        mostrarNotificacion("Cliente agregado.");
        setTimeout(() => {
            let sel = document.getElementById("nv_cliente");
            if(sel) sel.innerHTML += `<option value="${newRef.key}">${n}</option>`;
            if(sel) sel.value = newRef.key;
            cargarSubclientesNuevoViaje();
        }, 600);
    } 
};

window.promptNuevoSubcliente = function() { 
    let cId = document.getElementById("nv_cliente").value; 
    if(!cId || cId === "Sin_Cliente") return alert("⚠️ Selecciona un cliente válido primero."); 
    let n = prompt("Nombre del Nuevo Subcliente:"); 
    if(n !== null) { 
        n = limpiarStr(n);
        if(n === '') return alert("⚠️ No puedes dejar el nombre vacío.");
        let newRef = db.ref(`clientes/${cId}/subclientes`).push({nombre: n}); 
        mostrarNotificacion("Subcliente agregado.");
        setTimeout(() => {
            cargarSubclientesNuevoViaje();
            setTimeout(() => { document.getElementById("nv_subcliente").value = newRef.key; }, 200);
        }, 600); 
    } 
};

window.cargarSubclientesNuevoViaje = function() { 
    let cId = document.getElementById("nv_cliente").value; 
    let selSub = document.getElementById("nv_subcliente"); 
    selSub.innerHTML = '<option value="N/A">-- SIN SUBCLIENTE --</option>'; 
    if(cId && cId !== "Sin_Cliente" && dataClientes[cId] && dataClientes[cId].subclientes) { 
        selSub.innerHTML += Object.keys(dataClientes[cId].subclientes).map(k => `<option value="${k}">${dataClientes[cId].subclientes[k].nombre}</option>`).join(''); 
    } 
};

window.promptNuevoClienteEdit = function() { 
    let n = prompt("Nombre del Nuevo Cliente:"); 
    if(n !== null) { 
        n = limpiarStr(n);
        if(n === '') return alert("⚠️ No puedes dejar el nombre vacío.");
        let newRef = db.ref('clientes').push({nombre: n, logo: ""}); 
        mostrarNotificacion("Cliente agregado.");
        setTimeout(() => {
            let sel = document.getElementById("ed_cliente");
            if(sel) sel.innerHTML += `<option value="${newRef.key}">${n}</option>`;
            if(sel) sel.value = newRef.key;
            cargarSubclientesEdicionViaje();
        }, 600);
    } 
};

window.promptNuevoSubclienteEdit = function() { 
    let cId = document.getElementById("ed_cliente").value; 
    if(!cId || cId === "Sin_Cliente") return alert("⚠️ Selecciona un cliente válido primero."); 
    let n = prompt("Nombre del Nuevo Subcliente:"); 
    if(n !== null) { 
        n = limpiarStr(n);
        if(n === '') return alert("⚠️ No puedes dejar el nombre vacío.");
        let newRef = db.ref(`clientes/${cId}/subclientes`).push({nombre: n}); 
        setTimeout(() => {
            cargarSubclientesEdicionViaje();
            setTimeout(() => { document.getElementById("ed_subcliente").value = newRef.key; }, 200);
        }, 600); 
    } 
};

window.cargarSubclientesEdicionViaje = function(selectedSubId = "N/A") {
    let cId = document.getElementById("ed_cliente").value;
    let selSub = document.getElementById("ed_subcliente");
    selSub.innerHTML = '<option value="N/A">-- SIN SUBCLIENTE --</option>';
    if(cId && cId !== "Sin_Cliente" && dataClientes[cId] && dataClientes[cId].subclientes) {
        selSub.innerHTML += Object.keys(dataClientes[cId].subclientes).map(k => {
            let isSel = (selectedSubId === k) ? 'selected' : '';
            return `<option value="${k}" ${isSel}>${dataClientes[cId].subclientes[k].nombre}</option>`;
        }).join('');
    }
};

function prepararNuevoViaje() { 
    document.getElementById("nv_cliente").innerHTML = '<option value="">-- SELECCIONE CLIENTE --</option>' + Object.keys(dataClientes).map(k => `<option value="${k}">${dataClientes[k].nombre}</option>`).join('');
    document.getElementById("nv_subcliente").innerHTML = '<option value="">-- SIN SUBCLIENTE --</option>'; 
    document.getElementById("nv_filas_container").innerHTML = ""; 
    document.getElementById("nv_externa").checked = false; 
    agregarFilaNV(); 
    cargarSubclientesNuevoViaje(); // Carga automática por defecto
}

let filaContador = 0;
function agregarFilaNV() {
    filaContador++; 
    let isExterna = document.getElementById("nv_externa").checked; 
    let div = document.createElement("div"); 
    div.className = "bg-white border rounded p-2 mb-2 nv-fila position-relative shadow-sm";
    let boxId = `nv_chip_box_${filaContador}`; 
    let contBoxId = `cont_${boxId}`;
    
    div.innerHTML = `
        <button class="btn btn-sm btn-danger position-absolute top-0 end-0 m-1 px-2 py-0 rounded" onclick="this.parentElement.remove()" title="Quitar Unidad"><i class="fa-solid fa-xmark"></i></button>
        <div class="row gx-2 mt-1 align-items-end">
            <div class="col-3"><label style="font-size:0.65rem;" class="fw-bold text-muted mb-1">UNIDAD GPS</label><input type="text" class="form-control form-control-sm border-primary fw-bold text-uppercase nv-unidad" list="listaUnidadesTotales" placeholder="Buscar unidad..." oninput="autofillOp(this)"></div>
            <div class="col-3"><label style="font-size:0.65rem;" class="fw-bold text-muted mb-1">ORIGEN</label><input type="text" class="form-control form-control-sm text-uppercase nv-origen" list="listaGeocercas" placeholder="Escribir..."></div>
            <div class="col-4"><label style="font-size:0.65rem;" class="fw-bold text-muted mb-1">DESTINO(S) <span class="fw-normal">(Da Enter)</span></label><div class="chips-container" id="${boxId}" onclick="this.querySelector('input').focus()"><input type="text" list="listaGeocercas" placeholder="Destinos y Enter..." class="nv-destino-input" onkeydown="manejarChipInput(event, '${boxId}', document.getElementById('${boxId}').chipData)"></div></div>
            <div class="col-2"><label style="font-size:0.65rem;" class="fw-bold text-info mb-1"><i class="fa-regular fa-calendar-check"></i> PROG.</label><input type="datetime-local" class="form-control form-control-sm nv-t-programada border-info bg-light" title="Opcional"></div>
        </div>
        <div class="row gx-2 mt-2 align-items-end">
            <div class="col-6 nv-operador-row" style="display:${isExterna ? 'flex' : 'none'}; gap:10px;"><input type="text" class="form-control form-control-sm text-uppercase nv-operador w-50" list="listaConductores" placeholder="Nombre Operador"><input type="text" class="form-control form-control-sm text-uppercase nv-operador-tel w-50 border-warning" placeholder="Teléfono (Opcional)"></div>
            <div class="col-6 ms-auto"><div class="chips-container" id="${contBoxId}" onclick="this.querySelector('input').focus()"><input type="text" placeholder="CONTENEDORES / CAJAS (Da Enter)..." class="nv-contenedores-input" onkeydown="manejarChipInput(event, '${contBoxId}', document.getElementById('${contBoxId}').chipData)"></div></div>
        </div>`;
    
    document.getElementById("nv_filas_container").appendChild(div); 
    document.getElementById(boxId).chipData = []; 
    document.getElementById(contBoxId).chipData = [];
}

document.getElementById('nv_externa').addEventListener('change', function() { 
    document.querySelectorAll('.nv-operador-row').forEach(el => el.style.display = this.checked ? 'flex' : 'none'); 
});

function autofillOp(inputEl) { 
    let uN = limpiarStr(inputEl.value); 
    let opInput = inputEl.parentElement.parentElement.nextElementSibling.querySelector('.nv-operador'); 
    if(opInput && (ramDrivers[uN] || dbOperadores[uN])) { 
        opInput.value = ramDrivers[uN] || dbOperadores[uN]; 
    } 
}

function registrarViajesMultiples() {
    let cId = document.getElementById("nv_cliente").value; 
    let sId = document.getElementById("nv_subcliente").value || "N/A";
    if(!cId) return alert("⚠️ Debes seleccionar un Cliente de la lista.");
    
    let isExterna = document.getElementById("nv_externa").checked; 
    let filas = document.querySelectorAll(".nv-fila");
    if(filas.length === 0) return alert("Añade al menos una unidad al lote.");
    
    let batchPromises = []; let errorFound = false;
    filas.forEach(fila => {
        if(errorFound) return;
        let uInput = limpiarStr(fila.querySelector(".nv-unidad").value); 
        let opInputRaw = fila.querySelector(".nv-operador") ? limpiarStr(fila.querySelector(".nv-operador").value) : "";
        let opTelRaw = fila.querySelector(".nv-operador-tel") ? limpiarStr(fila.querySelector(".nv-operador-tel").value) : "";
        let origen = limpiarStr(fila.querySelector(".nv-origen").value);
        let opInput = isExterna && opTelRaw ? `${opInputRaw} - TEL: ${opTelRaw}` : opInputRaw;
        
        let destBoxId = fila.querySelectorAll('.chips-container')[0].id; 
        let contBoxId = fila.querySelectorAll('.chips-container')[1].id;
        let destArr = document.getElementById(destBoxId).chipData || []; 
        let contArr = document.getElementById(contBoxId).chipData || [];
        let tProgRaw = fila.querySelector(".nv-t-programada").value; 
        let tProgTs = tProgRaw ? new Date(tProgRaw).getTime() : null;
        
        if(destArr.length === 0) { alert(`⚠️ Añade al menos un destino (y da Enter) para la unidad ${uInput || 'vacía'}`); errorFound = true; return; }
        if(!uInput) { alert("⚠️ El nombre de la unidad no puede estar vacío"); errorFound = true; return; }
        
        let wId = "EXTERNO";
        if (!isExterna) { 
            let nNorm = uInput.replace(/[\s\-]/g, ""); 
            let foundWialon = false;
            for(let k in unidadesGlobales){ 
                if(limpiarStr(unidadesGlobales[k].name).replace(/[\s\-]/g, "") === nNorm) { 
                    wId = k; uInput = unidadesGlobales[k].name; foundWialon = true; break; 
                } 
            } 
            if(!foundWialon) { alert(`ERROR ESTRICTO: La unidad "${uInput}" no existe en tu lista global de Wialon. Por favor selecciónala del listado.`); errorFound = true; return; }
        }
        
        let refPush = db.ref('viajes_activos').push();
        // NOTA: Se cambió estatus: "s1" por estatus: "s0"
        let p = refPush.set({ id: refPush.key, wialonId: wId, cliente: cId, subcliente: sId, origen: origen, destinos: destArr, destino_idx: 0, estatus: "s0", operador: opInput, contenedores_arr: contArr, t_programada: tProgTs, unidadFallback: uInput, unidadN: uInput }).then(() => {
            registrarLog(refPush.key, "REGISTRÓ VIAJE", isExterna ? "Unidad Externa" : "Unidad GPS");
            if(tProgTs) registrarLog(refPush.key, "Hora de Salida Programada", tProgRaw.replace('T', ' '));
            if (!isExterna && opInputRaw && diccChoferesGlobal[opInputRaw]) { vincularChoferEnWialon(wId, opInputRaw); }
        });
        batchPromises.push(p);
    });
    
    if(errorFound) return;
    Promise.all(batchPromises).then(() => { 
        mostrarNotificacion("¡Viajes registrados con éxito!"); 
        try{ bootstrap.Modal.getInstance(document.getElementById('modalNuevoViaje')).hide(); }catch(e){} 
    });
}

function abrirEdicionViaje(uId, uName) { 
    let v = viajesActivos[uId]; 
    if(!v) return; 
    
    document.getElementById("edU_id").value = uId; 
    document.getElementById("edU_name").innerText = uName; 
    // NUEVO: Se llena el campo de Unidad
    document.getElementById("ed_unidad").value = limpiarStr(v.unidadN || v.unidadFallback); 
    document.getElementById("ed_origen").value = v.origen || ""; 
    document.getElementById("ed_t_programada").value = v.t_programada ? getLocalISO(v.t_programada) : "";
    
    let isExt = (v.wialonId === "EXTERNO");
    document.getElementById("ed_operador_wialon_wrapper").style.display = isExt ? 'none' : 'block';
    document.getElementById("ed_operador_manual_wrapper").style.display = isExt ? 'block' : 'none';

    let opSelect = document.getElementById("ed_operador_wialon"); 
    opSelect.innerHTML = `<option value="">-- SELECCIONAR DE WIALON --</option>`;
    let wialonSet = new Set();
    
    Object.values(diccChoferesGlobal).forEach(chofer => {
        let opName = limpiarStr(chofer.nombre);
        if(opName && opName !== "SIN ASIGNAR" && !wialonSet.has(opName)) {
            wialonSet.add(opName);
            let combinedText = chofer.tel ? `${opName} - TEL: ${chofer.tel}` : opName;
            let isSel = (limpiarStr(v.operador) === opName) ? 'selected' : '';
            opSelect.innerHTML += `<option value="${opName}" ${isSel}>${combinedText}</option>`;
        }
    });

    document.getElementById("ed_operador").value = isExt ? (v.operador || "") : ""; 
    
    let edCli = document.getElementById("ed_cliente");
    edCli.innerHTML = '<option value="Sin_Cliente">-- SIN CLIENTE --</option>' + Object.keys(dataClientes).map(k => {
        let isSel = (v.cliente === k) ? 'selected' : '';
        return `<option value="${k}" ${isSel}>${dataClientes[k].nombre}</option>`;
    }).join('');
    
    cargarSubclientesEdicionViaje(v.subcliente);
    
    edChipsArray = Array.isArray(v.destinos) ? [...v.destinos] : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []); 
    renderChips('ed_chips_box', edChipsArray);
    
    edChipsContArray = Array.isArray(v.contenedores_arr) ? [...v.contenedores_arr] : (v.contenedores ? [v.contenedores] : []); 
    renderChips('ed_chips_cont_box', edChipsContArray);
    
    new bootstrap.Modal(document.getElementById('modalEditarViaje')).show(); 
}

function guardarEdicionViaje() { 
    let uId = document.getElementById("edU_id").value; 
    let v = viajesActivos[uId]; 
    if(!v) return;

    let uInput = limpiarStr(document.getElementById("ed_unidad").value);
    if(!uInput) return alert("⚠️ El nombre de la unidad no puede estar vacío.");

    let isExt = (v.wialonId === "EXTERNO"); 
    let wId = v.wialonId;

    // NUEVO: Validar si cambió el nombre de la unidad y NO es externa
    if (!isExt && uInput !== limpiarStr(v.unidadN || v.unidadFallback)) {
        let nNorm = uInput.replace(/[\s\-]/g, ""); 
        let foundWialon = false;
        for(let k in unidadesGlobales){ 
            if(limpiarStr(unidadesGlobales[k].name).replace(/[\s\-]/g, "") === nNorm) { 
                wId = k; uInput = unidadesGlobales[k].name; foundWialon = true; break; 
            } 
        } 
        if(!foundWialon) return alert(`ERROR: La unidad "${uInput}" no existe en Wialon.`);
    }
    
    let tProgRaw = document.getElementById("ed_t_programada").value; 
    let tProgTs = tProgRaw ? new Date(tProgRaw).getTime() : null;

    let opWialon = document.getElementById("ed_operador_wialon").value; 
    let opManual = document.getElementById("ed_operador").value;
    let finalOp = isExt ? limpiarStr(opManual) : limpiarStr(opWialon);

    let cId = document.getElementById("ed_cliente").value || "Sin_Cliente";
    let sId = document.getElementById("ed_subcliente").value || "N/A";

    registrarLog(uId, "Editó Datos", "Unidad/Rutas/Contenedor/Hora/Cliente"); 
    db.ref('viajes_activos/' + uId).update({ 
        unidadN: uInput,
        unidadFallback: uInput,
        wialonId: wId,
        cliente: cId,
        subcliente: sId,
        origen: limpiarStr(document.getElementById("ed_origen").value), 
        destinos: edChipsArray, 
        contenedores_arr: edChipsContArray, 
        operador: finalOp, 
        t_programada: tProgTs 
    }).then(() => { 
        mostrarNotificacion("Cambios guardados.");
        if (!isExt && opWialon) vincularChoferEnWialon(wId, finalOp);
        try{bootstrap.Modal.getInstance(document.getElementById('modalEditarViaje')).hide();}catch(e){} 
    }); 
}

// ============================================================================
// PARTE 3: RENDERIZADO DE TABLA Y MOTOR WIALON
// ============================================================================

function renderizarBitacora() {
    if (UI_PAUSED) return; 
    
    const tbody = document.getElementById('units-body'); 
    let html = "";
    let tree = { "Sin_Cliente": { "N/A": [] } };
    
    Object.keys(dataClientes).forEach(cId => { 
        tree[cId] = { "N/A": [] }; 
        if(dataClientes[cId].subclientes) {
            Object.keys(dataClientes[cId].subclientes).forEach(sId => tree[cId][sId] = []); 
        }
    });
    
    Object.keys(viajesActivos).forEach(vId => { 
        let v = viajesActivos[vId]; 
        if(typeof v !== 'object' || !v) return; 
        let cId = String(v.cliente || "Sin_Cliente"); 
        let sId = String(v.subcliente || "N/A"); 
        if(!tree[cId]) tree[cId] = { "N/A": [] }; 
        if(!tree[cId][sId]) tree[cId][sId] = []; 
        tree[cId][sId].push({vId, v}); 
    });
    
    datosAgrupadosGlobal = tree; 

    for(let cId in tree) {
        let cliName = "SIN CLIENTE"; 
        if (cId !== "Sin_Cliente" && dataClientes[cId] && dataClientes[cId].nombre) cliName = dataClientes[cId].nombre;
        
        let hasClientUnits = false;
        for(let sId in tree[cId]) { 
            if(tree[cId][sId].length > 0) { hasClientUnits = true; break; } 
        }
        if(!hasClientUnits) continue;

        let logoHtml = (cId !== "Sin_Cliente" && dataClientes[cId] && dataClientes[cId].logo) 
            ? `<img src="${dataClientes[cId].logo}" class="client-logo" title="${cliName}">` 
            : ``;
        
        let clientActions = cId !== "Sin_Cliente" ? `
            <div class="dropdown position-absolute end-0 me-3">
                <button class="btn btn-sm text-white" type="button" data-bs-toggle="dropdown" title="Acciones de Cliente"><i class="fa-solid fa-ellipsis-vertical fs-5"></i></button>
                <ul class="dropdown-menu shadow-lg border-0 rounded-3">
                    <li><a class="dropdown-item fw-bold text-dark cp" onclick="generarCapturaCliente('${cId}', '${cliName}')"><i class="fa-solid fa-camera me-2 text-primary"></i> Captura Estatus</a></li>
                    <li><a class="dropdown-item fw-bold text-success cp" onclick="generarReporteGrupal('${cId}', 'N/A', '${cliName}')"><i class="fa-brands fa-whatsapp me-2"></i> Reporte WhatsApp</a></li>
                </ul>
            </div>` : '';
        
        let clientTitleHtml = `
            <div class="d-flex align-items-center justify-content-center w-100 position-relative">
                <img src="TIGPS HD2.png" class="grudicom-logo-header" title="Grudicom TI & GPS" onerror="this.style.display='none'">
                ${logoHtml}
                <span class="align-middle text-uppercase fw-bold ms-2" style="font-size: 1.3rem; letter-spacing: 0.5px;">${cliName}</span>
                ${clientActions}
            </div>
        `;
        
        html += `<tr class="header-cliente shadow-sm client-group-${cId}" data-client="${cId}"><td colspan="${colOrder.length}">${clientTitleHtml}</td></tr>`;

        for(let sId in tree[cId]) {
            if(tree[cId][sId].length === 0) continue;
            let subName = ""; 
            if (sId !== "N/A" && dataClientes[cId] && dataClientes[cId].subclientes && dataClientes[cId].subclientes[sId]) {
                subName = dataClientes[cId].subclientes[sId].nombre || "";
            }
            
            let logoHtmlSub = (cId !== "Sin_Cliente" && dataClientes[cId] && dataClientes[cId].logo) ? `<img src="${dataClientes[cId].logo}" class="client-logo-sub" title="${cliName}">` : '';
            let subclientActions = sId !== "N/A" ? `
                <div class="dropdown position-absolute end-0 me-3">
                    <button class="btn btn-sm text-dark" type="button" data-bs-toggle="dropdown"><i class="fa-solid fa-ellipsis-vertical fs-6"></i></button>
                    <ul class="dropdown-menu shadow-lg border-0 rounded-3">
                        <li><a class="dropdown-item fw-bold text-success cp" onclick="generarReporteGrupal('${cId}', '${sId}', '${cliName} -> ${subName}')"><i class="fa-brands fa-whatsapp me-2"></i> Reporte Subcliente</a></li>
                        <li><a class="dropdown-item fw-bold text-dark cp" onclick="generarCapturaCliente('${cId}', '${subName}')"><i class="fa-solid fa-camera me-2 text-primary"></i> Captura de Subcliente</a></li>
                    </ul>
                </div>` : '';
            
            if(sId !== "N/A" && subName !== "") { 
                html += `
                <tr class="header-subcliente client-group-${cId}">
                    <td colspan="${colOrder.length}">
                        <div class="d-flex justify-content-center align-items-center position-relative w-100">
                            <div class="d-flex align-items-center text-uppercase">↳ ${logoHtmlSub} SUBCLIENTE: ${subName}</div>
                            ${subclientActions}
                        </div>
                    </td>
                </tr>`; 
            }
            
            html += getHeadersRow(cId);

            tree[cId][sId].sort((a, b) => { 
                let cmp = 0;
                let uniA = String(a.v.unidadN || a.v.unidadFallback || ""); 
                let uniB = String(b.v.unidadN || b.v.unidadFallback || ""); 

                if (sortState.column === 'unidad') { 
                    cmp = uniA.localeCompare(uniB);
                } 
                else if (sortState.column === 'ruta') { 
                    let valA = String(a.v.origen || ""); 
                    let valB = String(b.v.origen || ""); 
                    cmp = valA.localeCompare(valB);
                } 
                else { 
                    // ESTATUS (Principal) + UNIDAD (Secundario en caso de empate)
                    let valA = String(a.v.estatus || ""); 
                    let valB = String(b.v.estatus || ""); 
                    cmp = valA.localeCompare(valB);
                    if (cmp === 0) {
                        cmp = uniA.localeCompare(uniB); // Desempate por nombre de unidad
                    }
                }
                return sortState.direction === 'asc' ? cmp : -cmp;
            });

            tree[cId][sId].forEach(({vId, v}) => {
                try {
                    let nombreCamion = limpiarStr(v.unidadN || v.unidadFallback);
                    let isExternal = v.wialonId === "EXTERNO"; 
                    let colEstatus = window.estatusData[v.estatus]?.col || '#0f172a';

                    let logsObj = v.log || {}; 
                    let logsArr = Object.values(logsObj).sort((a,b)=>b.t - a.t);
                    
                    let lastLog = logsArr.length > 0 ? 
                        `<div class="text-start w-100 d-flex flex-column justify-content-center">
                            <div style="font-size:0.6rem; color:#64748b; font-weight:800; margin-bottom:2px;">
                                <i class="fa-regular fa-calendar text-primary"></i> ${formatearFechaElegante(logsArr[0].t)} 
                                <i class="fa-solid fa-magnifying-glass-plus ms-1 text-primary cp" title="Ver Historial Completo" onclick="abrirModalLog('${vId}', '${nombreCamion}')"></i>
                            </div>
                            <div class="bg-white border rounded shadow-sm p-1" style="border-left: 3px solid var(--accent) !important; font-size:0.65rem; line-height:1.2;">
                                <div style="white-space: normal;"><b class="text-primary">${String(logsArr[0].usr)}:</b> <span class="text-dark fw-bold">${String(logsArr[0].act)}</span></div>
                                <div class="text-muted mt-1" style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; font-size:0.6rem;" title="${String(logsArr[0].det||'')}">${String(logsArr[0].det||'')}</div>
                            </div>
                        </div>` : `<div style="font-size:0.65rem; color:#94a3b8;">Sin eventos</div>`;

                    // Mostrar icono rojo parpadeante si hay alerta de parada sin justificar
                    let htmlCajaLog = v.alerta_detenida 
    ? `<div class="log-alert-container shadow-sm" onclick="abrirHubSeguridad()" title="Ir al HUB de Seguridad para justificar">
            <i class="fa-solid fa-bell log-alert-icon"></i>
            <div class="log-alert-text">ATENDER EN HUB</div>
       </div>` 
    : lastLog;

                    let curEst = window.estatusData[v.estatus] || window.estatusData["s0"];
                    let optionsHtml = `
                        <div class="dropdown w-100">
                            <button class="btn btn-sm w-100 fw-bold dropdown-toggle shadow-sm" style="background:white; color:${curEst.col}; border:1.5px solid ${curEst.col}; font-size:0.65rem; border-radius:12px; padding:2px 6px;" type="button" data-bs-toggle="dropdown" data-bs-boundary="body" aria-expanded="false">
                                ${curEst.nombre}
                            </button>
                            <ul class="dropdown-menu shadow-lg border-0 rounded-3" style="font-size:0.75rem; max-height:250px; overflow-y:auto; z-index:99999 !important;">
                                ${Object.keys(window.estatusData).map(k=>`<li><a class="dropdown-item fw-bold cp py-1" style="color:${window.estatusData[k].col};" onclick="cambiarEstatus('${k}', '${vId}')">${window.estatusData[k].nombre}</a></li>`).join('')}
                            </ul>
                        </div>`;

                    let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []);
                    let totDests = arrDests.length || 1;
                    let cIdx = v.destino_idx || 0;
                    let isLastDest = (cIdx >= totDests - 1);
                    let isTripFullyFinished = (isLastDest && v.t_fin);
                    
                    let cOrigen = v.origen_actual || v.origen || "";
                    let cDestino = arrDests[cIdx] || v.destino || "";
                    if (isTripFullyFinished) { cOrigen = v.origen || ""; cDestino = arrDests[totDests - 1] || v.destino || ""; }

                    // LÓGICA DE SEMÁFORO
                    let semaforoHtml = '';
                    let iconoStatusIzquierda = ''; // NUEVA VARIABLE PARA EL ÍCONO
                    if(v.t_programada) {
                        let pTime = new Date(v.t_programada);
                        let dateStr = pTime.toLocaleDateString('es-MX', {day:'2-digit', month:'short'});
                        let timeStr = pTime.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'});
                        let pTimeStr = `${dateStr} ${timeStr}`;
                        let msRef = v.t_salida || Date.now();
                        let diffMins = Math.floor((msRef - v.t_programada) / 60000);
                        let diffStr = formatTimeDiff(diffMins);

                        if (!v.t_salida) {
                            // SI AÚN NO SALE: Muestra la cápsula completa en la columna ruta
                            let sClass = "semaforo-verde"; let sText = ""; let sIcon = "fa-clock";
                            if (diffMins > 20) { 
                                sClass = "semaforo-rojo"; sText = `Retraso: ${diffStr}`; sIcon = "fa-circle-xmark"; 
                            } else if (diffMins > 0) { 
                                sClass = "semaforo-amarillo"; sText = `Retraso: ${diffStr}`; sIcon = "fa-triangle-exclamation"; 
                            } else { 
                                sClass = "semaforo-verde"; sText = `Faltan: ${diffStr}`; sIcon = "fa-clock";
                            }
                            semaforoHtml = `<div class="badge-semaforo ${sClass}" title="⌚ HORA PROGRAMADA: ${pTimeStr}"><i class="fa-solid ${sIcon}"></i> ${sText}</div>`;
                        } else {
                            // SI YA SALIÓ A RUTA: Desaparece de ruta y se va al ícono lateral
                            if (diffMins > 0) {
                                iconoStatusIzquierda = `<i class="fa-solid fa-circle-exclamation text-danger fs-6" title="Salió tarde por ${diffStr} (Prog: ${pTimeStr})" style="cursor:help;"></i>`;
                            } else {
                                iconoStatusIzquierda = `<i class="fa-solid fa-circle-check text-success fs-6" title="Salió a tiempo (Prog: ${pTimeStr})" style="cursor:help;"></i>`;
                            }
                        }
                    }

                    let notaDests = totDests > 1 ? `<div style="font-size:0.65rem; color:#0284c7; font-weight:900; margin-top:4px;">Destino ${cIdx + 1} de ${totDests}</div>` : '';
                    if(isTripFullyFinished && totDests > 1) {
                        notaDests = `<div style="font-size:0.65rem; color:#10b981; font-weight:900; margin-top:4px;"><i class="fa-solid fa-flag-checkered"></i> Ruta Completa</div>`;
                    }

                    let tramosHtml = '';
                    if (totDests > 1) {
                        tramosHtml = `<div id="exp_ruta_${vId}" class="d-none tramo-historial w-100 text-start mt-2 p-2 bg-light rounded border shadow-sm" style="font-size:0.65rem;">
                                        <div class="fw-bold text-primary mb-1 border-bottom border-secondary pb-1">HISTORIAL DE RUTA</div>`;
                        arrDests.forEach((d, i) => {
                            let hist = (v.historial_tramos && v.historial_tramos[i]) ? v.historial_tramos[i] : null;
                            let arrTime = (i === cIdx && v.t_arribo) ? formatTimeFriendly(v.t_arribo) : (hist && hist.t_arribo ? formatTimeFriendly(hist.t_arribo) : '--:--');
                            let finTime = (i === cIdx && v.t_fin) ? formatTimeFriendly(v.t_fin) : (hist && hist.t_fin ? formatTimeFriendly(hist.t_fin) : '--:--');
                            
                            let actClass = (i === cIdx) ? 'bg-white border-primary border text-primary fw-bold p-1 rounded my-1 shadow-sm' : 'text-muted mb-1';
                            let indicator = (i === cIdx) ? '<i class="fa-solid fa-truck-fast me-1"></i> ' : '<i class="fa-solid fa-check text-success me-1"></i> ';
                            if(i > cIdx) { indicator = '<i class="fa-regular fa-clock me-1"></i> '; arrTime = 'Pendiente'; finTime = ''; }
                            tramosHtml += `<div class="${actClass}">${indicator} ${i+1}. ${d} <br> <span style="font-size:0.6rem; color:#64748b;">Arr: ${arrTime} ${finTime ? '| Fin: '+finTime : ''}</span></div>`;
                        });
                        tramosHtml += `</div>`;
                    }

                    let overrideFin = null;
                    if (!isLastDest && !v.t_fin) overrideFin = `avanzarMultiDestino('${vId}')`;

                    let isTransit = v.is_transit && cIdx > 0;
                    let timestampSalidaVisual = (isLastDest && v.t_salida_origen && cIdx > 0) ? v.t_salida_origen : v.t_salida;
                    
                    let btnSalida = construirBotonHorario(vId, timestampSalidaVisual, 't_salida', 'SALIDA', 'success', isTransit);
                    let btnArribo = v.t_salida ? construirBotonHorario(vId, v.t_arribo, 't_arribo', 'ARRIBO', 'primary') : '';
                    let btnFin = v.t_arribo ? construirBotonHorario(vId, v.t_fin, 't_fin', 'FINALIZADO', 'dark', false, overrideFin) : '';

                    // ENVOLVEMOS EL BOTÓN DE SALIDA CON EL ÍCONO A SU IZQUIERDA
                    let outputSalida = iconoStatusIzquierda 
                        ? `<div class="d-flex align-items-center w-100 gap-1">${iconoStatusIzquierda}<div class="flex-grow-1" style="min-width:0;">${btnSalida}</div></div>` 
                        : btnSalida;

                    let mapClick = `clickMapaUnidad('${vId}')`;
                    let tds = {};
                    
                    let contArr = Array.isArray(v.contenedores_arr) ? v.contenedores_arr : (v.contenedores ? [v.contenedores] : []);
                    let htmlContenedores = contArr.map(c => `<div class="contenedor-capsula"><i class="fa-solid fa-trailer me-2 text-primary" style="font-size:0.9rem;"></i>${c}</div>`).join('');

                    tds['col-unidad'] = `<td class="col-unidad align-middle ${hiddenCols['col-unidad'] ? 'd-none' : ''}">
                        <div class="d-flex flex-column align-items-center justify-content-center w-100">
                            <span class="unit-name" id="name_btn_${vId}" onclick="${mapClick}">${nombreCamion}</span>
                            <div class="w-100 d-flex flex-column align-items-center">${htmlContenedores}</div>
                        </div>
                    </td>`;
                    
                    tds['col-operador'] = `<td class="col-operador align-middle ${hiddenCols['col-operador'] ? 'd-none' : ''}"><div id="op_wialon_${vId}"><span class="badge bg-secondary w-100 mt-1" style="font-size:0.6rem;"><i class="fa-solid fa-spinner fa-spin"></i> Cargando...</span></div></td>`;
                    
                    tds['col-ruta'] = `<td class="col-ruta align-middle ${hiddenCols['col-ruta'] ? 'd-none' : ''}">
                        <div class="d-flex flex-column align-items-center justify-content-center w-100" title="Para editar ruta usa 'Editar Viaje'">
                            ${semaforoHtml}
                            <div class="d-flex flex-column align-items-center justify-content-center w-100 mt-1">
                                <div class="route-text">${cOrigen}</div>
                                <i class="fa-solid fa-caret-down my-1 text-muted" style="font-size:0.8rem;"></i>
                                <div class="route-text">${cDestino}</div>
                                ${totDests > 1 ? `<button class="btn btn-sm text-primary p-0 mt-2 shadow-sm rounded-circle bg-white" style="width:24px; height:24px; line-height:12px;" onclick="expandirRuta('${vId}')"><i class="fa-solid fa-list" style="font-size:0.7rem;"></i></button>` : ''}
                            </div>
                            ${notaDests}
                            ${tramosHtml}
                        </div>
                    </td>`;
                    
                    // APLICAMOS LA VARIABLE "outputSalida" A LA COLUMNA DE HORARIOS
                    tds['col-horarios'] = `<td class="col-horarios align-middle ${hiddenCols['col-horarios'] ? 'd-none' : ''}"><div class="d-flex flex-column justify-content-center h-100 px-1">${outputSalida}${btnArribo}${btnFin}</div></td>`;
                    tds['col-estatus'] = `<td class="col-estatus align-middle ${hiddenCols['col-estatus'] ? 'd-none' : ''}" style="overflow: visible !important;">${optionsHtml}</td>`;
                    
                    tds['col-gps'] = `<td class="col-gps align-middle ${hiddenCols['col-gps'] ? 'd-none' : ''}" id="gps_cell_${vId}">
                        <div class="d-flex flex-column px-1 w-100">
                            <div class="d-flex justify-content-between align-items-center border-bottom border-light pb-1 mb-1">
                                <div class="d-flex align-items-center"><span id="icon_${vId}"><i class="fa-solid fa-spinner fa-spin text-muted me-1 fs-6"></i></span><span id="speed_${vId}"><span class="speed-badge bg-secondary m-0">-- km/h</span></span></div>
                                <div id="time_${vId}" style="font-size:0.65rem; color:#64748b; font-weight:800;">--</div>
                            </div>
                            <div class="w-100 text-center" id="addr_control_${vId}"><div style="font-size:0.75rem; color:#64748b; font-weight:800;">Sincronizando...</div></div>
                        </div>
                    </td>`;
                    
                    tds['col-alertas'] = `<td class="col-alertas align-middle ${hiddenCols['col-alertas'] ? 'd-none' : ''}" id="alertas_${vId}">${v.alerta?'<span class="text-danger fw-bold" style="font-size:0.85rem;">'+v.alerta.txt+'</span>':'<span class="text-success fw-bold" style="font-size:0.85rem;">OK</span>'}</td>`;
                    tds['col-historial'] = `<td class="col-historial align-middle ${hiddenCols['col-historial'] ? 'd-none' : ''}">${htmlCajaLog}</td>`;
                    
                    tds['col-accion'] = `<td class="col-accion align-middle ${hiddenCols['col-accion'] ? 'd-none' : ''}" style="overflow: visible !important;">
                        <div class="d-flex align-items-center justify-content-center h-100">
                            <div class="dropdown">
                                <button class="btn-dots cp bg-transparent border-0" type="button" data-bs-toggle="dropdown" data-bs-boundary="body" title="Más Opciones"><i class="fa-solid fa-ellipsis-vertical fs-5 text-muted"></i></button>
                                <ul class="dropdown-menu dropdown-menu-end shadow-lg border-0 rounded-3 dropdown-menu-custom" style="z-index:99999 !important;">
                                    <li><a class="dropdown-item dropdown-item-custom text-success cp" onclick="enviarWA('${vId}')"><i class="fa-brands fa-whatsapp me-2 fs-5 align-middle"></i> Enviar WhatsApp</a></li>
                                    <li><a class="dropdown-item dropdown-item-custom text-primary cp" onclick="abrirEdicionViaje('${vId}', '${nombreCamion}')"><i class="fa-solid fa-pencil me-2 fs-5 align-middle"></i> Editar Viaje</a></li>
                                    <li><hr class="dropdown-divider"></li>
                                    <li><a class="dropdown-item dropdown-item-custom text-danger cp" onclick="finalizarViaje('${vId}', '${nombreCamion}')"><i class="fa-solid fa-trash me-2 fs-5 align-middle"></i> Archivar Viaje</a></li>
                                </ul>
                            </div>
                        </div>
                    </td>`;

                    let savedWidths = JSON.parse(localStorage.getItem('tms_colWidths')) || {};
                    let trInner = colOrder.map(c => { 
                        let ancho = savedWidths[c] || columnasDef[c].ancho; 
                        return tds[c].replace('class="', `style="width:${ancho}px; min-width:${ancho}px; max-width:${ancho}px;" class="`); 
                    }).join('');
                    
                    let searchData = `${nombreCamion} ${v.origen||''} ${v.destino||''} ${contArr.join(' ')} ${v.operador||''} ${cliName} ${subName} ${window.estatusData[v.estatus]?.nombre||''}`.toLowerCase();
                    let classAlerts = isExternal ? 'external-connection-row ' : 'needs-gps-update ';
                    
                    html += `<tr class="data-row client-group-${cId} ${classAlerts}" id="row_${vId}" data-search="${searchData}" style="--row-bg: ${hexToRgba(colEstatus, 0.08)};">${trInner}</tr>`;

                } catch(err) { 
                    console.error("Fila omitida por error:", vId, err); 
                }
            });
        }
    }
    
    tbody.innerHTML = html || `<tr><td colspan="${colOrder.length}" class="p-5 text-muted fs-6 text-center"><i class="fa-solid fa-folder-open mb-2 fs-3 text-primary"></i><br>Aún no hay viajes activos en la bitácora.</td></tr>`;
    filtrarTablaInteligente();
    if (motorArrancado) inyectarGPSenTabla();
}

function filtrarTablaInteligente() {
    let t = document.getElementById("buscador").value.toLowerCase(); 
    let rows = Array.from(document.querySelectorAll("#units-body tr"));
    rows.forEach(r => { if(r.classList.contains("data-row")) r.style.display = (r.getAttribute("data-search") || "").includes(t) ? "" : "none"; });
    let currentSubclientVisible = false; let currentClientVisible = false;
    for (let i = rows.length - 1; i >= 0; i--) {
        let r = rows[i];
        if (r.classList.contains("data-row")) { if (r.style.display !== "none") { currentSubclientVisible = true; currentClientVisible = true; } } 
        else if (r.classList.contains("header-columnas")) { r.style.display = currentSubclientVisible ? "" : "none"; } 
        else if (r.classList.contains("header-subcliente")) { r.style.display = currentSubclientVisible ? "" : "none"; currentSubclientVisible = false; } 
        else if (r.classList.contains("header-cliente")) { r.style.display = currentClientVisible ? "" : "none"; currentClientVisible = false; currentSubclientVisible = false; }
    }
}

// ============================================================================
// NUEVA LÓGICA DE HUBS, AUTO-ESTATUS DE PARADAS Y REANUDACIONES
// ============================================================================

/**
 * Actualiza dinámicamente los datos de GPS en la tabla sin recargar toda la bitácora.
 * Esta versión está corregida para evitar que el texto "Buscando..." se quede estático.
 */
function inyectarGPSenTabla() { 
    Object.keys(viajesActivos).forEach(vId => { 
        try { 
            let v = viajesActivos[vId]; 
            if(typeof v !== 'object' || !v) return; 
            
            let uData = encontrarUnidad(v, vId); 
            let isExternal = v.wialonId === "EXTERNO"; 
            let pos = uData ? uData.pos : null; 
            let speed = pos ? pos.s : 0; 
            
            let hasCoords = pos && typeof pos.y !== 'undefined' && typeof pos.x !== 'undefined';
            let isLost = !uData || (!hasCoords && !isExternal); 
            let ageSecs = pos && pos.t ? Math.floor(Date.now()/1000) - pos.t : 0; 
            let isStale = ageSecs > 600; 
            
            let row = document.getElementById("row_" + vId); 
            if(row) { 
                row.classList.remove("lost-connection-row", "stale-row"); 
                if(isLost && !isExternal) row.classList.add("lost-connection-row"); 
                else if (isStale && !isExternal) row.classList.add("lost-connection-row"); 
            } 
            
            let elGpsCell = document.getElementById("gps_cell_" + vId); 
            if(elGpsCell) { 
                if (isExternal) { 
                    elGpsCell.innerHTML = `<div class="d-flex flex-column px-1 w-100"><div class="d-flex justify-content-between align-items-center border-bottom border-light pb-1 mb-1"><div class="d-flex align-items-center"><i class="fa-solid fa-globe text-info me-1 fs-6"></i> <span class="speed-badge bg-secondary m-0">-- km/h</span></div></div><div class="d-flex align-items-center gap-2 text-start"><i class="fa-solid fa-pencil text-primary cp" onclick="editarUbicacionManual('${vId}')"></i><div class="addr-container flex-grow-1">${v.ubicacion_manual||'--'}</div></div></div>`; 
                } else if (isLost || isStale) { 
                    elGpsCell.innerHTML = `<div class="d-flex flex-column px-1 w-100"><div class="d-flex justify-content-between align-items-center border-bottom border-danger pb-1 mb-1"><div class="d-flex align-items-center"><i class="fa-solid fa-triangle-exclamation text-danger me-1 fs-6"></i> <span class="speed-badge bg-secondary m-0">${speed} km/h</span></div></div><div class="d-flex align-items-center gap-2 text-start"><span class="text-danger fw-bold" style="font-size:0.65rem;">SIN SEÑAL</span><div class="addr-container flex-grow-1">${v.ubicacion_manual||'--'}</div></div></div>`; 
                } else { 
                    let speedBg = (speed > 0 && speed < 100) ? "#10b981" : (speed >= 100 ? "#ef4444" : "#64748b");
                    let icon = speed > 0 ? `<i class="fa-solid fa-truck-fast text-success me-1 fs-6"></i>` : `<i class="fa-solid fa-truck text-secondary me-1 fs-6"></i>`; 
                    
                    // --- AQUÍ ESTÁ LA CORRECCIÓN ---
                    let geoKey = `${pos.y.toFixed(4)}_${pos.x.toFixed(4)}`; 
                    let addrHTML = geocodeCache[geoKey] 
                        ? `<i class="fa-solid fa-map-location-dot text-primary me-1"></i>${geocodeCache[geoKey]}` 
                        : `<i class="fa-solid fa-spinner fa-spin text-muted"></i> Buscando...`;
                    
                    let zonaGeo = limpiarStr(uData.zonaOficial || resolverGeocerca(pos.y, pos.x)); 
                    let geoHtml = zonaGeo ? `<span class="badge-geo text-truncate ms-2" style="max-width:150px;" title="${zonaGeo}"><i class="fa-solid fa-draw-polygon me-1"></i>${zonaGeo}</span>` : ''; 
                    
                    elGpsCell.innerHTML = `
                        <div class="d-flex flex-column px-1 w-100">
                            <div class="d-flex justify-content-between align-items-center border-bottom border-light pb-1 mb-1">
                                <div class="d-flex align-items-center">${icon} <span class="speed-badge m-0" style="background-color:${speedBg}; padding:2px 6px;">${speed} km/h</span> ${geoHtml}</div>
                                <div style="font-size:0.75rem; font-weight:900;"><span class="text-primary">(${timeAgo(pos.t)})</span></div>
                            </div>
                            <div class="d-flex align-items-center w-100">
                                <a href="http://googleusercontent.com/maps.google.com/4{pos.y},${pos.x}" target="_blank" class="addr-link text-start flex-grow-1">
                                    <div class="addr-container" id="addr_${vId}">${addrHTML}</div>
                                </a>
                            </div>
                        </div>`; 
                } 
            } 
        } catch(e) { console.error("Error GPS Render:", e); } 
    }); 
    desencadenarGeocoding(); 
}

function desencadenarGeocoding() {
    Object.keys(viajesActivos).forEach(vId => {
        let v = viajesActivos[vId]; 
        if(typeof v !== 'object' || !v) return; 
        
        // BLOQUEO DE SEGURIDAD: Si no ha iniciado el viaje o ya se terminó, no se procesan arribos
        if (!v.t_salida || v.t_fin) return; 

        let uData = encontrarUnidad(v, vId); 
        let arrDests = Array.isArray(v.destinos) ? v.destinos : (v.destino ? String(v.destino).split(/,|\n/).map(d => limpiarStr(d)) : []);
        let targetDest = arrDests[v.destino_idx || 0] || v.destino;

        if(uData && uData.pos) {
            let zonaGeo = limpiarStr(uData.zonaOficial || resolverGeocerca(uData.pos.y, uData.pos.x));
            
            // LÓGICA: Hub Logístico (Arribos a Destino)
            if(zonaGeo && targetDest && !v.t_arribo && !v.arribo_notificado && zonaGeo.includes(targetDest)) {
                enviarNotificacionPersistente(vId, uData.name, 'ARRIBO', `Llegó a destino: ${targetDest}`);
                db.ref('viajes_activos/'+vId+'/arribo_notificado').set(true);
            }
            
            let geoKey = `${uData.pos.y.toFixed(4)}_${uData.pos.x.toFixed(4)}`;
            if(!geocodeCache[geoKey] && !geoQueue.find(i => i.key === geoKey)) { 
                geoQueue.push({ key: geoKey, y: uData.pos.y, x: uData.pos.x, vId: vId, dest: targetDest }); 
            } else if(geocodeCache[geoKey] && targetDest && !v.t_arribo && !v.arribo_notificado && limpiarStr(geocodeCache[geoKey]).includes(targetDest)) {
                enviarNotificacionPersistente(vId, uData.name, 'ARRIBO', `Llegó a destino: ${targetDest}`);
                db.ref('viajes_activos/'+vId+'/arribo_notificado').set(true);
            }
        }
    });
}
// --- NUEVA FUNCIÓN: OBTENER DIRECCIÓN DESDE WIALON ---
async function obtenerDireccionWialon(lat, lon, vId) {
    let v = viajesActivos[vId];
    if (!v || v.wialonId === "EXTERNO") return;

    let uData = unidadesGlobales[v.wialonId] || encontrarUnidad(v, vId);
    if (!uData) return;

    let tkObj = configSistema.tokens.find(t => t.nombre === uData.tkNombre);
    if (!tkObj || !activeSIDs[tkObj.token]) return;

    let sid = activeSIDs[tkObj.token].sid;
    
    // IMPORTANTE: Aseguramos que lat y lon sean números flotantes
    let params = {
        coords: [{ "lat": parseFloat(lat), "lon": parseFloat(lon) }],
        flags: 1255211008, 
        uid: uData.id
    };

    try {
        let res = await peticionWialon(tkObj.url, "renderer/get_addresses", params, sid);
        // Wialon a veces devuelve un array de strings directo o un objeto con direcciones
        if (res && res.length > 0) {
            let direccion = res[0];
            let geoKey = `${lat.toFixed(4)}_${lon.toFixed(4)}`;
            
            geocodeCache[geoKey] = direccion;
            localStorage.setItem('tms_geoCache', JSON.stringify(geocodeCache));

            // Actualización forzada del DOM por ID
            let domAddr = document.getElementById(`addr_${vId}`);
            if (domAddr) {
                domAddr.innerHTML = `<i class="fa-solid fa-map-location-dot text-primary me-1"></i>${direccion}`;
            }
        }
    } catch (e) {
        console.error("Error API Wialon Geocode:", e);
    }
}

function procesarFilaDirecciones() {
    if (isGeocoding || geoQueue.length === 0) return;
    
    let item = geoQueue.shift();
    
    // Si ya está en caché, lo pintamos de inmediato y pasamos al siguiente
    if (geocodeCache[item.key]) {
        let domCell = document.getElementById(`addr_${item.vId}`);
        if (domCell) domCell.innerHTML = `<i class="fa-solid fa-map-location-dot text-primary me-1"></i>${geocodeCache[item.key]}`;
        return;
    }

    isGeocoding = true;
    
    // Buscamos el SID del token correspondiente
    let v = viajesActivos[item.vId];
    let uData = unidadesGlobales[v?.wialonId];
    if (!uData) { isGeocoding = false; return; }
    
    let tkObj = configSistema.tokens.find(t => t.nombre === uData.tkNombre);
    let sid = activeSIDs[tkObj?.token]?.sid;
    
    if (!sid) { isGeocoding = false; return; }

    let params = { coords: [{ lat: item.y, lon: item.x }], flags: 1255211008, uid: uData.id };

    peticionWialon(tkObj.url, "renderer/get_addresses", params, sid).then(res => {
        if (res && res[0]) {
            let direccion = res[0];
            geocodeCache[item.key] = direccion;
            localStorage.setItem('tms_geoCache', JSON.stringify(geocodeCache));

            // Actualizamos la celda físicamente
            let domCell = document.getElementById(`addr_${item.vId}`);
            if (domCell) domCell.innerHTML = `<i class="fa-solid fa-map-location-dot text-primary me-1"></i>${direccion}`;
        }
    }).finally(() => {
        setTimeout(() => { isGeocoding = false; }, 200); // 200ms para ir rápido
    });
}

// RESTO DE FUNCIONES DE ADMINISTRACIÓN Y AUTENTICACIÓN

function vincularOperador() { 
    let u = limpiarStr(document.getElementById("op_unidad").value); 
    let n = limpiarStr(document.getElementById("op_nombre").value); 
    if(u && n) { 
        db.ref(`operadores/${u}`).set(n); 
        document.getElementById("op_unidad").value = ""; 
        document.getElementById("op_nombre").value = ""; 
        mostrarNotificacion("Operador vinculado con éxito.");
    } 
}

function crearCliente() { 
    let nom = limpiarStr(document.getElementById("cli_nombre").value); 
    let fileInput = document.getElementById("cli_logo_file"); 
    if(!nom) return; 
    
    if (fileInput && fileInput.files && fileInput.files[0]) { 
        let reader = new FileReader(); 
        reader.onload = function(e) { 
            db.ref('clientes').push({nombre: nom, logo: e.target.result}); 
            document.getElementById("cli_nombre").value = ""; 
            fileInput.value = ""; 
            mostrarNotificacion("Cliente creado exitosamente.");
        }; 
        reader.readAsDataURL(fileInput.files[0]); 
    } else { 
        db.ref('clientes').push({nombre: nom, logo: ""}); 
        document.getElementById("cli_nombre").value = ""; 
        if(fileInput) fileInput.value = ""; 
        mostrarNotificacion("Cliente creado exitosamente.");
    } 
}

function crearSubcliente() { 
    db.ref(`clientes/${document.getElementById("sub_clientePadre").value}/subclientes`).push({nombre: limpiarStr(document.getElementById("sub_nombre").value)}); 
    document.getElementById("sub_nombre").value = ""; 
    mostrarNotificacion("Subcliente creado.");
}

// --- NUEVA FUNCIÓN: RESETEO DE CONTRASEÑA ---
window.resetearPasswordUsuario = function(userId) {
    // Verificamos permisos de administrador antes de actuar
    if (!currentUser || currentUser.rol !== "admin") {
        return alert("Permiso denegado. Solo administradores pueden realizar esta acción.");
    }

    let nuevaPass = prompt(`Introduce la nueva contraseña para el usuario [${userId}]:`);
    
    // Validación básica de longitud
    if (nuevaPass && nuevaPass.trim().length >= 4) {
        db.ref(`sistema/usuarios/${userId}`).update({
            pass: nuevaPass.trim()
        }).then(() => {
            mostrarNotificacion(`✅ Contraseña de ${userId} actualizada con éxito.`);
            actualizarListasAdmin(); // Refresca la lista en el modal
        }).catch(err => {
            alert("Error al actualizar en Firebase: " + err.message);
        });
    } else if (nuevaPass !== null) {
        alert("La contraseña es demasiado corta (mínimo 4 caracteres).");
    }
};

function crearUsuario() { 
    let id = document.getElementById("usr_id").value.trim().toLowerCase();
    let nom = document.getElementById("usr_nom").value.trim();
    let pass = document.getElementById("usr_pass").value.trim(); 
    if(id && nom && pass) { 
        db.ref(`sistema/usuarios/${id}`).set({nom: nom, pass: pass, rol: "monitor"}); 
        document.getElementById("usr_id").value=""; 
        document.getElementById("usr_nom").value=""; 
        document.getElementById("usr_pass").value=""; 
        mostrarNotificacion("Usuario Monitorista creado.");
    } 
}

// --- ACTUALIZACIÓN DE LA LISTA DE USUARIOS EN EL MODAL ---
function actualizarListasAdmin() { 
    let s = document.getElementById("sub_clientePadre"); 
    s.innerHTML = Object.keys(dataClientes).map(k => `<option value="${k}">${dataClientes[k].nombre}</option>`).join(''); 
    
    document.getElementById("listaClientesAdmin").innerHTML = Object.keys(dataClientes).map(k => { 
        let c = dataClientes[k]; 
        let logoText = c.logo ? `<i class="fa-solid fa-image text-success ms-1" title="Logo"></i>` : ''; 
        let safeNom = (c.nombre || '').replace(/'/g, "\\'"); 
        return `<li class="list-group-item d-flex justify-content-between align-items-center p-1 fs-8"><span class="text-truncate" style="max-width:60%;">${c.nombre} ${logoText}</span><div class="text-nowrap"><i class="fa-solid fa-pencil text-primary cp me-2" onclick="let n=prompt('Editar:', '${safeNom}'); if(n){ db.ref('clientes/${k}').update({nombre: limpiarStr(n)}); }"></i><i class="fa-solid fa-trash text-danger cp" onclick="if(confirm('¿Borrar Cliente?')) db.ref('clientes/${k}').remove()"></i></div></li>`; 
    }).join(''); 
    
    let subHtml = ""; 
    Object.keys(dataClientes).forEach(cId => {
        if(dataClientes[cId].subclientes) { 
            Object.keys(dataClientes[cId].subclientes).forEach(sId => { 
                subHtml += `<li class="list-group-item d-flex justify-content-between p-1 fs-8"><b>${dataClientes[cId].nombre}</b> - ${dataClientes[cId].subclientes[sId].nombre} <i class="fa-solid fa-trash text-danger cp" onclick="if(confirm('¿Borrar?')) db.ref('clientes/${cId}/subclientes/${sId}').remove()"></i></li>`; 
            }); 
        } 
    }); 
    document.getElementById("listaSubclientesAdmin").innerHTML = subHtml; 
    
    // PARTE MODIFICADA: Lista de Monitoristas con botón de Reset
    db.ref('sistema/usuarios').once('value', snap => { 
        let usrs = snap.val() || {}; 
        document.getElementById("listaUsuariosAdmin").innerHTML = Object.keys(usrs).map(k => {
            if (k === 'admin') {
                return `<li class="list-group-item p-1 fs-8"><b>admin</b> (Maestro)</li>`;
            } else {
                return `
                <li class="list-group-item d-flex justify-content-between align-items-center p-1 fs-8">
                    <div class="text-truncate" style="max-width: 70%;">
                        <b>${k}</b> <span class="ps-1">${usrs[k].nom}</span>
                    </div>
                    <div class="text-nowrap">
                        <i class="fa-solid fa-key text-warning cp me-2" title="Resetear Contraseña" onclick="resetearPasswordUsuario('${k}')"></i>
                        <i class="fa-solid fa-trash text-danger cp" title="Borrar" onclick="if(confirm('¿Borrar?')) db.ref('sistema/usuarios/${k}').remove()"></i>
                    </div>
                </li>`;
            }
        }).join(''); 
    }); 
}

function agregarToken() { 
    db.ref('sistema/tokens').push({
        nombre: limpiarStr(document.getElementById("tk_nom").value), 
        token: document.getElementById("tk_val").value, 
        url: document.getElementById("tk_url").value
    }); 
    document.getElementById("tk_nom").value=""; 
    document.getElementById("tk_val").value=""; 
    mostrarNotificacion("Nuevo Token añadido.");
}

function actualizarListaTokensAdmin(tks) { 
    const lista = document.getElementById("listaStatusTokens"); 
    if(lista) { 
        lista.innerHTML = Object.keys(tks || {}).map(id => `<li class="list-group-item d-flex justify-content-between p-1 fs-8"><b>${tks[id].nombre}</b> <i class="fa-solid fa-trash text-danger cp" onclick="if(confirm('¿Borrar Token?')) { db.ref('sistema/tokens/${id}').remove().then(()=>location.reload()); }"></i></li>`).join(''); 
    } 
}

window.onload = function () {
    aplicarAnchosGuardados(); 
    inicializarMenuColumnas();
    
    db.ref('clientes').on('value', s => { 
        dataClientes = s.val() || {}; 
        actualizarListasAdmin(); 
        renderizarBitacora(); 
    });
    
    db.ref('viajes_activos').on('value', s => { 
        viajesActivos = s.val() || {}; 
        renderizarBitacora(); 
        if(mapVisible) actualizarMarcadoresMapa(); 
    });
    
    db.ref('sistema/tokens').on('value', s => { 
        let tks = s.val() || {}; 
        configSistema.tokens = Object.values(tks); 
        actualizarListaTokensAdmin(tks); 
        if(currentUser && !motorArrancado) arranqueMotor(); 
    });
    
    document.getElementById("logPass").addEventListener("keyup", e => e.key === "Enter" && autenticarUsuario());
    
    let sU = localStorage.getItem("tms_user");
    let sP = localStorage.getItem("tms_pass"); 
    if(sU && sP) autenticarUsuario(sU, sP);
    
    // Aceleramos la búsqueda de 1.1s a 0.4s ya que Wialon aguanta más carga
    setInterval(procesarFilaDirecciones, 400);
};

function autenticarUsuario(aU, aP) {
    const u = aU || document.getElementById("logUser").value.trim(); 
    const p = aP || document.getElementById("logPass").value.trim(); 
    if(!u || !p) return;
    
    document.getElementById("status").innerText = "Conectando..."; 
    document.getElementById("status").className = "mt-3 small fw-bold text-primary";
    
    db.ref(`sistema/usuarios/${u}`).once('value').then(s => { 
        let user = s.val(); 
        if(user && user.pass === p) { 
            currentUser = user; 
            localStorage.setItem("tms_user", u); 
            localStorage.setItem("tms_pass", p); 
            document.getElementById("loginOverlay").style.display = "none"; 
            document.getElementById("dashboard").style.display = "flex"; 
            document.getElementById("lblUsuarioActivo").innerHTML = "<i class='fa-solid fa-user-shield me-1'></i> Monitor: " + currentUser.nom; 
            if(currentUser.rol === "admin") document.getElementById("btnAdminMenu").style.display = "block"; 
            if(!motorArrancado) arranqueMotor(); 
        } else { 
            document.getElementById("status").innerText = "Credenciales Incorrectas"; 
            document.getElementById("status").className = "mt-3 small fw-bold text-danger"; 
        } 
    }).catch(err => { 
        document.getElementById("status").innerText = "Error de red."; 
        document.getElementById("status").className = "mt-3 small fw-bold text-danger"; 
    });
}

function peticionWialon(url, svc, params, sid=null) { 
    return new Promise(resolve => { 
        let script = document.createElement("script"); 
        let cb = "wialon_cb_" + Date.now() + Math.floor(Math.random()*1000); 
        let timeout = setTimeout(() => { delete window[cb]; script.remove(); resolve(null); }, 8000); 
        
        window[cb] = d => { 
            clearTimeout(timeout); 
            delete window[cb]; 
            script.remove(); 
            resolve(d); 
        }; 
        
        script.onerror = () => { 
            clearTimeout(timeout); 
            delete window[cb]; 
            script.remove(); 
            resolve(null); 
        }; 
        
        script.src = `${url.replace(/\/$/, '')}/wialon/ajax.html?svc=${svc}&params=${encodeURIComponent(JSON.stringify(params))}&callback=${cb}${sid?'&sid='+sid:''}`; 
        document.head.appendChild(script); 
    }); 
}

async function arranqueMotor() { 
    if(pollingInterval) clearInterval(pollingInterval); 
    motorArrancado = true; 
    await sincronizarFlotas(); 
    pollingInterval = setInterval(sincronizarFlotas, 20000); 
}

function renderStatusTokens() { 
    const lista = document.getElementById("listaStatusTokens"); 
    let html = ""; 
    for(let tk in estadoTokens) { 
        let stat = estadoTokens[tk]; 
        let badge = stat.status === 'OK' ? '<span class="badge bg-success shadow-sm">ONLINE</span>' : '<span class="badge bg-danger shadow-sm">OFFLINE</span>'; 
        html += `<li class="list-group-item d-flex justify-content-between align-items-center p-2"><div class="fw-bold" style="font-size:0.8rem;">${tk}</div> <div><span class="badge bg-secondary me-2 shadow-sm">${stat.count} Unidades</span> ${badge}</div></li>`; 
    } 
    lista.innerHTML = html || '<li class="list-group-item text-center">No hay tokens</li>'; 
}

async function sincronizarFlotas() {
    if(isSyncingFlotas) return; 
    isSyncingFlotas = true;
    
    try { 
        let indMenu = document.getElementById("menuSyncIndicator"); 
        if(indMenu) indMenu.innerHTML = `<i class="fa-solid fa-satellite-dish text-warning"></i> Sincronizando...`; 
        
        estadoTokens = {}; 
        let tempUnits = {}; 
        let tempGeo = []; 
        let tempChoferes = {}; 
        let listUni = new Set(); 
        let conexionesExitosas = 0; 
        
        let promesas = configSistema.tokens.map(async (tk) => { 
            try { 
                if(!tk.url || !tk.token) return; 
                
                if(!activeSIDs[tk.token]) { 
                    let l = await peticionWialon(tk.url, "token/login", {token: tk.token}); 
                    if(l && l.eid) activeSIDs[tk.token] = { sid: l.eid }; 
                } 
                
                let auth = activeSIDs[tk.token]; 
                if(!auth || !auth.sid) { 
                    estadoTokens[tk.nombre] = { status: 'ERR', count: 0 }; 
                    return; 
                } 
                
                let autoLoginUrl = `${tk.url.includes("hst-api") ? "https://hosting.wialon.com" : tk.url}/login.html?token=${tk.token}`; 
                
                let reqR = await peticionWialon(tk.url, "core/search_items", { spec: {itemsType: "avl_resource", propName: "sys_name", propValueMask: "*", sortType: "sys_name"}, force: 1, flags: 1 + 256 + 4096, from: 0, to: 4294967295 }, auth.sid); 
                let diccChoferes = {}; 
                let diccZonasReq = {}; 
                let diccZonasNombres = {}; 
                
                if(reqR && reqR.items) { 
                    reqR.items.forEach(r => { 
                        let rId = r.id; 
                        diccZonasReq[rId] = []; 
                        diccZonasNombres[rId] = {}; 
                        
                        if(r.zl) { 
                            Object.values(r.zl).forEach(z => { 
                                diccZonasReq[rId].push(z.id); 
                                diccZonasNombres[rId][z.id] = z.n; 
                                tempGeo.push(z); 
                            }); 
                        } 
                        
                        if(r.drvrs || r.drv) { 
                            let drivers = r.drvrs || r.drv; 
                            Object.values(drivers).forEach(d => { 
                                let telStr = d.p ? String(d.p) : ""; 
                                let objC = { nombre: limpiarStr(d.n), tel: telStr, cod: d.c || "---", rid: rId, id: d.id };
                                
                                if(d.bu && d.bu > 0) { 
                                    diccChoferes[d.bu] = objC; 
                                } 
                                tempChoferes[objC.nombre] = objC;
                            }); 
                        } 
                    }); 
                } 
                
                let reqU = await peticionWialon(tk.url, "core/search_items", { spec: {itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name"}, force: 1, flags: 1 + 1024, from: 0, to: 4294967295 }, auth.sid); 
                
                if(reqU && reqU.items) { 
                    conexionesExitosas++; 
                    estadoTokens[tk.nombre] = { status: 'OK', count: reqU.items.length }; 
                    let uIds = reqU.items.map(u => u.id); 
                    let checkGeo = {}; 
                    
                    if(uIds.length > 0) {
                        checkGeo = await peticionWialon(tk.url, "resource/get_zones_by_unit", { spec: { zoneId: diccZonasReq, units: uIds, time: 0 } }, auth.sid); 
                    }
                    
                    reqU.items.forEach(u => { 
                        let n = limpiarStr(u.nm || "Desconocida"); 
                        let chofer = diccChoferes[u.id] || { nombre: "Sin asignar", tel: "", cod: "---", rid: null }; 
                        let miZona = null; 
                        let recursoDueño = chofer.rid ? chofer.rid : u.bact; 
                        
                        if (recursoDueño && checkGeo && checkGeo[recursoDueño]) { 
                            for (let zId in checkGeo[recursoDueño]) { 
                                if (checkGeo[recursoDueño][zId].includes(u.id)) { 
                                    miZona = diccZonasNombres[recursoDueño][zId]; 
                                    break; 
                                } 
                            } 
                        } else if (checkGeo) { 
                            for (let rId in checkGeo) { 
                                for (let zId in checkGeo[rId]) { 
                                    if (checkGeo[rId][zId].includes(u.id)) { 
                                        miZona = diccZonasNombres[rId][zId]; 
                                        break; 
                                    } 
                                } 
                                if (miZona) break; 
                            } 
                        } 
                        
                        tempUnits[u.id] = { id: u.id, name: n, pos: u.pos, loginUrl: autoLoginUrl, choferObj: chofer, zonaOficial: miZona, tkNombre: tk.nombre }; 
                        listUni.add(n); 
                    }); 
                } else { 
                    estadoTokens[tk.nombre] = { status: 'ERR', count: 0 }; 
                } 
            } catch(errTk) { 
                console.error("Token Falló:", tk.nombre); 
            } 
        }); 
        
        await Promise.all(promesas); 
        unidadesGlobales = tempUnits; 
        geocercasNativas = tempGeo; 
        diccChoferesGlobal = tempChoferes; 
        
        document.getElementById("listaUnidadesTotales").innerHTML = Array.from(listUni).map(n => `<option value="${n}">`).join(''); 
        document.getElementById("listaGeocercas").innerHTML = tempGeo.map(z => `<option value="${limpiarStr(z.n)}">`).join(''); 
        
        if(indMenu) { 
            if(conexionesExitosas > 0) indMenu.innerHTML = `<span class="badge bg-success shadow-sm rounded-pill py-1 px-2">${Object.keys(unidadesGlobales).length} Camiones Live</span>`; 
            else indMenu.innerHTML = `<span class="badge bg-danger shadow-sm rounded-pill py-1 px-2">Error GPS - Offline</span>`; 
        } 
        
        renderStatusTokens(); 
        inyectarGPSenTabla(); 
        
        if(mapVisible) { 
            actualizarMarcadoresMapa(); 
            pintarGeocercasEnMapa(); 
        } 
        
    } catch(errSync) { 
        console.error("Error Global:", errSync); 
    } finally { 
        isSyncingFlotas = false; 
    }
}















